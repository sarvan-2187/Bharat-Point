/**
 * Audit writes go through the caller's DB client, so the audit row commits or
 * rolls back together with the change it records. PRISM logged best-effort,
 * after commit, and swallowed failures (audit F-04); here a failed audit write
 * fails the whole operation.
 */
import type { PoolClient } from 'pg';

export type AuditEvent =
  | 'STAFF_CREATED'
  | 'INVITE_CREATED'
  | 'DEVICE_ENROLLED'
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'SESSION_REVOKED'
  | 'STAFF_SUSPENDED'
  | 'DEVICES_RESET'
  | 'TRANSACTION_CREATED'
  | 'TRANSACTION_SIGNED'
  | 'TRANSACTION_AMENDED'
  | 'TRANSACTION_CANCELLED'
  | 'PROVIDER_FAULT_SET'
  | 'CONFIRMATION_STARTED'
  | 'CUSTOMER_CONFIRMED'
  | 'CUSTOMER_DECLINED'
  | 'AMOUNT_MISMATCH'
  | 'CONFIRMATION_EXPIRED'
  | 'IVR_REPLY_REJECTED'
  | 'CASH_HANDED_OVER'
  | 'CASH_HANDOVER_FAILED'
  | 'CASH_RETURNED'
  | 'CHAIN_REJECTED'
  | 'CUSTOMER_LOOKUP';

export async function audit(
  client: PoolClient,
  event: AuditEvent,
  opts: { actorUserId?: string | null; transactionId?: string | null; data?: Record<string, unknown> } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, transaction_id, event_type, event_data) VALUES ($1, $2, $3, $4)`,
    [opts.actorUserId ?? null, opts.transactionId ?? null, event, JSON.stringify(opts.data ?? {})]
  );
}
