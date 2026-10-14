/**
 * Phase 2: staff enrolment, sign-in and role checks, exercised over real HTTP
 * against a throwaway database (created from DATABASE_URL, dropped after).
 * Reported as SKIPPED when DATABASE_URL is not set.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Server } from 'http';
import { Pool } from 'pg';
import { migrate } from '../db/migrate';
import { enrolMessage, loginMessage } from './crypto';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set; start Postgres to run the auth tests';

/** A simulated phone: an Ed25519 key pair, as the app would hold. */
function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x!, // raw 32 bytes, base64url
    sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
}
type Device = ReturnType<typeof newDevice>;

describe('staff sign-in and roles', { skip }, () => {
  const dbName = `bp_test_${crypto.randomBytes(4).toString('hex')}`;
  let admin: Pool;
  let server: Server;
  let base: string;
  let app: {
    pool: Pool;
    withTransaction: typeof import('../db/pool').withTransaction;
    staff: typeof import('../staff/staff');
  };

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  let seq = 0;
  /** Create a staff member directly (as the CLI would) and return their invite token. */
  const newStaff = async (role: 'AGENT' | 'ADMIN' | 'BANK_OPERATOR') => {
    const code = `${role.slice(0, 2)}-${String(++seq).padStart(3, '0')}`;
    const input = app.staff.parseNewStaff({
      role,
      staffCode: code,
      displayName: `Test ${code}`,
      locationName: 'Kothapalli',
      bankCode: 'DEMO-SBI',
    });
    const created = await app.withTransaction((c) => app.staff.createStaff(c, input, null));
    return { userId: created.user.id, inviteToken: created.invite.token };
  };

  const enrol = (device: Device, inviteToken: string, signer: Device = device) =>
    call('POST', '/auth/enrol', {
      inviteToken,
      publicKey: device.publicKey,
      signature: signer.sign(enrolMessage(inviteToken)),
    });

  const login = async (deviceKeyId: string, signer: Device) => {
    const ch = await call('POST', '/auth/challenge', { deviceKeyId });
    if (ch.status !== 200) return { ...ch, challenge: null };
    const signature = signer.sign(loginMessage(ch.body.challengeId, ch.body.nonce));
    const res = await call('POST', '/auth/login', { challengeId: ch.body.challengeId, signature });
    return { ...res, challenge: { challengeId: ch.body.challengeId, signature } };
  };

  /** Staff member who has enrolled a phone and signed in. */
  const signedIn = async (role: 'AGENT' | 'ADMIN' | 'BANK_OPERATOR') => {
    const s = await newStaff(role);
    const device = newDevice();
    const enrolled = await enrol(device, s.inviteToken);
    assert.equal(enrolled.status, 201);
    const res = await login(enrolled.body.deviceKeyId, device);
    assert.equal(res.status, 200);
    return { ...s, device, deviceKeyId: enrolled.body.deviceKeyId as string, token: res.body.token as string };
  };

  before(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const testUrl = new URL(url!);
    testUrl.pathname = `/${dbName}`;
    process.env.DATABASE_URL = testUrl.toString(); // the app's pool reads this on import

    // Loaded only now, after DATABASE_URL points at the throwaway database.
    const poolModule: typeof import('../db/pool') = require('../db/pool');
    app = { pool: poolModule.default, withTransaction: poolModule.withTransaction, staff: require('../staff/staff') };
    await migrate(app.pool, () => {});
    await app.pool.query(`INSERT INTO banks (code, display_name) VALUES ('DEMO-SBI', 'Demo State Bank')`);

    const { createApp }: typeof import('../app') = require('../app');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await app?.pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  test('an invite enrols exactly one device', async () => {
    const s = await newStaff('AGENT');
    assert.equal((await enrol(newDevice(), s.inviteToken)).status, 201);
    assert.equal((await enrol(newDevice(), s.inviteToken)).status, 401);
  });

  test('an expired invite is refused', async () => {
    const s = await newStaff('AGENT');
    await app.pool.query(
      `UPDATE enrolment_invites SET created_at = NOW() - interval '2 hours', expires_at = NOW() - interval '1 hour'
        WHERE user_id = $1`,
      [s.userId]
    );
    assert.equal((await enrol(newDevice(), s.inviteToken)).status, 401);
  });

  test('enrolment needs a signature from the key being enrolled, and a bad one does not burn the invite', async () => {
    const s = await newStaff('AGENT');
    const device = newDevice();
    assert.equal((await enrol(device, s.inviteToken, newDevice())).status, 401);
    assert.equal((await enrol(device, s.inviteToken)).status, 201);
  });

  test('sign-in returns a session that reports the role', async () => {
    const agent = await signedIn('AGENT');
    const me = await call('GET', '/me', undefined, agent.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'AGENT');
    assert.ok(me.body.agentId);
    assert.equal(me.body.sessionId, undefined);
  });

  test('a signature from another device key cannot sign in', async () => {
    const agent = await signedIn('AGENT');
    assert.equal((await login(agent.deviceKeyId, newDevice())).status, 401);
  });

  test('a login challenge works once', async () => {
    const agent = await signedIn('AGENT');
    const first = await login(agent.deviceKeyId, agent.device);
    assert.equal(first.status, 200);
    assert.equal((await call('POST', '/auth/login', first.challenge)).status, 401);
  });

  test('logout revokes the session on the server', async () => {
    const agent = await signedIn('AGENT');
    assert.equal((await call('POST', '/auth/logout', {}, agent.token)).status, 204);
    assert.equal((await call('GET', '/me', undefined, agent.token)).status, 401);
  });

  test('suspending a user ends their live sessions and blocks new sign-ins', async () => {
    const boss = await signedIn('ADMIN');
    const agent = await signedIn('AGENT');
    assert.equal((await call('POST', `/admin/staff/${agent.userId}/suspend`, {}, boss.token)).status, 204);
    assert.equal((await call('GET', '/me', undefined, agent.token)).status, 401);
    assert.equal((await login(agent.deviceKeyId, agent.device)).status, 401);
  });

  test('an admin cannot suspend themselves', async () => {
    const boss = await signedIn('ADMIN');
    assert.equal((await call('POST', `/admin/staff/${boss.userId}/suspend`, {}, boss.token)).status, 400);
  });

  test('a lost phone is reset; a new invite enrols the replacement', async () => {
    const boss = await signedIn('ADMIN');
    const agent = await signedIn('AGENT');
    assert.equal((await call('POST', `/admin/staff/${agent.userId}/reset-devices`, {}, boss.token)).status, 204);
    assert.equal((await call('GET', '/me', undefined, agent.token)).status, 401);
    assert.equal((await login(agent.deviceKeyId, agent.device)).status, 401);

    const invite = await call('POST', `/admin/staff/${agent.userId}/invites`, {}, boss.token);
    assert.equal(invite.status, 201);
    const phone = newDevice();
    const enrolled = await enrol(phone, invite.body.token);
    assert.equal(enrolled.status, 201);
    assert.equal((await login(enrolled.body.deviceKeyId, phone)).status, 200);
  });

  test('role matrix: only ADMIN may manage staff; everyone signed in may read /me', async () => {
    const tokens = {
      none: undefined,
      AGENT: (await signedIn('AGENT')).token,
      BANK_OPERATOR: (await signedIn('BANK_OPERATOR')).token,
      ADMIN: (await signedIn('ADMIN')).token,
    };
    const expectations: { who: keyof typeof tokens; me: number; createStaff: number }[] = [
      { who: 'none', me: 401, createStaff: 401 },
      { who: 'AGENT', me: 200, createStaff: 403 },
      { who: 'BANK_OPERATOR', me: 200, createStaff: 403 },
      { who: 'ADMIN', me: 200, createStaff: 201 },
    ];
    for (const e of expectations) {
      const token = tokens[e.who];
      assert.equal((await call('GET', '/me', undefined, token)).status, e.me, `${e.who} GET /me`);
      const body = { role: 'ADMIN', staffCode: `AD-9${String(++seq).padStart(3, '0')}`, displayName: 'New admin' };
      assert.equal((await call('POST', '/admin/staff', body, token)).status, e.createStaff, `${e.who} POST /admin/staff`);
    }
  });

  test('a garbage bearer token is just unauthenticated', async () => {
    assert.equal((await call('GET', '/me', undefined, 'not-a-real-token')).status, 401);
  });

  test('bad input is a 400, never a 500', async () => {
    const boss = await signedIn('ADMIN');
    assert.equal((await call('POST', '/auth/challenge', { deviceKeyId: 'not-a-uuid' })).status, 400);
    assert.equal((await call('POST', '/auth/enrol', {})).status, 400);
    assert.equal((await call('POST', '/auth/login', { challengeId: crypto.randomUUID() })).status, 400);
    assert.equal((await call('POST', '/admin/staff', { role: 'ROOT' }, boss.token)).status, 400);
    assert.equal((await call('POST', '/admin/staff/not-a-uuid/suspend', {}, boss.token)).status, 400);
    const unknownBank = { role: 'BANK_OPERATOR', staffCode: 'BO-777', displayName: 'X', bankCode: 'NOPE' };
    assert.equal((await call('POST', '/admin/staff', unknownBank, boss.token)).status, 400);
  });

  test('a duplicate staff code is a 409', async () => {
    const boss = await signedIn('ADMIN');
    const body = { role: 'ADMIN', staffCode: 'AD-555', displayName: 'Dup' };
    assert.equal((await call('POST', '/admin/staff', body, boss.token)).status, 201);
    assert.equal((await call('POST', '/admin/staff', body, boss.token)).status, 409);
  });
});
