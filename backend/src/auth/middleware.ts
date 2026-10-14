/**
 * Who is calling, and may they do this?
 *
 * authenticate() turns a Bearer token into req.auth by looking the session up
 * in Postgres on every request. Role, suspension and revocation are therefore
 * read fresh each time: suspending an agent or revoking a lost phone takes
 * effect on their very next request, not when a token expires.
 *
 * requireRole() is the access check every protected route declares. Hiding a
 * screen in the app is not access control; this is.
 */
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/pool';
import { fail } from '../api/errors';
import { sha256Hex } from './crypto';

export type Role = 'AGENT' | 'ADMIN' | 'BANK_OPERATOR';

export interface Auth {
  sessionId: string;
  deviceKeyId: string; // the enrolled phone key this session was opened with
  userId: string;
  staffCode: string;
  displayName: string;
  role: Role;
  bankId: string | null; // BANK_OPERATOR only
  agentId: string | null; // AGENT only
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const { rows } = await query<Auth>(
      `SELECT s.id AS "sessionId", s.device_key_id AS "deviceKeyId", u.id AS "userId", u.staff_code AS "staffCode",
              u.display_name AS "displayName", u.role, u.bank_id AS "bankId", a.id AS "agentId"
         FROM sessions s
         JOIN users u       ON u.id = s.user_id
         JOIN device_keys d ON d.id = s.device_key_id
         LEFT JOIN agents a ON a.user_id = u.id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL AND s.expires_at > NOW()
          AND d.revoked_at IS NULL
          AND u.status = 'ACTIVE'`,
      [sha256Hex(header.slice(7).trim())]
    );
    if (rows[0]) req.auth = rows[0];
  }
  next();
}

/** Any signed-in staff member when called with no roles; otherwise only those roles. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) fail('AUTH_FAILED');
    if (roles.length > 0 && !roles.includes(req.auth.role)) fail('FORBIDDEN');
    next();
  };
