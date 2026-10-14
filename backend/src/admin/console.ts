/**
 * What the admin console shows live: the newest payments with how far each has
 * got, the headline numbers, and one payment's full timeline. Read-only.
 */
import type { PoolClient } from 'pg';
import { fail } from '../api/errors';

type Q = Pick<PoolClient, 'query'>;

const TODAY = `date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
const IN_FLIGHT = `('CREATED', 'AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED', 'PROVIDER_PENDING', 'PROVIDER_APPROVED',
                    'UNKNOWN_OUTCOME', 'CASH_NOT_DISBURSED', 'REVERSAL_PENDING', 'CASH_RETURN_REQUIRED')`;

export async function live(q: Q) {
  const [{ rows: transactions }, { rows: [summary] }] = await Promise.all([
    q.query(
      `SELECT t.id, t.txn_type AS "txnType", t.amount_minor::int AS "amountMinor", t.state, t.failure_code AS "failureCode",
              t.created_at AS "createdAt", t.updated_at AS "updatedAt",
              ag.agent_code AS "agentCode", cu.display_name AS "customerName", b.code AS "bankCode",
              COALESCE((SELECT json_agg(s.stage ORDER BY s.seq) FROM authorization_steps s WHERE s.transaction_id = t.id), '[]') AS stages,
              (SELECT json_build_object('dial', ca.dial, 'state', ca.state)
                 FROM call_attempts ca JOIN transaction_authorizations a ON a.id = ca.authorization_id
                WHERE a.transaction_id = t.id ORDER BY ca.created_at DESC LIMIT 1) AS call,
              EXISTS (SELECT 1 FROM transaction_disputes d WHERE d.transaction_id = t.id) AS disputed,
              f.status AS "riskStatus", f.category AS "riskCategory", f.probability::float8 AS "riskProbability",
              f.review_status AS "riskReview"
         FROM transactions t
         JOIN agents ag    ON ag.id = t.agent_id
         JOIN customers cu ON cu.id = t.customer_id
         JOIN banks b      ON b.id = t.bank_id
         LEFT JOIN fraud_assessments f ON f.transaction_id = t.id
        ORDER BY t.created_at DESC
        LIMIT 60`
    ),
    q.query(
      `SELECT COUNT(*) FILTER (WHERE state IN ${IN_FLIGHT})::int AS "inFlight",
              COUNT(*) FILTER (WHERE state = 'COMPLETED' AND created_at >= ${TODAY})::int AS "completedToday",
              COALESCE(SUM(amount_minor) FILTER (WHERE state = 'COMPLETED' AND created_at >= ${TODAY}), 0)::bigint::float8 AS "volumeTodayMinor",
              COUNT(*) FILTER (WHERE state IN ('PROVIDER_DECLINED', 'REJECTED', 'RECONCILIATION_REQUIRED') AND created_at >= ${TODAY})::int AS "failedToday",
              (SELECT COUNT(*)::int FROM tickets WHERE status = 'OPEN') AS "openTickets",
              (SELECT COUNT(*)::int FROM fraud_assessments WHERE review_status = 'PENDING' AND category IN ('MEDIUM', 'HIGH')) AS "fraudFlagged",
              (SELECT COUNT(*)::int FROM call_attempts WHERE state IN ('SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN')) AS "callsActive"
         FROM transactions`
    ),
  ]);
  return { summary, transactions, at: new Date().toISOString() };
}

export async function timeline(q: Q, txId: string) {
  const tx = (await q.query(`SELECT id FROM transactions WHERE id = $1`, [txId])).rows[0];
  if (!tx) fail('NOT_FOUND');
  const [events, steps, calls] = await Promise.all([
    q.query(
      `SELECT from_state AS "from", to_state AS "to", actor_kind AS actor, detail, created_at AS at
         FROM transaction_events WHERE transaction_id = $1 ORDER BY created_at`,
      [txId]
    ),
    q.query(`SELECT stage, recorded_at AS at FROM authorization_steps WHERE transaction_id = $1 ORDER BY seq`, [txId]),
    q.query(
      `SELECT ca.dial, ca.state, ca.decision, ca.created_at AS at
         FROM call_attempts ca JOIN transaction_authorizations a ON a.id = ca.authorization_id
        WHERE a.transaction_id = $1 ORDER BY ca.created_at`,
      [txId]
    ),
  ]);
  return { events: events.rows, steps: steps.rows, calls: calls.rows };
}
