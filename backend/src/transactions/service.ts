/**
 * Transaction core: create, sign, amend, cancel, and the one guarded way to
 * change a transaction's state.
 *
 * Every function runs on the caller's DB client, inside one DB transaction,
 * so the state change, its transaction_events row, its chain step and its
 * audit row commit or roll back together.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { uuid } from '../api/validate';
import { config } from '../config/env';
import type { Auth } from '../auth/middleware';
import { fromBase64url, intentMessage, verifyEd25519 } from '../auth/crypto';
import { appendStep, hasStage } from './chain';
import { hashesMatch, intentFromRow, intentHash, type LockedIntent } from './intent';

export type TxnType = 'CASH_IN' | 'CASH_OUT';
export type TxState =
  | 'CREATED'
  | 'AWAITING_CUSTOMER'
  | 'CUSTOMER_CONFIRMED'
  | 'PROVIDER_PENDING'
  | 'PROVIDER_APPROVED'
  | 'COMPLETED'
  | 'SUPERSEDED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'PROVIDER_DECLINED'
  | 'UNKNOWN_OUTCOME'
  | 'RECONCILIATION_REQUIRED'
  | 'CASH_NOT_DISBURSED'
  | 'REVERSAL_PENDING'
  | 'REVERSED'
  | 'CASH_RETURN_REQUIRED'
  | 'CASH_RETURNED';

export interface TxRow {
  id: string;
  txn_type: TxnType;
  agent_id: string;
  customer_id: string;
  account_link_id: string;
  bank_id: string;
  amount_minor: string; // BIGINT arrives as a string
  currency: string;
  intent_hash: string;
  nonce: string;
  created_at: Date;
  expires_at: Date;
  state: TxState;
  settlement_status: string;
  failure_code: string | null;
  superseded_by: string | null;
  updated_at: Date;
}

export type ActorKind = 'AGENT' | 'CUSTOMER' | 'ADMIN' | 'BANK_OPERATOR' | 'PROVIDER' | 'SYSTEM';
export interface Actor {
  kind: ActorKind;
  userId: string | null;
}

export interface NewTransaction {
  txnType: TxnType;
  customerId: string;
  accountLinkId: string;
  amountMinor: number;
}

/** Whole rupees, in paise. ₹200 is 20000. */
export function parseAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value % 100 !== 0) {
    fail('VALIDATION_FAILED', { field: 'amountMinor', reason: 'whole rupees, in paise' });
  }
  return value;
}

export function parseNewTransaction(body: Record<string, unknown> | undefined): NewTransaction {
  const txnType = body?.txnType;
  if (txnType !== 'CASH_IN' && txnType !== 'CASH_OUT') fail('VALIDATION_FAILED', { field: 'txnType' });
  return {
    txnType,
    customerId: uuid(body?.customerId, 'customerId'),
    accountLinkId: uuid(body?.accountLinkId, 'accountLinkId'),
    amountMinor: parseAmount(body?.amountMinor),
  };
}

