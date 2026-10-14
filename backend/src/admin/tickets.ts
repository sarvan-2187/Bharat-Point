/**
 * Tickets (admin console): what a person must look at, and ticket-based calling.
 *
 * Tickets open themselves from facts already in the database (a customer's
 * "this wasn't me", a transaction the system could not settle, a wrong PIN),
 * so nothing has to remember to create one. An admin can ring the customer
 * from a ticket ("did you make this?", the IVR's read-back mode) and close the
 * ticket with a note. A callback answer is evidence for the admin; it never
 * approves or moves a payment.
 */
import type { PoolClient } from 'pg';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { ivrSettings } from '../config/env';
import * as ivr from '../confirmation/client';

type Q = Pick<PoolClient, 'query'>;

const MAX_CALLS_PER_TICKET = 3;
const OPEN_CALL = `('SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN')`;

export async function syncTickets(q: Q): Promise<void> {
  const open = (kind: string, from: string) =>
    q.query(`INSERT INTO tickets (kind, transaction_id) SELECT '${kind}', ${from} ON CONFLICT DO NOTHING`);
  await open('CUSTOMER_REPORT', 'transaction_id FROM transaction_disputes');
  await open('BANK_EXCEPTION', `id FROM transactions WHERE state = 'RECONCILIATION_REQUIRED'`);
  await open('WRONG_PIN', `id FROM transactions WHERE failure_code = 'WRONG_PIN'`);
}

export async function listTickets(q: Q) {
  const { rows } = await q.query(
    `SELECT k.id, k.kind, k.status, k.resolution, k.created_at AS "createdAt", k.resolved_at AS "resolvedAt",
            t.id AS "transactionId", t.txn_type AS "txnType", t.amount_minor::int AS "amountMinor",
            t.state, t.failure_code AS "failureCode",
            ag.agent_code AS "agentCode", cu.display_name AS "customerName",
            cu.sip_extension IS NOT NULL AS "canCall", d.note,
            (SELECT COUNT(*)::int FROM ticket_calls x WHERE x.ticket_id = k.id) AS "calls",
            (SELECT json_build_object('state', c.state, 'answer', c.answer, 'at', c.created_at)
               FROM ticket_calls c WHERE c.ticket_id = k.id ORDER BY c.created_at DESC LIMIT 1) AS "lastCall"
       FROM tickets k
       JOIN transactions t ON t.id = k.transaction_id
       JOIN agents ag      ON ag.id = t.agent_id
       JOIN customers cu   ON cu.id = t.customer_id
       LEFT JOIN transaction_disputes d ON d.transaction_id = t.id
      ORDER BY (k.status = 'OPEN') DESC, k.created_at DESC
      LIMIT 100`
  );
  return rows;
}

const stateOf = (status: ivr.IvrRecord['status']) => (status === 'RINGING' || status === 'IN_PROGRESS' ? 'IN_PROGRESS' : status);

/** Apply one verified IVR reply to a callback call. Final calls never change. */
async function applyCallRecord(q: Q, callId: string, r: ivr.IvrRecord): Promise<void> {
  const answer = r.status !== 'COMPLETED' ? null : r.decision === 'ACCEPTED' ? 'YES' : r.decision === 'DECLINED' ? 'NO' : null;
  const { rows } = await q.query<{ ticket_id: string }>(
    `UPDATE ticket_calls SET state = $2, answer = $3, updated_at = NOW()
      WHERE call_id = $1 AND state NOT IN ('COMPLETED', 'NO_ANSWER', 'FAILED') RETURNING ticket_id`,
    [callId, stateOf(r.status), answer]
  );
  if (rows[0] && answer) await audit(q as PoolClient, 'TICKET_CALL_ANSWERED', { data: { ticketId: rows[0].ticket_id, answer } });
}

/** Ask the IVR about every open callback call (the console polls, so this is what makes it live). */
export async function refreshTicketCalls(q: Q): Promise<void> {
  const settings = ivrSettings();
  if (!settings) return;
  const { rows } = await q.query<{ call_id: string; age: number }>(
    `SELECT call_id, EXTRACT(EPOCH FROM NOW() - created_at)::int AS age
       FROM ticket_calls WHERE state IN ${OPEN_CALL} ORDER BY created_at LIMIT 20`
  );
  for (const call of rows) {
    const outcome = await ivr.getDecision(settings, call.call_id);
    if (outcome.kind === 'ANSWERED') await applyCallRecord(q, call.call_id, outcome.record);
    // The IVR never heard of it and it is not new: give up rather than ring forever.
    else if (outcome.kind === 'NOT_FOUND' && call.age > 60) await q.query(`UPDATE ticket_calls SET state = 'FAILED' WHERE call_id = $1`, [call.call_id]);
  }
}

