/**
 * Authorization chain and settlement capability.
 * Adapted from PRISM@680037b (modules/attestation/chain.ts, keys/keyManager.ts).
 *
 * Chain: one append-only row per completed stage of a transaction, in a fixed
 * order. Each row is hash-linked to the previous one (the first links to the
 * transaction's intent_hash) and MAC'd with a server key, so a row written
 * straight into Postgres by someone without the key does not verify.
 *
 * Capability: minted only from a complete, valid chain; consumed exactly once,
 * inside the same DB transaction as the money movement, after re-verifying the
 * chain and the intent hash under the row lock. "Was this authorized?" is then
 * answered from durable state at the moment money moves, not by trusting the
 * caller.
 *
 * PRISM supported several authorization attempts per transaction; BharatPoint
 * never re-attempts (a change means a new transaction), so attempt is always 1.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { config } from '../config/env';
import { fail } from '../api/errors';
import { hashesMatch, intentFromRow, intentHash } from './intent';

export type Stage =
  | 'INTENT_LOCKED'
  | 'AGENT_SIGNED'
  | 'CUSTOMER_CONFIRMED'
  | 'LIMITS_CHECKED'
  | 'RISK_APPROVED'
  | 'PROVIDER_AUTHORIZED'
  | 'CASH_HANDOVER_CONFIRMED';

/** Stages must appear in this order (gaps allowed, never backwards or repeated). */
export const STAGE_ORDER: Stage[] = [
  'INTENT_LOCKED',
  'AGENT_SIGNED',
  'CUSTOMER_CONFIRMED',
  'LIMITS_CHECKED',
  'RISK_APPROVED',
  'PROVIDER_AUTHORIZED',
  'CASH_HANDOVER_CONFIRMED',
];

// Purpose-separated keys from one root (HKDF with distinct info strings), so a
// chain-step MAC can never pass as a capability MAC.
const derive = (info: string) =>
  Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(config.attestationSecret, 'utf8'), 'bharatpoint/attestation/v1', info, 32)
  );
