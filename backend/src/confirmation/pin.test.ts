/**
 * The customer PIN: what stops an agent who holds the customer's phone and
 * answers the confirmation call himself. The call must carry the right PIN;
 * a wrong one rejects the payment and, three times, locks confirmation; the
 * digits are never written down.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, newDevice, startHarness, type Harness } from '../testing/harness';
import { enrolMessage, intentMessage, loginMessage } from '../auth/crypto';

const PIN = '4827';

describe('PIN on the confirmation call', { skip: dbSkip }, () => {
  let h: Harness;
  let sweep: () => Promise<void>;
  let agent: Awaited<ReturnType<Harness['signedIn']>>;
  let seq = 0;

  before(async () => {
    process.env.DEMO_MODE = 'true';
    h = await startHarness();
    sweep = require('./sweeper').sweepConfirmationsOnce;
    await h.bank('DEMO-SBI');
    agent = await h.signedIn('AGENT');
  });
  after(() => h?.close());

  // Loaded inside the test, after the harness has pointed the app at its own database:
  // importing it at the top of this file would make the whole suite run against the real one.
  test('a PIN is four digits and not an obvious one', () => {
  const { hashPin, parsePin, pinMatches } = require('../customers/pin') as typeof import('../customers/pin');
  for (const bad of ['1234', '4321', '0000', '7777', '12', '12345', 'abcd', 1234, null]) assert.throws(() => parsePin(bad));
  assert.equal(parsePin(PIN), PIN);
  const stored = hashPin(PIN);
  assert.ok(pinMatches(PIN, stored));
  assert.ok(!pinMatches('4828', stored));
  assert.ok(!pinMatches(undefined, stored));
  assert.notEqual(hashPin(PIN), stored, 'each hash has its own salt');
  assert.ok(!stored.includes(PIN));
  });

  async function signUp(pin: string | null = PIN) {
    const phone = `9876600${String(++seq).padStart(3, '0')}`;
    const device = newDevice();
    const res = await h.call('POST', '/auth/signup', {
      displayName: `Pin Customer ${seq}`,
      phone,
      bankCode: 'DEMO-SBI',
      pin: pin ?? undefined,
      sipExtension: String(7100 + seq),
      publicKey: device.publicKey,
      signature: device.sign(enrolMessage(`signup:${phone}`)),
    });
    if (res.status !== 201) return { res };
    const ch = await h.call('POST', '/auth/challenge', { deviceKeyId: res.body.deviceKeyId });
    await h.call('POST', '/auth/login', { challengeId: ch.body.challengeId, signature: device.sign(loginMessage(ch.body.challengeId, ch.body.nonce)) });
    const row = (
      await h.pool.query(
        `SELECT c.id AS "customerId", c.sip_extension AS ext, l.id AS "accountLinkId" FROM customers c
           JOIN customer_account_links l ON l.customer_id = c.id WHERE c.display_name = $1`,
        [`Pin Customer ${seq}`]
      )
    ).rows[0];
    return { res, ...row };
  }

  /** The agent starts a ₹200 cash-out for this customer and the customer "keys" what the script says. */
  async function attempt(c: { customerId: string; accountLinkId: string; ext: string }, outcome: Parameters<Harness['ivr']['script']>[1]) {
    const created = await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor: 20_000, customerId: c.customerId, accountLinkId: c.accountLinkId }, agent.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await h.call('POST', `/transactions/${created.body.id}/sign`, { signature: agent.device.sign(intentMessage(created.body.intentHash)) }, agent.token);
    h.ivr.script(c.ext, outcome);
    const started = await h.call('POST', `/transactions/${created.body.id}/confirmation`, {}, agent.token);
    if (started.status !== 202) return { started, state: null as string | null, failure: null as string | null };
    let row;
    for (let i = 0; i < 6; i++) {
      await sweep();
      row = (await h.pool.query(`SELECT state, failure_code FROM transactions WHERE id = $1`, [created.body.id])).rows[0];
      if (row.state !== 'AWAITING_CUSTOMER') break;
    }
    return { started, state: row.state as string, failure: row.failure_code as string | null, id: created.body.id as string };
  }

  test('sign-up needs a PIN, and an easy one is refused', async () => {
    assert.equal((await signUp('')).res.status, 400);
    assert.equal((await signUp('1234')).res.status, 400);
    assert.equal((await signUp(null)).res.status, 400);
  });

  test('the right PIN lets the customer confirm, and the IVR is asked for it', async () => {
    const c = await signUp();
    const r = await attempt(c as never, { decision: 'ACCEPTED', keyedRupees: 200, keyedPin: PIN });
    assert.equal(r.state, 'CUSTOMER_CONFIRMED');
    assert.equal(h.ivr.posts.at(-1)?.pinRequired, true);
  });

  test('a wrong PIN rejects the payment', async () => {
    const c = await signUp();
    const r = await attempt(c as never, { decision: 'ACCEPTED', keyedRupees: 200, keyedPin: '9035' });
    assert.equal(r.state, 'REJECTED');
    assert.equal(r.failure, 'WRONG_PIN');
    assert.equal((await h.pool.query(`SELECT pin_failures FROM customers WHERE id = $1`, [(c as never as { customerId: string }).customerId])).rows[0].pin_failures, 1);
  });

  test('no PIN keyed fails closed without counting as a guess', async () => {
    const c = await signUp();
    const r = await attempt(c as never, { decision: 'ACCEPTED', keyedRupees: 200 });
    assert.notEqual(r.state, 'CUSTOMER_CONFIRMED');
    assert.equal(r.state, 'EXPIRED');
    assert.equal((await h.pool.query(`SELECT pin_failures FROM customers WHERE id = $1`, [(c as never as { customerId: string }).customerId])).rows[0].pin_failures, 0);
  });

  test('three wrong PINs lock confirmation, and the admin is alerted', async () => {
    const c = (await signUp()) as never as { customerId: string; accountLinkId: string; ext: string };
    for (let i = 0; i < 3; i++) assert.equal((await attempt(c, { decision: 'ACCEPTED', keyedRupees: 200, keyedPin: '9035' })).failure, 'WRONG_PIN');
    const locked = await attempt(c, { decision: 'ACCEPTED', keyedRupees: 200, keyedPin: PIN }); // even the right PIN
    assert.equal(locked.started.status, 503);
    assert.equal(locked.started.body.failureCode, 'CONFIRMATION_UNAVAILABLE');

    const admin = await h.signedIn('ADMIN');
    const alerts = (await h.call('GET', '/admin/alerts', undefined, admin.token)).body.alerts;
    assert.ok(alerts.some((a: { kind: string; agentCode: string }) => a.kind === 'PIN_GUESSING'));
  });

  test('the PIN is never stored', async () => {
    const c = (await signUp()) as never as { customerId: string; accountLinkId: string; ext: string };
    await attempt(c, { decision: 'ACCEPTED', keyedRupees: 200, keyedPin: PIN });
    const { rows } = await h.pool.query(`SELECT reply::text AS reply FROM call_attempts ca JOIN transaction_authorizations a ON a.id = ca.authorization_id JOIN transactions t ON t.id = a.transaction_id WHERE t.customer_id = $1`, [c.customerId]);
    assert.ok(rows.length > 0);
    for (const r of rows) assert.ok(!r.reply.includes(PIN) && !r.reply.includes('keyedPin'), r.reply);
    const audit = (await h.pool.query(`SELECT event_data::text AS d FROM audit_logs WHERE event_data::text LIKE $1`, [`%${PIN}%`])).rows;
    assert.equal(audit.length, 0);
  });
});
