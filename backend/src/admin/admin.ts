/**
 * Admin views and controls (Phase 8): every staff member with, for agents,
 * their limits, today's usage and ledger balances; agent limits; and alerts
 * derived from the live data (no alert table to fall out of date).
 */
import type { PoolClient } from 'pg';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { usedTodaySql } from '../limits/limits';

type Q = Pick<PoolClient, 'query'>;

const balanceSql = (kind: 'CASH_DRAWER' | 'FLOAT') =>
  `(SELECT COALESCE(SUM(p.amount_minor), 0) FROM ledger_postings p
     JOIN ledger_accounts la ON la.id = p.ledger_account_id
    WHERE la.owner_type = 'AGENT' AND la.owner_id = a.id AND la.kind = '${kind}')`;

export async function listStaff(q: Q) {
  const { rows } = await q.query(
    `SELECT u.id AS "userId", u.staff_code AS "staffCode", u.display_name AS "displayName", u.role, u.status,
            b.code AS "bankCode",
            (SELECT COUNT(*)::int FROM device_keys d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS "activeDevices",
            (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS "lastSignInAt",
            CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object(
              'agentId', a.id,
              'locationName', a.location_name,
              'perTxnLimitMinor', a.per_txn_limit_minor,
              'dailyLimitMinor', a.daily_limit_minor,
              'usedTodayMinor', ${usedTodaySql('a.id')},
              'drawerMinor', ${balanceSql('CASH_DRAWER')},
              'floatMinor', ${balanceSql('FLOAT')}
            ) END AS agent
       FROM users u
       LEFT JOIN agents a ON a.user_id = u.id
       LEFT JOIN banks b  ON b.id = u.bank_id
      WHERE u.role <> 'CUSTOMER'
      ORDER BY u.role, u.staff_code`
  );
  return rows;
}

/** Whole rupees, as paise; the database also checks per-transaction <= daily. */
function parseLimit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value % 100 !== 0 || value > 100_000_000) {
    fail('VALIDATION_FAILED', { field, reason: 'whole rupees, more than 0, at most ₹10,00,000' });
  }
  return value;
}

export async function setLimits(c: PoolClient, agentId: string, body: Record<string, unknown> | undefined, actor: string) {
  const perTxn = parseLimit(body?.perTxnLimitMinor, 'perTxnLimitMinor');
  const daily = parseLimit(body?.dailyLimitMinor, 'dailyLimitMinor');
  if (perTxn > daily) fail('VALIDATION_FAILED', { field: 'perTxnLimitMinor', reason: 'cannot exceed the daily limit' });
  const { rowCount } = await c.query(`UPDATE agents SET per_txn_limit_minor = $2, daily_limit_minor = $3 WHERE id = $1`, [agentId, perTxn, daily]);
  if (!rowCount) fail('NOT_FOUND');
  await audit(c, 'AGENT_LIMITS_SET', { actorUserId: actor, data: { agentId, perTxnLimitMinor: perTxn, dailyLimitMinor: daily } });
}

export interface Alert {
  kind: string;
  severity: 'HIGH' | 'MEDIUM';
  agentCode: string;
  transactionId: string | null;
  detail: string;
  since: string;
}

/**
 * What needs a person, most urgent first:
 *   CASH_NOT_HANDED_OVER    the bank debited a customer 15+ min ago and no cash was confirmed
 *   RECONCILIATION_REQUIRED the system could not settle it alone
 *   STUCK                   a lost bank answer or a refund still open after 5+ min
 *   AMOUNT_MISMATCHES       an agent's customers keyed a different amount twice or more today
 *   NEGATIVE_DRAWER         the ledger says the agent paid out more cash than they were given
 */
export async function alerts(q: Q): Promise<Alert[]> {
  const { rows } = await q.query<Alert>(
    `SELECT * FROM (
       SELECT 'CASH_NOT_HANDED_OVER' AS kind, 'HIGH' AS severity, ag.agent_code AS "agentCode", t.id AS "transactionId",
              'Customer debited ' || (t.amount_minor / 100) || ' rupees, no cash confirmed' AS detail, t.updated_at AS since
         FROM transactions t JOIN agents ag ON ag.id = t.agent_id
        WHERE t.state = 'PROVIDER_APPROVED' AND t.txn_type = 'CASH_OUT' AND t.updated_at < NOW() - interval '15 minutes'
       UNION ALL
       SELECT 'RECONCILIATION_REQUIRED', 'HIGH', ag.agent_code, t.id, COALESCE(t.failure_code, 'manual check needed'), t.updated_at
         FROM transactions t JOIN agents ag ON ag.id = t.agent_id
        WHERE t.state = 'RECONCILIATION_REQUIRED'
       UNION ALL
       SELECT 'STUCK', 'MEDIUM', ag.agent_code, t.id, t.state, t.updated_at
         FROM transactions t JOIN agents ag ON ag.id = t.agent_id
        WHERE t.state IN ('UNKNOWN_OUTCOME', 'CASH_NOT_DISBURSED', 'REVERSAL_PENDING') AND t.updated_at < NOW() - interval '5 minutes'
       UNION ALL
       SELECT 'AMOUNT_MISMATCHES', 'HIGH', ag.agent_code, NULL, COUNT(*) || ' amount mismatches today', MAX(t.updated_at)
         FROM transactions t JOIN agents ag ON ag.id = t.agent_id
        WHERE t.failure_code = 'AMOUNT_MISMATCH'
          AND t.created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
        GROUP BY ag.agent_code HAVING COUNT(*) >= 2
       UNION ALL
       SELECT 'NEGATIVE_DRAWER', 'MEDIUM', a.agent_code, NULL, 'Drawer at ' || (${balanceSql('CASH_DRAWER')} / 100) || ' rupees', NOW()
         FROM agents a
        WHERE ${balanceSql('CASH_DRAWER')} < 0
     ) x
     ORDER BY severity, since`
  );
  return rows;
}
