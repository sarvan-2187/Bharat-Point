/**
 * Replenishment with maker-checker (Phase 8). One admin requests cash for an
 * agent's drawer (or e-float); a different admin approves it, and only then
 * is the ledger journal posted, in the same DB transaction as the decision.
 * The database refuses a self-approval and a second decision as well
 * (0009_admin.sql), so a bug here cannot let one person move money alone.
 */
import type { PoolClient } from 'pg';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { optionalStr } from '../api/validate';
import { postReplenishment } from '../ledger/ledger';

type Q = Pick<PoolClient, 'query'>;

export async function requestReplenishment(c: PoolClient, agentId: string, body: Record<string, unknown> | undefined, actor: string) {
  const accountKind = body?.accountKind;
  if (accountKind !== 'CASH_DRAWER' && accountKind !== 'FLOAT') fail('VALIDATION_FAILED', { field: 'accountKind' });
  const amountMinor = body?.amountMinor;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor % 100 !== 0 || amountMinor > 100_000_000) {
    fail('VALIDATION_FAILED', { field: 'amountMinor', reason: 'whole rupees, more than 0, at most ₹10,00,000' });
  }
  const note = optionalStr(body, 'note', { max: 200 });
  const agent = await c.query(`SELECT 1 FROM agents WHERE id = $1`, [agentId]);
  if (!agent.rows[0]) fail('NOT_FOUND');
  const row = (
    await c.query<{ id: string }>(
      `INSERT INTO replenishments (agent_id, account_kind, amount_minor, note, requested_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [agentId, accountKind, amountMinor, note, actor]
    )
  ).rows[0]!;
  await audit(c, 'REPLENISHMENT_REQUESTED', { actorUserId: actor, data: { replenishmentId: row.id, agentId, accountKind, amountMinor } });
  return row.id;
}

export async function decideReplenishment(c: PoolClient, id: string, approve: boolean, actor: string): Promise<void> {
  const r = (
    await c.query<{ agent_id: string; account_kind: 'CASH_DRAWER' | 'FLOAT'; amount_minor: string; status: string; requested_by: string }>(
      `SELECT agent_id, account_kind, amount_minor, status, requested_by FROM replenishments WHERE id = $1 FOR UPDATE`,
      [id]
    )
  ).rows[0];
  if (!r) fail('NOT_FOUND');
  if (r.status !== 'PENDING') fail('STATE_CONFLICT', { status: r.status });
  if (r.requested_by === actor) fail('MAKER_CHECKER');

  const amountMinor = Number(r.amount_minor);
  const journalId = approve ? await postReplenishment(c, { id, agentId: r.agent_id, accountKind: r.account_kind, amountMinor }) : null;
  await c.query(`UPDATE replenishments SET status = $2, decided_by = $3, decided_at = NOW(), journal_id = $4 WHERE id = $1`, [
    id,
    approve ? 'APPROVED' : 'REJECTED',
    actor,
    journalId,
  ]);
  await audit(c, approve ? 'REPLENISHMENT_APPROVED' : 'REPLENISHMENT_REJECTED', {
    actorUserId: actor,
    data: { replenishmentId: id, agentId: r.agent_id, accountKind: r.account_kind, amountMinor },
  });
}

/** Pending first, then the most recent decisions. */
export async function listReplenishments(q: Q) {
  const { rows } = await q.query(
    `SELECT r.id, r.agent_id AS "agentId", ag.agent_code AS "agentCode", r.account_kind AS "accountKind",
            r.amount_minor::int AS "amountMinor", r.note, r.status, r.created_at AS "createdAt", r.decided_at AS "decidedAt",
            r.requested_by AS "requestedBy", rqs.staff_code AS "requestedByCode", dcd.staff_code AS "decidedByCode"
       FROM replenishments r
       JOIN agents ag      ON ag.id = r.agent_id
       JOIN users rqs      ON rqs.id = r.requested_by
       LEFT JOIN users dcd ON dcd.id = r.decided_by
      ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC
      LIMIT 50`
  );
  return rows;
}
