/**
 * Customer confirmation by IVR call (Phase 5).
 *
 * After the agent signs a transaction, the IVR calls the customer, who TYPES
 * the amount they asked for (blind entry), hears it read back, and presses 1
 * or 2. BharatPoint polls the IVR for the outcome; the IVR never calls in.
 *
 * Every decision is applied in one DB transaction under the transaction row
 * lock, through a guarded `WHERE status = 'PENDING'` update, so a duplicate,
 * late or forged reply changes nothing. BharatPoint compares the keyed amount
 * itself (the IVR is evidence, not authority), and the Phase 1 trigger refuses
 * an approval whose keyed amount differs from the agent's.
 *
 * Fail closed: no IVR configured, an unsigned transaction, or a customer with
 * no extension means no confirmation, and so no path to the bank.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { config, ivrSettings } from '../config/env';
import type { Auth } from '../auth/middleware';
import { appendStep, canonicalJson, hasStage } from '../transactions/chain';
import { hashesMatch } from '../transactions/intent';
import { transition, type Actor, type TxRow } from '../transactions/service';
import * as ivr from './client';

const CUSTOMER: Actor = { kind: 'CUSTOMER', userId: null };
const SYSTEM: Actor = { kind: 'SYSTEM', userId: null };
const CALLS_PER_CUSTOMER_PER_10_MIN = 3;
const RING_TIMEOUT_SECONDS = 30;
const FINAL_ATTEMPT_STATES = ['COMPLETED', 'NO_ANSWER', 'FAILED'];

export const callIdFor = (authorizationId: string, dial: number) => `confirm:${authorizationId}:${dial}`;

export interface CallPlan {
  attemptId: string;
  payload: ivr.StartCallPayload;
}

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Binds the authorization to this exact transaction. Stored at creation and
 * recomputed from the transaction row before every decision.
 */
export function bindingHash(tx: TxRow, authorizationId: string, expiresAt: Date): string {
  const body = canonicalJson({
    txId: tx.id,
    txnType: tx.txn_type,
    amountMinor: Number(tx.amount_minor),
    customerId: tx.customer_id,
    accountLinkId: tx.account_link_id,
    bankId: tx.bank_id,
    agentId: tx.agent_id,
    intentHash: tx.intent_hash,
    authorizationId,
    expiresAt: epoch(expiresAt),
  });
  return crypto.createHash('sha256').update(body, 'utf8').digest('base64url');
}

/** What the IVR needs to place one dial. */
async function callPayload(c: PoolClient, tx: TxRow, authorizationId: string, dial: number): Promise<ivr.StartCallPayload> {
  const row = (
    await c.query<{ sip_extension: string; mode: 'BLIND_ENTRY' | 'READBACK'; preferred_language: string; agent_label: string }>(
      `SELECT cu.sip_extension, a.mode, cu.preferred_language,
              u.display_name || ', ' || ag.location_name AS agent_label
         FROM transaction_authorizations a
         JOIN customers cu ON cu.id = $2
         JOIN agents ag    ON ag.id = $3
         JOIN users u      ON u.id = ag.user_id
        WHERE a.id = $1`,
      [authorizationId, tx.customer_id, tx.agent_id]
    )
  ).rows[0]!;
  return {
    callId: callIdFor(authorizationId, dial),
    extension: row.sip_extension,
    mode: row.mode,
    txnType: tx.txn_type,
    amountRupees: Number(tx.amount_minor) / 100,
    agentLabel: row.agent_label,
    language: row.preferred_language,
    ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
  };
}

const insertAttempt = async (c: PoolClient, authorizationId: string, dial: number) =>
  (
    await c.query<{ id: string }>(
      `INSERT INTO call_attempts (authorization_id, dial, call_id) VALUES ($1, $2, $3) RETURNING id`,
      [authorizationId, dial, callIdFor(authorizationId, dial)]
    )
  ).rows[0]!.id;