const recordEvent = (c: PoolClient, txId: string, from: TxState | null, to: TxState, actor: Actor, detail = {}) =>
  c.query(
    `INSERT INTO transaction_events (transaction_id, from_state, to_state, actor_kind, actor_user_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [txId, from, to, actor.kind, actor.userId, JSON.stringify(detail)]
  );

/** Insert a locked transaction with its CREATED event and its chain root. */
async function insertTransaction(
  c: PoolClient,
  agentId: string,
  input: NewTransaction & { bankId: string },
  actor: Actor
): Promise<TxRow> {
  const createdAt = Math.floor(Date.now() / 1000);
  const intent: LockedIntent = {
    accountLinkId: input.accountLinkId,
    agentId,
    amountMinor: input.amountMinor,
    bankId: input.bankId,
    createdAt,
    customerId: input.customerId,
    expiresAt: createdAt + config.transactionTtlMinutes * 60,
    nonce: crypto.randomBytes(32).toString('hex'),
    txId: crypto.randomUUID(),
    txnType: input.txnType,
  };

  const tx = (
    await c.query<TxRow>(
      `INSERT INTO transactions
         (id, txn_type, agent_id, customer_id, account_link_id, bank_id, amount_minor, intent_hash, nonce,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), to_timestamp($11))
       RETURNING *`,
      [
        intent.txId,
        intent.txnType,
        intent.agentId,
        intent.customerId,
        intent.accountLinkId,
        intent.bankId,
        intent.amountMinor,
        intentHash(intent),
        intent.nonce,
        intent.createdAt,
        intent.expiresAt,
      ]
    )
  ).rows[0]!;

  await recordEvent(c, tx.id, null, 'CREATED', actor);
  await appendStep(c, tx.id, 'INTENT_LOCKED', {
    txnType: intent.txnType,
    amountMinor: intent.amountMinor,
    customerId: intent.customerId,
    accountLinkId: intent.accountLinkId,
    bankId: intent.bankId,
    agentId: intent.agentId,
    expiresAt: intent.expiresAt,
  });
  return tx;
}

export async function createTransaction(c: PoolClient, auth: Auth, input: NewTransaction): Promise<TxRow> {
  const link = (
    await c.query<{ bank_id: string }>(
      `SELECT bank_id FROM customer_account_links WHERE id = $1 AND customer_id = $2`,
      [input.accountLinkId, input.customerId]
    )
  ).rows[0];
  if (!link) fail('VALIDATION_FAILED', { field: 'accountLinkId', reason: 'not an account of this customer' });

  const tx = await insertTransaction(c, auth.agentId!, { ...input, bankId: link.bank_id }, { kind: 'AGENT', userId: auth.userId });
  await audit(c, 'TRANSACTION_CREATED', {
    actorUserId: auth.userId,
    transactionId: tx.id,
    data: { txnType: input.txnType, amountMinor: input.amountMinor },
  });
  return tx;
}

/** Lock a transaction the calling agent owns. Anyone else gets 404: existence is not revealed. */
async function lockOwned(c: PoolClient, auth: Auth, txId: string): Promise<TxRow> {
  const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0];
  if (!tx || tx.agent_id !== auth.agentId) fail('NOT_FOUND');
  return tx;
}

const isExpired = (tx: Pick<TxRow, 'expires_at'>) => tx.expires_at.getTime() <= Date.now();

/** States a transaction may only move forward into while it is still unexpired. */
const NEEDS_UNEXPIRED: TxState[] = ['AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED', 'PROVIDER_PENDING'];

/**
 * The one way to change a transaction's state: only from one of `from`, only
 * along a transition the database allows, with its event in the same DB
 * transaction. Returns the state it moved from.
 */
export async function transition(
  c: PoolClient,
  txId: string,
  from: TxState[],
  to: TxState,
  actor: Actor,
  opts: { detail?: Record<string, unknown>; failureCode?: string } = {}
): Promise<TxState> {
  const current = (
    await c.query<{ state: TxState; expires_at: Date }>(
      `SELECT state, expires_at FROM transactions WHERE id = $1 FOR UPDATE`,
      [txId]
    )
  ).rows[0];
  if (!current) fail('NOT_FOUND');
  if (!from.includes(current.state)) fail('STATE_CONFLICT', { state: current.state });
  if (NEEDS_UNEXPIRED.includes(to) && isExpired(current)) fail('INTENT_EXPIRED');

  await c.query(`UPDATE transactions SET state = $2, failure_code = COALESCE($3, failure_code) WHERE id = $1`, [
    txId,
    to,
    opts.failureCode ?? null,
  ]);
  await recordEvent(c, txId, current.state, to, actor, opts.detail);
  return current.state;
}

/** A replaced or cancelled transaction's open confirmation request can never be approved. */
const expirePendingConfirmation = (c: PoolClient, txId: string) =>
  c.query(
    `UPDATE transaction_authorizations SET status = 'EXPIRED', decided_at = NOW()
      WHERE transaction_id = $1 AND status = 'PENDING'`,
    [txId]
  );

/** The agent signs the intent hash with their phone key: "I entered exactly this". */
export async function signIntent(c: PoolClient, auth: Auth, txId: string, signatureB64: unknown): Promise<void> {
  const signature = fromBase64url(signatureB64);
  if (!signature) fail('VALIDATION_FAILED', { field: 'signature' });

  const tx = await lockOwned(c, auth, txId);
  if (tx.state !== 'CREATED') fail('STATE_CONFLICT', { state: tx.state });
  if (isExpired(tx)) fail('INTENT_EXPIRED');
  if (await hasStage(c, tx.id, 'AGENT_SIGNED')) fail('STATE_CONFLICT', { reason: 'already signed' });
  if (!hashesMatch(intentHash(intentFromRow(tx)), tx.intent_hash)) {
    fail('CHAIN_INVALID', { reason: 'transaction does not match its intent hash' });
  }

  // Verified against the key this session was opened with, not any key the agent has.
  const key = (
    await c.query<{ public_key: Buffer }>(`SELECT public_key FROM device_keys WHERE id = $1 AND revoked_at IS NULL`, [
      auth.deviceKeyId,
    ])
  ).rows[0];
  if (!key || !verifyEd25519(key.public_key, intentMessage(tx.intent_hash), signature)) {
    fail('AUTH_FAILED', { reason: 'signature does not match this phone' });
  }

  // The signature itself goes on the chain: durable evidence of what the agent entered.
  await appendStep(c, tx.id, 'AGENT_SIGNED', { deviceKeyId: auth.deviceKeyId, signature: signatureB64 as string });
  await audit(c, 'TRANSACTION_SIGNED', { actorUserId: auth.userId, transactionId: tx.id, data: { deviceKeyId: auth.deviceKeyId } });
}

/**
 * Change the amount: never an edit. In one DB transaction the old transaction
 * is locked, a new one with a new id, nonce and hash is created, and the old
 * one becomes SUPERSEDED. Allowed only before the customer has confirmed.
 */
export async function amendTransaction(c: PoolClient, auth: Auth, txId: string, amountMinor: number): Promise<TxRow> {
  const old = await lockOwned(c, auth, txId);
  if (old.state !== 'CREATED' && old.state !== 'AWAITING_CUSTOMER') {
    fail('STATE_CONFLICT', { state: old.state, reason: 'only an unconfirmed transaction can be amended' });
  }
  if (isExpired(old)) fail('INTENT_EXPIRED');
  if (amountMinor === Number(old.amount_minor)) fail('VALIDATION_FAILED', { field: 'amountMinor', reason: 'amount unchanged' });

  const actor: Actor = { kind: 'AGENT', userId: auth.userId };
  const replacement = await insertTransaction(
    c,
    old.agent_id,
    { txnType: old.txn_type, customerId: old.customer_id, accountLinkId: old.account_link_id, bankId: old.bank_id, amountMinor },
    actor
  );
  await c.query(`UPDATE transactions SET superseded_by = $2 WHERE id = $1`, [old.id, replacement.id]);
  await transition(c, old.id, ['CREATED', 'AWAITING_CUSTOMER'], 'SUPERSEDED', actor, {
    detail: { replacedBy: replacement.id },
  });
  await expirePendingConfirmation(c, old.id);
  await audit(c, 'TRANSACTION_AMENDED', {
    actorUserId: auth.userId,
    transactionId: old.id,
    data: { replacedBy: replacement.id, fromAmountMinor: Number(old.amount_minor), toAmountMinor: amountMinor },
  });
  return replacement;
}

export async function cancelTransaction(c: PoolClient, auth: Auth, txId: string): Promise<void> {
  const tx = await lockOwned(c, auth, txId);
  await transition(c, tx.id, ['CREATED', 'AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED'], 'CANCELLED', {
    kind: 'AGENT',
    userId: auth.userId,
  }, { failureCode: 'CANCELLED_BY_AGENT' });
  await expirePendingConfirmation(c, tx.id);
  await audit(c, 'TRANSACTION_CANCELLED', { actorUserId: auth.userId, transactionId: tx.id });
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface TxViewRow extends TxRow {
  customer_name: string;
  masked_label: string;
  agent_signed: boolean;
}

export async function loadView(q: Pick<PoolClient, 'query'>, txId: string): Promise<TxViewRow | null> {
  const { rows } = await q.query<TxViewRow>(
    `SELECT t.*, c.display_name AS customer_name, l.masked_label,
            EXISTS (SELECT 1 FROM authorization_steps s
                     WHERE s.transaction_id = t.id AND s.stage = 'AGENT_SIGNED') AS agent_signed
       FROM transactions t
       JOIN customers c              ON c.id = t.customer_id
       JOIN customer_account_links l ON l.id = t.account_link_id
      WHERE t.id = $1`,
    [txId]
  );
  return rows[0] ?? null;
}

/** Agents see their own; bank operators see their bank's; admins see all. */
export const canSee = (auth: Auth, tx: TxRow) =>
  auth.role === 'ADMIN' ||
  (auth.role === 'AGENT' && tx.agent_id === auth.agentId) ||
  (auth.role === 'BANK_OPERATOR' && tx.bank_id === auth.bankId);

export const present = (tx: TxViewRow) => ({
  id: tx.id,
  txnType: tx.txn_type,
  amountMinor: Number(tx.amount_minor),
  state: tx.state,
  failureCode: tx.failure_code,
  agentId: tx.agent_id,
  customerId: tx.customer_id,
  customerName: tx.customer_name,
  bankId: tx.bank_id,
  accountLabel: tx.masked_label,
  intentHash: tx.intent_hash,
  agentSigned: tx.agent_signed,
  createdAt: tx.created_at,
  expiresAt: tx.expires_at,
  supersededBy: tx.superseded_by,
});
