/**
 * Moving money at the bank, without ever doing it twice.
 *
 *  1. Gate, record the intent to send, and COMMIT before calling the bank:
 *     the authorization chain must show the agent's signature and the
 *     customer's confirmation (a one-time settlement capability is minted from
 *     it and consumed here), the transaction moves to PROVIDER_PENDING, and a
 *     provider_requests row is written in SENDING. A crash after this point
 *     leaves a durable "maybe sent" marker that recovery can find.
 *  2. Call the bank with a deterministic request id: debit:<txId> / credit:<txId>.
 *  3. Record what happened, with its ledger journal, in one DB transaction:
 *     cash-out APPROVED -> PROVIDER_APPROVED (cash still to be handed over);
 *     cash-in APPROVED  -> COMPLETED (the cash was taken before the call);
 *     DECLINED -> PROVIDER_DECLINED (cash-in: CASH_RETURN_REQUIRED);
 *     no clear answer -> UNKNOWN_OUTCOME.
 *
 * UNKNOWN_OUTCOME is resolved only by inquiry. If the bank has no record, the
 * SAME request id is sent again: the provider is idempotent on it. A request
 * with a new id is never sent. After too many unanswered inquiries a person
 * must reconcile (RECONCILIATION_REQUIRED). Reversals follow the same rules.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import { fail, type AppError } from '../api/errors';
import { audit } from '../db/audit';
import { config } from '../config/env';
import { appendStep, consumeCapability, mintCapability } from '../transactions/chain';
import { transition, type Actor, type TxRow, type TxState } from '../transactions/service';
import { postProviderApproval, postReversal } from '../ledger/ledger';
import * as client from './client';

const SYSTEM: Actor = { kind: 'SYSTEM', userId: null };
const PROVIDER: Actor = { kind: 'PROVIDER', userId: null };

export const requestIdFor = (kind: 'DEBIT' | 'CREDIT' | 'REVERSAL', txId: string) => `${kind.toLowerCase()}:${txId}`;

interface MoneyRequest {
  kind: 'DEBIT' | 'CREDIT';
  requestId: string;
  accountToken: string;
  amountMinor: number;
}

async function moneyRequestFor(c: PoolClient, txId: string): Promise<MoneyRequest> {
  const row = (
    await c.query<{ txn_type: 'CASH_IN' | 'CASH_OUT'; amount_minor: string; provider_token: string }>(
      `SELECT t.txn_type, t.amount_minor, l.provider_token
         FROM transactions t JOIN customer_account_links l ON l.id = t.account_link_id
        WHERE t.id = $1`,
      [txId]
    )
  ).rows[0];
  if (!row) fail('NOT_FOUND');
  // Cash-out takes money from the customer's account; cash-in puts it there.
  const kind = row.txn_type === 'CASH_OUT' ? 'DEBIT' : 'CREDIT';
  return { kind, requestId: requestIdFor(kind, txId), accountToken: row.provider_token, amountMinor: Number(row.amount_minor) };
}

const send = (r: MoneyRequest) =>
  client.submit(r.kind, { requestId: r.requestId, accountToken: r.accountToken, amountMinor: r.amountMinor });

/** Send the money request for a customer-confirmed transaction. Returns the resulting state. */
export async function sendToProvider(txId: string): Promise<TxState> {
  const request = await withTransaction(async (c) => {
    await transition(c, txId, ['CUSTOMER_CONFIRMED'], 'PROVIDER_PENDING', SYSTEM);
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1`, [txId])).rows[0]!;
    // Nothing reaches the bank without the agent's signature and the customer's confirmation on the chain.
    const cap = await mintCapability(c, txId, tx.intent_hash, ['INTENT_LOCKED', 'AGENT_SIGNED', 'CUSTOMER_CONFIRMED'], 60);
    await consumeCapability(c, cap.id, tx);
    const r = await moneyRequestFor(c, txId);
    await c.query(`INSERT INTO provider_requests (transaction_id, kind, request_id) VALUES ($1, $2, $3)`, [
      txId,
      r.kind,
      r.requestId,
    ]);
    return r;
  });
  return recordOutcome(txId, request.requestId, await send(request));
}

/** Send every customer-confirmed transaction to the bank (called by the sweeper). */
export async function dispatchConfirmed(): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM transactions WHERE state = 'CUSTOMER_CONFIRMED' ORDER BY updated_at LIMIT 20`
  );
  for (const { id } of rows) {
    try {
      await sendToProvider(id);
    } catch (err) {
      const code = (err as AppError).failureCode;
      if (code === 'CHAIN_INCOMPLETE' || code === 'CHAIN_INVALID' || code === 'CAPABILITY_INVALID') {
        // Only a bug or tampering produces a "confirmed" transaction whose chain does not
        // prove it. Nothing has moved: end it for good instead of retrying every sweep.
        await withTransaction(async (c) => {
          await transition(c, id, ['CUSTOMER_CONFIRMED'], 'REJECTED', SYSTEM, { failureCode: code });
          await audit(c, 'CHAIN_REJECTED', { transactionId: id, data: { failureCode: code } });
        });
      } else {
        console.error(`[provider] could not send ${id}:`, (err as Error).message);
      }
    }
  }
  return rows.length;
}

/** Apply the bank's answer, or its absence. Safe to call again for an already-resolved transaction. */
async function recordOutcome(txId: string, requestId: string, outcome: client.Outcome): Promise<TxState> {
  return withTransaction(async (c) => {
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0]!;
    if (tx.state !== 'PROVIDER_PENDING' && tx.state !== 'UNKNOWN_OUTCOME') return tx.state; // resolved elsewhere

    if (outcome.kind === 'ANSWERED') {
      const a = outcome.answer;
      await c.query(`UPDATE provider_requests SET state = $2, response = $3 WHERE request_id = $1`, [
        requestId,
        a.status,
        JSON.stringify(a),
      ]);
      if (a.status === 'APPROVED') {
        await appendStep(c, txId, 'PROVIDER_AUTHORIZED', { requestId, bankRef: a.bankRef, amountMinor: a.amountMinor });
        await transition(c, txId, ['PROVIDER_PENDING', 'UNKNOWN_OUTCOME'], 'PROVIDER_APPROVED', PROVIDER, {
          detail: { requestId, bankRef: a.bankRef },
        });
        await postProviderApproval(c, tx);
        if (tx.txn_type === 'CASH_IN') {
          await transition(c, txId, ['PROVIDER_APPROVED'], 'COMPLETED', PROVIDER, { detail: { requestId } });
          return 'COMPLETED';
        }
        return 'PROVIDER_APPROVED';
      }
      await transition(c, txId, ['PROVIDER_PENDING', 'UNKNOWN_OUTCOME'], 'PROVIDER_DECLINED', PROVIDER, {
        failureCode: a.reason ?? 'DECLINED',
        detail: { requestId, reason: a.reason },
      });
      if (tx.txn_type === 'CASH_IN') {
        // The agent already holds the customer's cash: it must go back.
        await transition(c, txId, ['PROVIDER_DECLINED'], 'CASH_RETURN_REQUIRED', SYSTEM);
        return 'CASH_RETURN_REQUIRED';
      }
      return 'PROVIDER_DECLINED';
    }

    // No clear answer: the money may or may not have moved. Never assume either way.
    const reason = outcome.kind === 'UNKNOWN' ? outcome.reason : 'NOT_FOUND';
    await c.query(`UPDATE provider_requests SET state = 'UNKNOWN', response = $2 WHERE request_id = $1`, [
      requestId,
      JSON.stringify({ reason }),
    ]);
    if (tx.state === 'PROVIDER_PENDING') {
      await transition(c, txId, ['PROVIDER_PENDING'], 'UNKNOWN_OUTCOME', SYSTEM, { detail: { requestId, reason } });
    }
    return 'UNKNOWN_OUTCOME';
  });
}

