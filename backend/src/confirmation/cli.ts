/**
 * Real-phone rehearsal of the customer confirmation call, before the agent
 * screens exist. Run on the laptop with the IVR (Mac) up and the phone's
 * Linphone registered:
 *
 *   npm run ivr:try -- --amount 200 [--mode BLIND_ENTRY|READBACK] [--extension 6001]
 *
 * Needs IVR_URL and IVR_SHARED_SECRET in the repo-root .env. Seeds (once) a
 * demo agent AG-9001 and a synthetic customer on the extension, creates and
 * signs a CASH_OUT, starts the call, then prints each state until decided.
 * The backend's own sweeper does not need to be running: this polls itself.
 */
import crypto from 'crypto';
import { parseArgs } from 'node:util';
import pool, { withTransaction } from '../db/pool';
import { ivrSettings } from '../config/env';
import { intentMessage } from '../auth/crypto';
import type { Auth } from '../auth/middleware';
import { createStaff, parseNewStaff } from '../staff/staff';
import { createTransaction, signIntent } from '../transactions/service';
import { startConfirmation } from './service';
import { sweepConfirmationsOnce } from './sweeper';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The demo agent, with a fresh device key for this run (only the public half is stored, as from a phone). */
async function demoAgent() {
  let row = (
    await pool.query<{ id: string; display_name: string; agent_id: string }>(
      `SELECT u.id, u.display_name, a.id AS agent_id FROM users u JOIN agents a ON a.user_id = u.id WHERE u.staff_code = 'AG-9001'`
    )
  ).rows[0];
  if (!row) {
    const input = parseNewStaff({ role: 'AGENT', staffCode: 'AG-9001', displayName: 'IVR Demo Agent', locationName: 'Kothapalli' });
    const created = await withTransaction((c) => createStaff(c, input, null));
    row = { id: created.user.id, display_name: created.user.displayName, agent_id: created.user.agentId! };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const key = (
    await pool.query<{ id: string }>(
      `INSERT INTO device_keys (user_id, public_key, label) VALUES ($1, $2, 'ivr:try CLI') RETURNING id`,
      [row.id, Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')]
    )
  ).rows[0]!;
  const auth: Auth = {
    sessionId: '',
    deviceKeyId: key.id,
    userId: row.id,
    staffCode: 'AG-9001',
    displayName: row.display_name,
    role: 'AGENT',
    bankId: null,
    agentId: row.agent_id,
    customerId: null,
  };
  const sign = (intentHash: string) => crypto.sign(null, Buffer.from(intentMessage(intentHash), 'utf8'), privateKey).toString('base64url');
  return { auth, sign };
}

/** A synthetic customer whose "phone" is the SIP extension. */
async function demoCustomer(extension: string, mode: 'BLIND_ENTRY' | 'READBACK') {
  await pool.query(`INSERT INTO banks (code, display_name) VALUES ('DEMO-SBI', 'Demo State Bank') ON CONFLICT (code) DO NOTHING`);
  let customer = (await pool.query<{ id: string }>(`SELECT id FROM customers WHERE sip_extension = $1 ORDER BY created_at LIMIT 1`, [extension]))
    .rows[0];
  if (!customer) {
    customer = (
      await pool.query<{ id: string }>(
        `INSERT INTO customers (display_name, phone_enc, phone_lookup, sip_extension, is_synthetic)
         VALUES ($1, '\\x00', $2, $3, TRUE) RETURNING id`,
        [`Demo Customer ${extension}`, crypto.createHash('sha256').update(`ivr-try:${extension}`).digest('hex'), extension]
      )
    ).rows[0]!;
    await pool.query(
      `INSERT INTO customer_account_links (customer_id, bank_id, provider_token, masked_label)
       SELECT $1, id, $2, 'Demo SBI ••••' || $3 FROM banks WHERE code = 'DEMO-SBI'`,
      [customer.id, `ivr-try-${extension}`, extension]
    );
  }
  await pool.query(`UPDATE customers SET confirmation_mode = $2 WHERE id = $1`, [customer.id, mode]);
  const link = (await pool.query<{ id: string }>(`SELECT id FROM customer_account_links WHERE customer_id = $1 LIMIT 1`, [customer.id]))
    .rows[0]!;
  return { customerId: customer.id, accountLinkId: link.id };
}

async function main() {
  const { values } = parseArgs({
    options: { amount: { type: 'string' }, mode: { type: 'string' }, extension: { type: 'string' } },
  });
  const rupees = Number(values.amount);
  if (!Number.isSafeInteger(rupees) || rupees <= 0) throw new Error('--amount must be whole rupees, e.g. --amount 200');
  const mode = (values.mode ?? 'BLIND_ENTRY') as 'BLIND_ENTRY' | 'READBACK';
  if (mode !== 'BLIND_ENTRY' && mode !== 'READBACK') throw new Error('--mode must be BLIND_ENTRY or READBACK');
  const extension = values.extension ?? '6001';
  if (!ivrSettings()) throw new Error('set IVR_URL and IVR_SHARED_SECRET in the repo-root .env');

  const { auth, sign } = await demoAgent();
  const customer = await demoCustomer(extension, mode);
  const tx = await withTransaction((c) =>
    createTransaction(c, auth, { txnType: 'CASH_OUT', amountMinor: rupees * 100, ...customer })
  );
  await withTransaction((c) => signIntent(c, auth, tx.id, sign(tx.intent_hash)));
  console.log(`Transaction ${tx.id}: CASH_OUT ₹${rupees}, signed by ${auth.staffCode}. Calling extension ${extension} (${mode})…`);

  await startConfirmation(auth, tx.id);
  const deadline = Date.now() + 5 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await sweepConfirmationsOnce();
    const s = (
      await pool.query<{ state: string; failure_code: string | null; status: string | null; call: string | null; dial: number | null }>(
        `SELECT t.state, t.failure_code, a.status, ca.state AS call, ca.dial
           FROM transactions t
           LEFT JOIN LATERAL (SELECT id, status FROM transaction_authorizations
                               WHERE transaction_id = t.id ORDER BY created_at DESC LIMIT 1) a ON TRUE
           LEFT JOIN LATERAL (SELECT state, dial FROM call_attempts
                               WHERE authorization_id = a.id ORDER BY dial DESC LIMIT 1) ca ON TRUE
          WHERE t.id = $1`,
        [tx.id]
      )
    ).rows[0]!;
    const line = `${s.state}${s.failure_code ? ` (${s.failure_code})` : ''} · confirmation ${s.status} · call ${s.call} (dial ${s.dial})`;
    if (line !== last) console.log(`[${new Date().toLocaleTimeString()}] ${(last = line)}`);
    if (s.state !== 'AWAITING_CUSTOMER') break;
    await sleep(2000);
  }
}

main()
  .catch((err) => {
    console.error(`[ivr:try] ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
