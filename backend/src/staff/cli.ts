/**
 * Local staff bootstrap, run on the server machine (trusted operator).
 * Creates a staff member and prints their one-time enrolment QR in the
 * terminal; the phone scans it on the "Enrol this phone" screen.
 *
 *   npm run staff:invite -- --role ADMIN --code AD-001 --name "Meena"
 *   npm run staff:invite -- --role AGENT --code AG-001 --name "Ravi" --location "Kothapalli" [--district X] [--state Y]
 *   npm run staff:invite -- --role BANK_OPERATOR --code BO-001 --name "Arjun" --bank DEMO-SBI
 *   npm run staff:invite -- --reinvite AG-001        (new invite for existing staff)
 */
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import pool, { withTransaction } from '../db/pool';
import { AppError } from '../api/errors';
import { createInvite, createStaff, parseNewStaff, type Invite } from './staff';

async function main() {
  const { values } = parseArgs({
    options: {
      role: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      location: { type: 'string' },
      district: { type: 'string' },
      state: { type: 'string' },
      bank: { type: 'string' },
      reinvite: { type: 'string' },
    },
  });

  let invite: Invite;
  let who: string;
  if (values.reinvite) {
    const user = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM users WHERE staff_code = $1 AND status = 'ACTIVE'`,
      [values.reinvite]
    );
    if (!user.rows[0]) throw new Error(`no active staff member with code ${values.reinvite}`);
    invite = await withTransaction((c) => createInvite(c, user.rows[0]!.id, null));
    who = `${user.rows[0].display_name} (${values.reinvite})`;
  } else {
    const input = parseNewStaff({
      role: values.role,
      staffCode: values.code,
      displayName: values.name,
      locationName: values.location,
      district: values.district,
      state: values.state,
      bankCode: values.bank,
    });
    const created = await withTransaction((c) => createStaff(c, input, null));
    invite = created.invite;
    who = `${created.user.displayName} (${created.user.staffCode}, ${created.user.role})`;
  }

  console.log(`\nEnrolment invite for ${who}`);
  console.log(`Scan this on the phone (Enrol this phone). Valid until ${invite.expiresAt.toLocaleString()}, once.\n`);
  console.log(await QRCode.toString(invite.qrPayload, { type: 'terminal', small: true }));
  console.log(`Or type this code: ${invite.token}\n`);
}

main()
  .catch((err) => {
    const detail = err instanceof AppError ? `${err.failureCode} ${JSON.stringify(err.details ?? {})}` : err.message;
    console.error(`[staff:invite] ${detail}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
