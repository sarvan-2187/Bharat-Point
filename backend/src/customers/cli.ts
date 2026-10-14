/**
 * Demo customer seeding, run on the server machine (trusted operator).
 * Creates a synthetic customer with one account at a demo bank, opens the
 * same account at the mock bank with a starting balance, and records the SIP
 * extension the IVR rings to reach the customer's softphone.
 *
 *   npm run customers:seed -- --name "Lakshmi" --phone 9876543210 --extension 6001
 *       [--bank DEMO-SBI] [--balance 10000] [--mode BLIND_ENTRY|READBACK]
 *
 * The agent then finds the customer on the phone by that mobile number.
 */
import crypto from 'crypto';
import { parseArgs } from 'node:util';
import pool, { withTransaction } from '../db/pool';
import { AppError } from '../api/errors';
import { config } from '../config/env';
import { createCustomer, findByPhone, normalizePhone } from './customers';

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      phone: { type: 'string' },
      extension: { type: 'string' },
      bank: { type: 'string' },
      balance: { type: 'string' },
      mode: { type: 'string' },
    },
  });
  const name = values.name?.trim();
  if (!name) throw new Error('--name is required');
  const phone = normalizePhone(values.phone);
  const extension = values.extension ?? null;
  if (extension !== null && !/^[0-9]{3,6}$/.test(extension)) throw new Error('--extension must be 3 to 6 digits, e.g. 6001');
  const bankCode = values.bank ?? 'DEMO-SBI';
  const rupees = Number(values.balance ?? 10000);
  if (!Number.isSafeInteger(rupees) || rupees < 0) throw new Error('--balance must be whole rupees, e.g. 10000');
  const mode = (values.mode ?? 'BLIND_ENTRY') as 'BLIND_ENTRY' | 'READBACK';
  if (mode !== 'BLIND_ENTRY' && mode !== 'READBACK') throw new Error('--mode must be BLIND_ENTRY or READBACK');

  if ((await findByPhone(pool, phone)).some((c) => c.displayName === name)) {
    throw new Error(`${name} is already seeded on this number`);
  }

  await pool.query(`INSERT INTO banks (code, display_name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`, [bankCode, `Demo ${bankCode}`]);
  const bankId = (await pool.query<{ id: string }>(`SELECT id FROM banks WHERE code = $1`, [bankCode])).rows[0]!.id;

  // Open the account at the bank first: a failure here leaves nothing behind in our database.
  const providerToken = crypto.randomUUID();
  const maskedLabel = `${bankCode} ••••${crypto.randomInt(1000, 10000)}`;
  const res = await fetch(`${config.providerUrl}/sim/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.providerToken}` },
    body: JSON.stringify({ token: providerToken, bankCode, holderName: name, maskedLabel, balanceMinor: rupees * 100 }),
  });
  if (res.status !== 201) throw new Error(`the mock bank refused the account (HTTP ${res.status}). Is it running?`);

  await withTransaction((c) => createCustomer(c, { displayName: name, phone, sipExtension: extension, mode, bankId, providerToken, maskedLabel }));
  console.log(`Seeded ${name}: phone ${phone}, ${maskedLabel}, balance ₹${rupees}, ${extension ? `IVR rings extension ${extension}` : 'no IVR extension (cannot confirm)'}, ${mode}.`);
}

main()
  .catch((err) => {
    const detail = err instanceof AppError ? `${err.failureCode} ${JSON.stringify(err.details ?? {})}` : err.message;
    console.error(`[customers:seed] ${detail}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