/** The owning agent asks for the customer's confirmation call. */
export async function startConfirmation(auth: Auth, txId: string): Promise<void> {
  const settings = ivrSettings();
  if (!settings) fail('CONFIRMATION_UNAVAILABLE', { reason: 'no IVR is configured' });

  const plan = await withTransaction(async (c): Promise<CallPlan> => {
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0];
    if (!tx || tx.agent_id !== auth.agentId) fail('NOT_FOUND');
    if (tx.state !== 'CREATED') fail('STATE_CONFLICT', { state: tx.state });
    if (!(await hasStage(c, tx.id, 'AGENT_SIGNED'))) {
      fail('CONFIRMATION_UNAVAILABLE', { reason: 'the agent has not signed this transaction' });
    }
    const customer = (
      await c.query<{ sip_extension: string | null; confirmation_mode: 'BLIND_ENTRY' | 'READBACK' }>(
        `SELECT sip_extension, confirmation_mode FROM customers WHERE id = $1`,
        [tx.customer_id]
      )
    ).rows[0]!;
    if (!customer.sip_extension) fail('CONFIRMATION_UNAVAILABLE', { reason: 'the customer has no phone extension' });

    // An agent must not be able to call-bomb a customer by amending repeatedly.
    const recent = (
      await c.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM call_attempts ca
           JOIN transaction_authorizations a ON a.id = ca.authorization_id
           JOIN transactions t               ON t.id = a.transaction_id
          WHERE t.customer_id = $1 AND ca.created_at > NOW() - interval '10 minutes'`,
        [tx.customer_id]
      )
    ).rows[0]!.n;
    if (recent >= CALLS_PER_CUSTOMER_PER_10_MIN) fail('CONFIRMATION_RATE_LIMITED');

    await transition(c, tx.id, ['CREATED'], 'AWAITING_CUSTOMER', { kind: 'AGENT', userId: auth.userId });

    const authorizationId = crypto.randomUUID();
    const expiresAt = new Date(
      Math.min(Number(epoch(new Date())) + config.confirmationTtlSeconds, epoch(tx.expires_at)) * 1000
    );
    await c.query(
      `INSERT INTO transaction_authorizations (id, transaction_id, channel, mode, binding_hash, expires_at)
       VALUES ($1, $2, 'IVR', $3, $4, $5)`,
      [authorizationId, tx.id, customer.confirmation_mode, bindingHash(tx, authorizationId, expiresAt), expiresAt]
    );
    const attemptId = await insertAttempt(c, authorizationId, 1);
    await audit(c, 'CONFIRMATION_STARTED', {
      actorUserId: auth.userId,
      transactionId: tx.id,
      data: { authorizationId, mode: customer.confirmation_mode, channel: 'IVR' },
    });
    return { attemptId, payload: await callPayload(c, tx, authorizationId, 1) };
  });

  await placeCall(settings, plan);
}

/** Send one dial to the IVR and apply whatever it says. Never more than ivrMaxDials per confirmation. */
export async function placeCall(settings: ivr.IvrSettings, plan: CallPlan): Promise<void> {
  const outcome = await ivr.startCall(settings, plan.payload);
  if (outcome.kind === 'ANSWERED') {
    const next = await applyRecord(plan.attemptId, outcome);
    if (next) await placeCall(settings, next);
    return;
  }
  if (outcome.kind === 'REJECTED') await rejectReply(plan.attemptId, outcome.reason);
  // No clear answer: the sweeper asks again; a 404 then means "re-send the same callId".
  await query(`UPDATE call_attempts SET state = 'UNKNOWN' WHERE id = $1 AND state = 'SENDING'`, [plan.attemptId]);
}

export async function rejectReply(attemptId: string, reason: string): Promise<void> {
  await withTransaction(async (c) => {
    const tx = (
      await c.query<{ transaction_id: string }>(
        `SELECT a.transaction_id FROM call_attempts ca JOIN transaction_authorizations a ON a.id = ca.authorization_id
          WHERE ca.id = $1`,
        [attemptId]
      )
    ).rows[0];
    await audit(c, 'IVR_REPLY_REJECTED', { transactionId: tx?.transaction_id ?? null, data: { attemptId, reason } });
  });
}

const attemptStateOf = (status: ivr.IvrRecord['status']) =>
  status === 'RINGING' || status === 'IN_PROGRESS' ? 'IN_PROGRESS' : status;

/** Whole rupees from the IVR → paise, or null if absent or not a whole non-negative number. */
const keyedMinorOf = (r: ivr.IvrRecord) =>
  typeof r.keyedRupees === 'number' && Number.isSafeInteger(r.keyedRupees) && r.keyedRupees >= 0 ? r.keyedRupees * 100 : null;

/**
 * Apply one verified IVR reply. Returns a plan for a redial when the customer
 * did not answer and a dial is left; otherwise null.
 */
export async function applyRecord(
  attemptId: string,
  outcome: Extract<ivr.IvrOutcome, { kind: 'ANSWERED' }>
): Promise<CallPlan | null> {
  return withTransaction(async (c) => {
    const attempt = (
      await c.query<{ dial: number; call_id: string; authorization_id: string; transaction_id: string }>(
        `SELECT ca.dial, ca.call_id, ca.authorization_id, a.transaction_id
           FROM call_attempts ca JOIN transaction_authorizations a ON a.id = ca.authorization_id
          WHERE ca.id = $1`,
        [attemptId]
      )
    ).rows[0]!;
    // Lock order: transaction, then authorization (the same order as amend/cancel).
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [attempt.transaction_id])).rows[0]!;
    const authz = (
      await c.query<{ id: string; status: string; mode: 'BLIND_ENTRY' | 'READBACK'; binding_hash: string; expires_at: Date }>(
        `SELECT id, status, mode, binding_hash, expires_at FROM transaction_authorizations WHERE id = $1 FOR UPDATE`,
        [attempt.authorization_id]
      )
    ).rows[0]!;

    const r = outcome.record;
    const keyed = keyedMinorOf(r);

    // 1. Evidence, unless this attempt is already final (duplicate replies change nothing).
    await c.query(
      `UPDATE call_attempts SET state = $2, decision = $3, keyed_minor = $4, reply = $5
        WHERE id = $1 AND state <> ALL($6)`,
      [attemptId, attemptStateOf(r.status), r.decision, keyed, JSON.stringify({ record: r, signature: outcome.signature }), FINAL_ATTEMPT_STATES]
    );
    if (!['COMPLETED', 'NO_ANSWER', 'FAILED'].includes(r.status)) return null; // call still under way

    // 2. Too late, already decided, cancelled or superseded: no effect.
    if (authz.status !== 'PENDING' || tx.state !== 'AWAITING_CUSTOMER') return null;
    if (authz.expires_at.getTime() <= Date.now()) return null; // the expiry sweep closes it

    // 3. The authorization must still describe exactly this transaction.
    if (!hashesMatch(bindingHash(tx, authz.id, authz.expires_at), authz.binding_hash)) {
      fail('CHAIN_INVALID', { reason: 'authorization does not match the transaction' });
    }

    const decide = (status: string, keyedMinor: number | null) =>
      c.query(
        `UPDATE transaction_authorizations SET status = $2, customer_keyed_minor = $3, decided_at = NOW()
          WHERE id = $1 AND status = 'PENDING'`,
        [authz.id, status, keyedMinor]
      );
    const amountMinor = Number(tx.amount_minor);

    if (r.status === 'COMPLETED') {
      let decision = r.decision;
      // BharatPoint's own comparison wins over the IVR's.
      if (decision === 'ACCEPTED' && authz.mode === 'BLIND_ENTRY' && keyed !== amountMinor) {
        decision = keyed === null ? 'INVALID_INPUT' : 'MISMATCH';
      }
      if (decision === 'MISMATCH' && keyed === null) decision = 'INVALID_INPUT';

      if (decision === 'ACCEPTED') {
        const keyedMinor = authz.mode === 'BLIND_ENTRY' ? keyed : null;
        await decide('APPROVED', keyedMinor);
        await appendStep(c, tx.id, 'CUSTOMER_CONFIRMED', {
          channel: 'IVR',
          mode: authz.mode,
          callId: attempt.call_id,
          keyedMinor,
          ivrSignature: outcome.signature,
        });
        await transition(c, tx.id, ['AWAITING_CUSTOMER'], 'CUSTOMER_CONFIRMED', CUSTOMER, {
          detail: { callId: attempt.call_id },
        });
        await audit(c, 'CUSTOMER_CONFIRMED', { transactionId: tx.id, data: { callId: attempt.call_id, keyedMinor } });
      } else if (decision === 'MISMATCH') {
        await decide('MISMATCH', keyed);
        await transition(c, tx.id, ['AWAITING_CUSTOMER'], 'REJECTED', CUSTOMER, {
          failureCode: 'AMOUNT_MISMATCH',
          detail: { callId: attempt.call_id },
        });
        // Evidence against the agent: the customer asked for a different amount.
        await audit(c, 'AMOUNT_MISMATCH', {
          transactionId: tx.id,
          data: { agentId: tx.agent_id, expectedMinor: amountMinor, keyedMinor: keyed, callId: attempt.call_id },
        });
      } else if (decision === 'DECLINED') {
        await decide('REJECTED', null);
        await transition(c, tx.id, ['AWAITING_CUSTOMER'], 'REJECTED', CUSTOMER, {
          failureCode: 'CUSTOMER_DECLINED',
          detail: { callId: attempt.call_id },
        });
        await audit(c, 'CUSTOMER_DECLINED', { transactionId: tx.id, data: { callId: attempt.call_id } });
      } else {
        await decide('INVALID_INPUT', null);
        await transition(c, tx.id, ['AWAITING_CUSTOMER'], 'EXPIRED', CUSTOMER, {
          failureCode: 'INVALID_INPUT',
          detail: { callId: attempt.call_id },
        });
      }
      return null;
    }

    // NO_ANSWER or FAILED: one redial on the same authorization if time and dials remain.
    if (attempt.dial < config.ivrMaxDials && authz.expires_at.getTime() - Date.now() > RING_TIMEOUT_SECONDS * 1000) {
      const nextAttemptId = await insertAttempt(c, authz.id, attempt.dial + 1);
      return { attemptId: nextAttemptId, payload: await callPayload(c, tx, authz.id, attempt.dial + 1) };
    }
    await decide('NO_ANSWER', null);
    await transition(c, tx.id, ['AWAITING_CUSTOMER'], 'EXPIRED', SYSTEM, {
      failureCode: 'NO_ANSWER',
      detail: { callId: attempt.call_id },
    });
    return null;
  });
}

/** The payload for an existing attempt, to re-send the same callId after a lost request. */
export async function planForAttempt(attemptId: string): Promise<CallPlan> {
  return withTransaction(async (c) => {
    const row = (
      await c.query<{ authorization_id: string; dial: number; transaction_id: string }>(
        `SELECT ca.authorization_id, ca.dial, a.transaction_id
           FROM call_attempts ca JOIN transaction_authorizations a ON a.id = ca.authorization_id
          WHERE ca.id = $1`,
        [attemptId]
      )
    ).rows[0]!;
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1`, [row.transaction_id])).rows[0]!;
    return { attemptId, payload: await callPayload(c, tx, row.authorization_id, row.dial) };
  });
}

