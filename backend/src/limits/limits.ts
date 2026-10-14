/**
 * Agent limits (Phase 8): a cap per transaction and per day (India time),
 * cash-in and cash-out together, set by an admin.
 *
 * Checked when the agent enters a transaction, for fast feedback, and again,
 * authoritatively, just before it is sent to the bank, with the agent row
 * locked so two dispatches cannot both squeeze under the daily cap. The
 * dispatch check is written to the authorization chain (LIMITS_CHECKED), and
 * the bank capability requires that stage. A suspended agent's transactions
 * are refused at the same point.
 */
import type { PoolClient } from 'pg';
import { fail } from '../api/errors';

/** Money the agent has moved today, or may have: sent to the bank and not undone. */
const COUNTED = ['PROVIDER_PENDING', 'PROVIDER_APPROVED', 'COMPLETED', 'UNKNOWN_OUTCOME', 'RECONCILIATION_REQUIRED', 'CASH_NOT_DISBURSED', 'REVERSAL_PENDING'];

/** A SQL expression for an agent's usage today; `agentRef` is a column or a $n placeholder, never user input. */
export const usedTodaySql = (agentRef: string) =>
  `(SELECT COALESCE(SUM(t.amount_minor), 0) FROM transactions t
     WHERE t.agent_id = ${agentRef}
       AND t.state IN (${COUNTED.map((s) => `'${s}'`).join(', ')})
       AND t.created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

export interface LimitCheck {
  perTxnLimitMinor: number;
  dailyLimitMinor: number;
  usedTodayMinor: number;
}

export async function checkLimits(c: PoolClient, agentId: string, amountMinor: number, opts: { lock?: boolean } = {}): Promise<LimitCheck> {
  const agent = (
    await c.query<{ per_txn: string; daily: string; status: string; used: string }>(
      `SELECT a.per_txn_limit_minor AS per_txn, a.daily_limit_minor AS daily, u.status, ${usedTodaySql('a.id')} AS used
         FROM agents a JOIN users u ON u.id = a.user_id
        WHERE a.id = $1 ${opts.lock ? 'FOR UPDATE OF a' : ''}`,
      [agentId]
    )
  ).rows[0]!;
  if (agent.status !== 'ACTIVE') fail('AGENT_SUSPENDED');
  const check = { perTxnLimitMinor: Number(agent.per_txn), dailyLimitMinor: Number(agent.daily), usedTodayMinor: Number(agent.used) };
  if (amountMinor > check.perTxnLimitMinor) fail('LIMIT_EXCEEDED', { limit: 'PER_TRANSACTION', limitMinor: check.perTxnLimitMinor });
  if (check.usedTodayMinor + amountMinor > check.dailyLimitMinor) {
    fail('LIMIT_EXCEEDED', { limit: 'DAILY', limitMinor: check.dailyLimitMinor, usedMinor: check.usedTodayMinor });
  }
  return check;
}
