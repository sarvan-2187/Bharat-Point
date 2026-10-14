/**
 * Staff lifecycle, shared by the admin API (src/staff/routes.ts) and the local
 * CLI (src/staff/cli.ts). Every function runs on the caller's DB client so the
 * change and its audit row commit together.
 *
 * createdBy / actor is null only for the trusted local CLI.
 */
import type { PoolClient } from 'pg';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { optionalStr, str } from '../api/validate';
import type { Role } from '../auth/middleware';
import { inviteQrPayload, randomToken, sha256Hex } from '../auth/crypto';

export const INVITE_TTL_MINUTES = 30;

export interface NewStaff {
  role: Role;
  staffCode: string;
  displayName: string;
  bankCode: string | null; // BANK_OPERATOR only
  locationName: string | null; // AGENT only
  district: string | null;
  state: string | null;
}

export interface Invite {
  token: string; // shown once, never stored
  qrPayload: string;
  expiresAt: Date;
}

const ROLES: Role[] = ['AGENT', 'ADMIN', 'BANK_OPERATOR'];

/** Validate an untrusted body (API) or argument set (CLI) into a NewStaff. */
export function parseNewStaff(body: Record<string, unknown> | undefined): NewStaff {
  const role = str(body, 'role') as Role;
  if (!ROLES.includes(role)) fail('VALIDATION_FAILED', { field: 'role' });
  return {
    role,
    staffCode: str(body, 'staffCode', { max: 12, pattern: /^[A-Z]{2}-\d{3,6}$/ }),
    displayName: str(body, 'displayName', { max: 80 }),
    bankCode: role === 'BANK_OPERATOR' ? str(body, 'bankCode', { max: 20, pattern: /^[A-Z0-9-]+$/ }) : null,
    locationName: role === 'AGENT' ? str(body, 'locationName', { max: 80 }) : null,
    district: role === 'AGENT' ? optionalStr(body, 'district', { max: 80 }) : null,
    state: role === 'AGENT' ? optionalStr(body, 'state', { max: 80 }) : null,
  };
}

export async function createInvite(
  c: PoolClient,
  userId: string,
  createdBy: string | null,
  ttlMinutes = INVITE_TTL_MINUTES
): Promise<Invite> {
  const token = randomToken();
  const { rows } = await c.query<{ id: string; expires_at: Date }>(
    `INSERT INTO enrolment_invites (user_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(mins => $4)) RETURNING id, expires_at`,
    [userId, sha256Hex(token), createdBy, ttlMinutes]
  );
  const invite = rows[0]!;
  await audit(c, 'INVITE_CREATED', { actorUserId: createdBy, data: { userId, inviteId: invite.id } }); // never the token
  return { token, qrPayload: inviteQrPayload(token), expiresAt: invite.expires_at };
}

export async function createStaff(c: PoolClient, input: NewStaff, createdBy: string | null) {
  let bankId: string | null = null;
  if (input.bankCode) {
    const bank = await c.query<{ id: string }>(`SELECT id FROM banks WHERE code = $1`, [input.bankCode]);
    if (!bank.rows[0]) fail('VALIDATION_FAILED', { field: 'bankCode', reason: 'unknown bank' });
    bankId = bank.rows[0].id;
  }

  const user = (
    await c.query<{ id: string; staff_code: string; display_name: string; role: Role; bank_id: string | null }>(
      `INSERT INTO users (staff_code, display_name, role, bank_id) VALUES ($1, $2, $3, $4)
       RETURNING id, staff_code, display_name, role, bank_id`,
      [input.staffCode, input.displayName, input.role, bankId]
    )
  ).rows[0]!;

  let agentId: string | null = null;
  if (input.role === 'AGENT') {
    agentId = (
      await c.query<{ id: string }>(
        `INSERT INTO agents (user_id, agent_code, location_name, district, state)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user.id, input.staffCode, input.locationName, input.district, input.state]
      )
    ).rows[0]!.id;
  }

  await audit(c, 'STAFF_CREATED', {
    actorUserId: createdBy,
    data: { userId: user.id, staffCode: user.staff_code, role: user.role },
  });

  return {
    user: {
      id: user.id,
      staffCode: user.staff_code,
      displayName: user.display_name,
      role: user.role,
      bankId: user.bank_id,
      agentId,
    },
    invite: await createInvite(c, user.id, createdBy),
  };
}

/** Block the user and end every live session immediately. */
export async function suspendStaff(c: PoolClient, userId: string, actor: string | null): Promise<void> {
  const { rowCount } = await c.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);
  if (!rowCount) fail('NOT_FOUND');
  await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await audit(c, 'STAFF_SUSPENDED', { actorUserId: actor, data: { userId } });
}

/** Lift a suspension. Sessions ended by the suspension stay ended: the staff member signs in again. */
export async function reactivateStaff(c: PoolClient, userId: string, actor: string | null): Promise<void> {
  const { rowCount } = await c.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1 AND status = 'SUSPENDED'`, [userId]);
  if (!rowCount) fail('NOT_FOUND');
  await audit(c, 'STAFF_REACTIVATED', { actorUserId: actor, data: { userId } });
}

/** Lost or replaced phone: revoke every device key and session. A new invite re-enrols. */
export async function resetDevices(c: PoolClient, userId: string, actor: string | null): Promise<void> {
  const exists = await c.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  if (!exists.rows[0]) fail('NOT_FOUND');
  await c.query(`UPDATE device_keys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await audit(c, 'DEVICES_RESET', { actorUserId: actor, data: { userId } });
}