/**
 * Find out what happened to a transaction whose bank outcome is unknown (or
 * that a crash left PROVIDER_PENDING). Returns the resulting state.
 */
export async function resolveUnknown(txId: string): Promise<TxState> {
  const step = await withTransaction(async (c): Promise<{ done: TxState } | { request: MoneyRequest }> => {
    const tx = (await c.query<{ state: TxState }>(`SELECT state FROM transactions WHERE id = $1 FOR UPDATE`, [txId]))
      .rows[0];
    if (!tx) fail('NOT_FOUND');
    if (tx.state !== 'PROVIDER_PENDING' && tx.state !== 'UNKNOWN_OUTCOME') return { done: tx.state };

    const req = (
      await c.query<{ inquiry_count: number }>(
        `UPDATE provider_requests SET inquiry_count = inquiry_count + 1, last_inquiry_at = NOW()
          WHERE transaction_id = $1 AND kind IN ('DEBIT', 'CREDIT') RETURNING inquiry_count`,
        [txId]
      )
    ).rows[0];
    if (!req) fail('NOT_FOUND', { reason: 'no provider request recorded' });

    if (req.inquiry_count > config.providerMaxInquiries) {
      if (tx.state === 'PROVIDER_PENDING') await transition(c, txId, ['PROVIDER_PENDING'], 'UNKNOWN_OUTCOME', SYSTEM);
      await transition(c, txId, ['UNKNOWN_OUTCOME'], 'RECONCILIATION_REQUIRED', SYSTEM, {
        failureCode: 'PROVIDER_NO_ANSWER',
        detail: { inquiries: req.inquiry_count - 1 },
      });
      return { done: 'RECONCILIATION_REQUIRED' };
    }
    return { request: await moneyRequestFor(c, txId) };
  });
  if ('done' in step) return step.done;

  let outcome = await client.inquire(step.request.requestId);
  // The bank never received it: send the SAME request id again (idempotent at the bank).
  if (outcome.kind === 'NOT_FOUND') outcome = await send(step.request);
  return recordOutcome(txId, step.request.requestId, outcome);
}

