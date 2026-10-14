/**
 * Open the admin console in a browser on this laptop.
 *
 *   npm run admin:console -- --staff AD-0001
 *
 * Run on the server machine by the trusted operator (like staff:invite). It
 * opens a normal admin session on that admin's already-enrolled phone key and
 * prints a link with the session token after the "#", which a browser never
 * sends to a server. Anyone holding the link is that admin until the session
 * expires or is revoked (suspending the admin or resetting devices revokes it),
 * so treat it like a password and do not paste it anywhere.
 */
import { parseArgs } from 'node:util';
import pool, { withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { config } from '../config/env';
import { randomToken, sha256Hex } from '../auth/crypto';

async function main() {
  const { values } = parseArgs({ options: { staff: { type: 'string' } } });
  if (!values.staff) throw new Error('--staff is required, e.g. --staff AD-0001');

  const admin = (
    await pool.query<{ user_id: string; key_id: string }>(
      `SELECT u.id AS user_id, d.id AS key_id
         FROM users u JOIN device_keys d ON d.user_id = u.id AND d.revoked_at IS NULL
        WHERE u.staff_code = $1 AND u.role = 'ADMIN' AND u.status = 'ACTIVE'
        ORDER BY d.created_at DESC LIMIT 1`,
      [values.staff]
    )
  ).rows[0];
  if (!admin) throw new Error(`no active admin ${values.staff} with an enrolled phone (enrol the admin first)`);

  const token = randomToken();
  await withTransaction(async (c) => {
    const s = (
      await c.query<{ id: string }>(
        `INSERT INTO sessions (token_hash, user_id, device_key_id, expires_at)
         VALUES ($1, $2, $3, NOW() + make_interval(hours => $4)) RETURNING id`,
        [sha256Hex(token), admin.user_id, admin.key_id, config.sessionTtlHours]
      )
    ).rows[0]!;
    await audit(c, 'LOGIN_SUCCEEDED', { actorUserId: admin.user_id, data: { via: 'console-link', sessionId: s.id } });
  });

  console.log(`\nAdmin console for ${values.staff} (valid ${config.sessionTtlHours} hours):\n\n  http://127.0.0.1:${config.port}/console/#${token}\n`);
}

main()
  .catch((err) => {
    console.error(`[admin:console] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
