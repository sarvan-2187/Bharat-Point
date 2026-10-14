/**
 * Test harness (test-only; never imported by the app).
 *
 * startHarness() creates a throwaway database from DATABASE_URL, migrates it,
 * starts the real app on a random port, and returns helpers for staff, phones
 * and synthetic customers. close() drops the database.
 *
 * Each test file runs in its own process, so pointing DATABASE_URL at the
 * throwaway database before the app's modules load is safe.
 */
import assert from 'node:assert/strict';
import crypto from 'crypto';
import path from 'path';
import type { Server } from 'http';
import { Pool } from 'pg';
import { enrolMessage, loginMessage } from '../auth/crypto';

export const dbSkip = process.env.DATABASE_URL ? false : 'DATABASE_URL not set; start Postgres to run this test';

export type Role = 'AGENT' | 'ADMIN' | 'BANK_OPERATOR';

/** A simulated phone: an Ed25519 key pair, as the app would hold. */
export function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x!,
    sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
}
export type Device = ReturnType<typeof newDevice>;

export async function startHarness() {
  const url = process.env.DATABASE_URL!;
  const dbName = `bp_test_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const testUrl = new URL(url);
  testUrl.pathname = `/${dbName}`;
  process.env.DATABASE_URL = testUrl.toString(); // read by the app's pool on load

  // An in-process mock bank (services/mock-bank), so provider calls are real HTTP.
  const bankToken = process.env.MOCK_BANK_TOKEN || 'test-mock-bank-token-0123456789';
  process.env.MOCK_BANK_TOKEN = bankToken;
  const { createMockBank } = require(path.resolve(__dirname, '../../../services/mock-bank/src/bank')) as {
    createMockBank: (opts: { token: string; dataFile: null }) => Server;
  };
  const mockBank = createMockBank({ token: bankToken, dataFile: null });
  mockBank.listen(0, '127.0.0.1');
  await new Promise((resolve) => mockBank.once('listening', resolve));
  const bankUrl = `http://127.0.0.1:${(mockBank.address() as { port: number }).port}`;
  process.env.MOCK_BANK_URL = bankUrl;

  // An in-process fake IVR (testing/fake-ivr.ts), so confirmation calls are real HTTP.
  const ivrSecret = 'test-ivr-shared-secret-0123456789abcdef';
  const { startFakeIvr }: typeof import('./fake-ivr') = require('./fake-ivr');
  const ivr = await startFakeIvr(ivrSecret);
  process.env.IVR_URL = ivr.url;
  process.env.IVR_SHARED_SECRET = ivrSecret;

  async function bankCall(method: string, p: string, body?: unknown) {
    const res = await fetch(`${bankUrl}${p}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bankToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Read and steer the mock bank directly, as a test needs to. */
  const provider = {
    balance: async (token: string) => (await bankCall('GET', `/v1/accounts/${encodeURIComponent(token)}`)).body.balanceMinor as number,
    request: (requestId: string) => bankCall('GET', `/v1/requests/${encodeURIComponent(requestId)}`),
    setFault: (fault: { mode: string | null; count?: number; delayMs?: number }) => bankCall('POST', '/sim/faults', fault),
  };

  const poolModule: typeof import('../db/pool') = require('../db/pool');
  const { migrate }: typeof import('../db/migrate') = require('../db/migrate');
  const staff: typeof import('../staff/staff') = require('../staff/staff');
  const customers: typeof import('../customers/customers') = require('../customers/customers');
  const { createApp }: typeof import('../app') = require('../app');
  const pool = poolModule.default;
  // Safety: the pool reads its URL when config/env is first imported. A test file that imports
  // anything touching config BEFORE startHarness() would silently run against the real database.
  const connectedTo = (await pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
  if (connectedTo !== dbName) {
    throw new Error(`test harness is connected to "${connectedTo}", not its own "${dbName}": import config-dependent modules inside tests, after startHarness()`);
  }
  await migrate(pool, () => {});

  const server: Server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  async function call(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function bank(code: string): Promise<string> {
    await pool.query(`INSERT INTO banks (code, display_name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`, [
      code,
      `Demo ${code}`,
    ]);
    return (await pool.query<{ id: string }>(`SELECT id FROM banks WHERE code = $1`, [code])).rows[0]!.id;
  }

  /** A synthetic customer with one account at the given bank, mirrored at the mock bank. */
  let extensionSeq = 6000;
  let phoneSeq = 0;
  async function customer(
    name: string,
    bankCode = 'DEMO-SBI',
    opts: { balanceMinor?: number; sipExtension?: string | null; mode?: 'BLIND_ENTRY' | 'READBACK'; phone?: string } = {}
  ) {
    const bankId = await bank(bankCode);
    const sipExtension = opts.sipExtension === undefined ? String(++extensionSeq) : opts.sipExtension;
    const phone = opts.phone ?? `98${String(++phoneSeq).padStart(8, '0')}`;
    const providerToken = crypto.randomUUID();
    const maskedLabel = `Demo ${bankCode} ••••${crypto.randomInt(1000, 9999)}`;
    const { customerId, accountLinkId } = await poolModule.withTransaction((c) =>
      customers.createCustomer(c, { displayName: name, phone, sipExtension, mode: opts.mode ?? 'BLIND_ENTRY', bankId, providerToken, maskedLabel })
    );
    await bankCall('POST', '/sim/accounts', {
      token: providerToken,
      bankCode,
      holderName: name,
      maskedLabel,
      balanceMinor: opts.balanceMinor ?? 1_000_000, // ₹10,000
    });
    return { customerId, accountLinkId, bankId, providerToken, sipExtension, phone };
  }

  let seq = 0;
  /** A staff member who has enrolled a phone and signed in. */
  async function signedIn(role: Role, opts: { bankCode?: string } = {}) {
    const bankCode = opts.bankCode ?? 'DEMO-SBI';
    if (role === 'BANK_OPERATOR') await bank(bankCode);
    const code = `${role.slice(0, 2)}-${String(++seq).padStart(4, '0')}`;
    const input = staff.parseNewStaff({ role, staffCode: code, displayName: `Test ${code}`, locationName: 'Kothapalli', bankCode });
    const created = await poolModule.withTransaction((c) => staff.createStaff(c, input, null));

    const device = newDevice();
    const token = created.invite.token;
    const enrolled = await call('POST', '/auth/enrol', {
      inviteToken: token,
      publicKey: device.publicKey,
      signature: device.sign(enrolMessage(token)),
    });
    assert.equal(enrolled.status, 201);
    const ch = await call('POST', '/auth/challenge', { deviceKeyId: enrolled.body.deviceKeyId });
    const login = await call('POST', '/auth/login', {
      challengeId: ch.body.challengeId,
      signature: device.sign(loginMessage(ch.body.challengeId, ch.body.nonce)),
    });
    assert.equal(login.status, 200);
    const me = await call('GET', '/me', undefined, login.body.token);
    return {
      token: login.body.token as string,
      device,
      deviceKeyId: enrolled.body.deviceKeyId as string,
      userId: me.body.userId as string,
      agentId: me.body.agentId as string | null,
      bankId: me.body.bankId as string | null,
      auth: { ...me.body, sessionId: '', deviceKeyId: enrolled.body.deviceKeyId } as import('../auth/middleware').Auth,
    };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    mockBank.closeAllConnections(); // a deliberately late answer may still be pending
    await new Promise((resolve) => mockBank.close(resolve));
    await ivr.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  return { pool, withTransaction: poolModule.withTransaction, call, bank, customer, signedIn, provider, ivr, close };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;