/**
 * Reverse an approved cash-out whose cash was never handed over. The first
 * call records the reversal request; every later call re-sends the SAME
 * request id (idempotent at the bank, so it doubles as the status inquiry).
 * After too many unanswered attempts a person must reconcile.
 */
export async function sendReversal(txId: string): Promise<TxState> {
  const step = await withTransaction(async (c): Promise<{ done: TxState } | { requestId: string; originalRequestId: string }> => {
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0];
    if (!tx) fail('NOT_FOUND');
    if (tx.state !== 'REVERSAL_PENDING') return { done: tx.state };
    const requestId = requestIdFor('REVERSAL', txId);
    const existing = (
      await c.query<{ inquiry_count: number }>(
        `UPDATE provider_requests SET inquiry_count = inquiry_count + 1, last_inquiry_at = NOW()
          WHERE transaction_id = $1 AND kind = 'REVERSAL' RETURNING inquiry_count`,
        [txId]
      )
    ).rows[0];
    if (!existing) {
      await c.query(`INSERT INTO provider_requests (transaction_id, kind, request_id) VALUES ($1, 'REVERSAL', $2)`, [txId, requestId]);
    } else if (existing.inquiry_count > config.providerMaxInquiries) {
      await transition(c, txId, ['REVERSAL_PENDING'], 'RECONCILIATION_REQUIRED', SYSTEM, { failureCode: 'REVERSAL_NO_ANSWER' });
      return { done: 'RECONCILIATION_REQUIRED' };
    }
    return { requestId, originalRequestId: requestIdFor(tx.txn_type === 'CASH_OUT' ? 'DEBIT' : 'CREDIT', txId) };
  });
  if ('done' in step) return step.done;

  const outcome = await client.submit('REVERSAL', { requestId: step.requestId, originalRequestId: step.originalRequestId });
  return withTransaction(async (c) => {
    const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0]!;
    if (tx.state !== 'REVERSAL_PENDING') return tx.state;
    if (outcome.kind !== 'ANSWERED') {
      await c.query(`UPDATE provider_requests SET state = 'UNKNOWN' WHERE request_id = $1 AND state IN ('SENDING', 'UNKNOWN')`, [
        step.requestId,
      ]);
      return 'REVERSAL_PENDING'; // the sweeper tries again with the same id
    }
    const a = outcome.answer;
    await c.query(`UPDATE provider_requests SET state = $2, response = $3 WHERE request_id = $1`, [
      step.requestId,
      a.status,
      JSON.stringify(a),
    ]);
    if (a.status === 'APPROVED') {
      await postReversal(c, tx);
      await transition(c, txId, ['REVERSAL_PENDING'], 'REVERSED', PROVIDER, { detail: { requestId: step.requestId, bankRef: a.bankRef } });
      return 'REVERSED';
    }
    await transition(c, txId, ['REVERSAL_PENDING'], 'RECONCILIATION_REQUIRED', PROVIDER, {
      failureCode: 'REVERSAL_DECLINED',
      detail: { reason: a.reason },
    });
    return 'RECONCILIATION_REQUIRED';
  });
}