const STEP_KEY = derive('bharatpoint/chain-step/v1');
const CAPABILITY_KEY = derive('bharatpoint/capability/v1');
const hmac = (key: Buffer, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest('base64url');
const sha256 = (data: string) => crypto.createHash('sha256').update(data, 'utf8').digest('base64url');

/** Deterministic JSON: object keys sorted at every level. Payloads are small, server-built objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

const rowHashOf = (r: {
  transactionId: string;
  seq: number;
  stage: Stage;
  payload: unknown;
  prevHash: string;
  recordedAt: number;
}) => sha256(canonicalJson(r));

interface StepRow {
  seq: number;
  stage: Stage;
  payload: Record<string, unknown>;
  prev_hash: string;
  row_hash: string;
  mac: string;
  recorded_at: Date;
}

/**
 * Append one stage. Call inside a DB transaction that already holds the
 * transaction row lock (SELECT … FOR UPDATE), so appends are serialised.
 */
export async function appendStep(
  c: PoolClient,
  transactionId: string,
  stage: Stage,
  payload: Record<string, unknown>
): Promise<{ seq: number; rowHash: string }> {
  const tip = (
    await c.query<{ seq: number; stage: Stage; row_hash: string }>(
      `SELECT seq, stage, row_hash FROM authorization_steps
        WHERE transaction_id = $1 ORDER BY seq DESC LIMIT 1`,
      [transactionId]
    )
  ).rows[0];

  let seq: number;
  let prevHash: string;
  if (!tip) {
    if (stage !== 'INTENT_LOCKED') fail('CHAIN_INVALID', { reason: `first stage must be INTENT_LOCKED, got ${stage}` });
    const tx = (await c.query<{ intent_hash: string }>(`SELECT intent_hash FROM transactions WHERE id = $1`, [transactionId]))
      .rows[0];
    if (!tx) fail('NOT_FOUND');
    seq = 0;
    prevHash = tx.intent_hash; // rooted in the exact locked intent
  } else {
    if (STAGE_ORDER.indexOf(stage) <= STAGE_ORDER.indexOf(tip.stage)) {
      fail('CHAIN_INVALID', { reason: `${stage} cannot follow ${tip.stage}` });
    }
    seq = tip.seq + 1;
    prevHash = tip.row_hash;
  }

  const recordedAt = Math.floor(Date.now() / 1000);
  const rowHash = rowHashOf({ transactionId, seq, stage, payload, prevHash, recordedAt });
  await c.query(
    `INSERT INTO authorization_steps (transaction_id, attempt, seq, stage, payload, prev_hash, row_hash, mac, recorded_at)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
    [transactionId, seq, stage, JSON.stringify(payload), prevHash, rowHash, hmac(STEP_KEY, rowHash), recordedAt]
  );
  return { seq, rowHash };
}

export interface ChainVerification {
  ok: boolean;
  tipHash: string;
  stages: Stage[];
  reason?: string;
}

/** Recompute every link, hash and MAC from the intent hash forward. */
export async function verifyChain(c: PoolClient, transactionId: string, rootHash: string): Promise<ChainVerification> {
  const rows = (
    await c.query<StepRow>(
      `SELECT seq, stage, payload, prev_hash, row_hash, mac, recorded_at
         FROM authorization_steps WHERE transaction_id = $1 ORDER BY seq ASC`,
      [transactionId]
    )
  ).rows;
  const bad = (reason: string): ChainVerification => ({ ok: false, tipHash: '', stages: [], reason });
  if (rows.length === 0) return bad('no chain');

  let expectedPrev = rootHash;
  const stages: Stage[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.seq !== i) return bad(`seq gap at ${i}`);
    if (!hashesMatch(row.prev_hash, expectedPrev)) return bad(`broken link at seq ${row.seq}`);
    const recomputed = rowHashOf({
      transactionId,
      seq: row.seq,
      stage: row.stage,
      payload: row.payload,
      prevHash: row.prev_hash,
      recordedAt: Math.floor(row.recorded_at.getTime() / 1000),
    });
    if (!hashesMatch(recomputed, row.row_hash)) return bad(`row_hash mismatch at seq ${row.seq} (payload altered)`);
    if (!hashesMatch(hmac(STEP_KEY, row.row_hash), row.mac)) return bad(`MAC invalid at seq ${row.seq} (forged row)`);
    if (i > 0 && STAGE_ORDER.indexOf(row.stage) <= STAGE_ORDER.indexOf(rows[i - 1]!.stage)) {
      return bad(`stage order broken at seq ${row.seq}`);
    }
    expectedPrev = row.row_hash;
    stages.push(row.stage);
  }
  return { ok: true, tipHash: expectedPrev, stages };
}

export const hasStage = async (c: PoolClient, transactionId: string, stage: Stage) =>
  (await c.query(`SELECT 1 FROM authorization_steps WHERE transaction_id = $1 AND stage = $2`, [transactionId, stage]))
    .rows.length > 0;

interface CapabilityRow {
  id: string;
  transaction_id: string;
  intent_hash: string;
  chain_tip_hash: string;
  required_stages: Stage[];
  mac: string;
  expires_at: Date;
  consumed_at: Date | null;
}

const capabilityBody = (cap: Omit<CapabilityRow, 'id' | 'mac' | 'consumed_at'>) =>
  canonicalJson({
    typ: 'bharatpoint.capability.v1',
    transactionId: cap.transaction_id,
    intentHash: cap.intent_hash,
    chainTipHash: cap.chain_tip_hash,
    requiredStages: [...cap.required_stages].sort(),
    expiresAt: Math.floor(cap.expires_at.getTime() / 1000),
  });

/** Mint a capability from a complete, valid chain. */
export async function mintCapability(
  c: PoolClient,
  transactionId: string,
  rootHash: string,
  requiredStages: Stage[],
  ttlSeconds: number
): Promise<CapabilityRow> {
  const chain = await verifyChain(c, transactionId, rootHash);
  if (!chain.ok) fail('CHAIN_INVALID', { reason: chain.reason });
  const missing = requiredStages.filter((s) => !chain.stages.includes(s));
  if (missing.length > 0) fail('CHAIN_INCOMPLETE', { missing });

  const expiresAt = new Date((Math.floor(Date.now() / 1000) + ttlSeconds) * 1000);
  const draft = {
    transaction_id: transactionId,
    intent_hash: rootHash,
    chain_tip_hash: chain.tipHash,
    required_stages: requiredStages,
    expires_at: expiresAt,
  };
  return (
    await c.query<CapabilityRow>(
      `INSERT INTO settlement_capabilities
         (transaction_id, attempt, intent_hash, chain_tip_hash, required_stages, mac, expires_at)
       VALUES ($1, 1, $2, $3, $4, $5, $6) RETURNING *`,
      [transactionId, rootHash, chain.tipHash, requiredStages, hmac(CAPABILITY_KEY, capabilityBody(draft)), expiresAt]
    )
  ).rows[0]!;
}

/**
 * Consume a capability for this exact transaction. Call inside the DB
 * transaction that moves the money, after locking the transactions row.
 * Throws (and the caller rolls back) unless every check passes.
 */
export async function consumeCapability(
  c: PoolClient,
  capabilityId: string,
  tx: Parameters<typeof intentFromRow>[0] & { intent_hash: string }
): Promise<void> {
  const cap = (
    await c.query<CapabilityRow>(`SELECT * FROM settlement_capabilities WHERE id = $1 FOR UPDATE`, [capabilityId])
  ).rows[0];
  if (!cap) fail('CAPABILITY_INVALID', { reason: 'no such capability' });
  if (cap.transaction_id !== tx.id) fail('CAPABILITY_INVALID', { reason: 'capability is for a different transaction' });
  if (!hashesMatch(hmac(CAPABILITY_KEY, capabilityBody(cap)), cap.mac)) fail('CAPABILITY_INVALID', { reason: 'MAC invalid' });
  if (cap.consumed_at) fail('CAPABILITY_INVALID', { reason: 'already consumed' });
  if (cap.expires_at.getTime() <= Date.now()) fail('CAPABILITY_INVALID', { reason: 'expired' });

  // The row must still hash to what was authorized.
  const recomputed = intentHash(intentFromRow(tx));
  if (!hashesMatch(recomputed, tx.intent_hash) || !hashesMatch(recomputed, cap.intent_hash)) {
    fail('CAPABILITY_INVALID', { reason: 'transaction no longer matches its intent hash' });
  }

  const chain = await verifyChain(c, tx.id, tx.intent_hash);
  if (!chain.ok) fail('CHAIN_INVALID', { reason: chain.reason });
  if (chain.tipHash !== cap.chain_tip_hash) fail('CAPABILITY_INVALID', { reason: 'chain moved since the capability was minted' });
  const missing = cap.required_stages.filter((s) => !chain.stages.includes(s));
  if (missing.length > 0) fail('CHAIN_INCOMPLETE', { missing });

  const { rowCount } = await c.query(
    `UPDATE settlement_capabilities SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL`,
    [cap.id]
  );
  if (!rowCount) fail('CAPABILITY_INVALID', { reason: 'already consumed' });
}