/** Close confirmations whose time ran out: the transaction expires, nothing is approved. */
export async function expireOverdue(): Promise<number> {
  const { rows } = await query<{ id: string; transaction_id: string }>(
    `SELECT id, transaction_id FROM transaction_authorizations
      WHERE status = 'PENDING' AND expires_at <= NOW() ORDER BY expires_at LIMIT 50`
  );
  for (const a of rows) {
    await withTransaction(async (c) => {
      const tx = (await c.query<{ state: string }>(`SELECT state FROM transactions WHERE id = $1 FOR UPDATE`, [a.transaction_id]))
        .rows[0]!;
      const { rowCount } = await c.query(
        `UPDATE transaction_authorizations SET status = 'EXPIRED', decided_at = NOW() WHERE id = $1 AND status = 'PENDING'`,
        [a.id]
      );
      if (!rowCount) return;
      if (tx.state === 'AWAITING_CUSTOMER') {
        await transition(c, a.transaction_id, ['AWAITING_CUSTOMER'], 'EXPIRED', SYSTEM, { failureCode: 'CONFIRMATION_EXPIRED' });
      }
      await audit(c, 'CONFIRMATION_EXPIRED', { transactionId: a.transaction_id, data: { authorizationId: a.id } });
    });
  }
  return rows.length;
}