/** Ring the customer about this ticket's transaction. One call at a time, three per ticket. */
export async function callCustomer(c: PoolClient, ticketId: string, adminUserId: string): Promise<void> {
  const settings = ivrSettings();
  if (!settings) fail('CONFIRMATION_UNAVAILABLE', { reason: 'no IVR is configured' });

  const row = (
    await c.query<{
      status: string;
      txn_type: 'CASH_IN' | 'CASH_OUT';
      amount_minor: string;
      sip_extension: string | null;
      preferred_language: string;
      agent_label: string;
    }>(
      `SELECT k.status, t.txn_type, t.amount_minor, cu.sip_extension, cu.preferred_language,
              u.display_name || ', ' || ag.location_name AS agent_label
         FROM tickets k
         JOIN transactions t ON t.id = k.transaction_id
         JOIN customers cu   ON cu.id = t.customer_id
         JOIN agents ag      ON ag.id = t.agent_id
         JOIN users u        ON u.id = ag.user_id
        WHERE k.id = $1 FOR UPDATE OF k`,
      [ticketId]
    )
  ).rows[0];
  if (!row) fail('NOT_FOUND');
  if (row.status !== 'OPEN') fail('STATE_CONFLICT', { reason: 'ticket is resolved' });
  if (!row.sip_extension) fail('CONFIRMATION_UNAVAILABLE', { reason: 'the customer has no phone extension' });

  const calls = (await c.query<{ n: number; open: number }>(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE state IN ${OPEN_CALL})::int AS open FROM ticket_calls WHERE ticket_id = $1`,
    [ticketId]
  )).rows[0]!;
  if (calls.open > 0) fail('STATE_CONFLICT', { reason: 'a call is already in progress' });
  if (calls.n >= MAX_CALLS_PER_TICKET) fail('CONFIRMATION_RATE_LIMITED');

  const callId = `ticket:${ticketId}:${calls.n + 1}`;
  await c.query(`INSERT INTO ticket_calls (ticket_id, call_id, requested_by) VALUES ($1, $2, $3)`, [ticketId, callId, adminUserId]);
  await audit(c, 'TICKET_CALLED', { actorUserId: adminUserId, data: { ticketId, callId } });

  // After the DB commit would be cleaner, but the call is idempotent by callId: a retry rings no second time.
  const outcome = await ivr.startCall(settings, {
    callId,
    extension: row.sip_extension,
    mode: 'READBACK',
    purpose: 'VERIFY',
    txnType: row.txn_type,
    amountRupees: Number(row.amount_minor) / 100,
    pinRequired: false,
    agentLabel: row.agent_label,
    language: row.preferred_language,
    ringTimeoutSeconds: 30,
  });
  if (outcome.kind === 'ANSWERED') await applyCallRecord(c, callId, outcome.record);
  else await c.query(`UPDATE ticket_calls SET state = 'UNKNOWN' WHERE call_id = $1 AND state = 'SENDING'`, [callId]);
}

export async function resolveTicket(c: PoolClient, ticketId: string, body: Record<string, unknown> | undefined, adminUserId: string): Promise<void> {
  const note = typeof body?.resolution === 'string' ? body.resolution.trim() : '';
  if (!note || note.length > 300) fail('VALIDATION_FAILED', { field: 'resolution' });
  const { rowCount } = await c.query(
    `UPDATE tickets SET status = 'RESOLVED', resolution = $2, resolved_by = $3, resolved_at = NOW() WHERE id = $1 AND status = 'OPEN'`,
    [ticketId, note, adminUserId]
  );
  if (!rowCount) {
    const exists = (await c.query(`SELECT 1 FROM tickets WHERE id = $1`, [ticketId])).rows[0];
    fail(exists ? 'STATE_CONFLICT' : 'NOT_FOUND');
  }
  await audit(c, 'TICKET_RESOLVED', { actorUserId: adminUserId, data: { ticketId } });
}
