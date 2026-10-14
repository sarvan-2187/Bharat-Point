/**
 * Phase 4: the backend moves money at the (mock) bank exactly once, even when
 * the bank's answer is lost, the bank errors, the request is sent twice, or
 * the backend crashes mid-flight.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, startHarness, type Harness } from '../testing/harness';
import type { AppError } from '../api/errors';

// Give up on the bank quickly, so "late" answers are late within the test.
process.env.PROVIDER_TIMEOUT_MS = '300';
process.env.DEMO_MODE = 'true'; // the fault switches are demo-only

type Staff = Awaited<ReturnType<Harness['signedIn']>>;
type Account = Awaited<ReturnType<Harness['customer']>>;

describe('provider flow against the mock bank', { skip: dbSkip }, () => {
  let h: Harness;
  // Loaded after the harness points DATABASE_URL and MOCK_BANK_URL at the test instances.
  let tx: typeof import('../transactions/service');
  let provider: typeof import('./service');
  let sweeper: typeof import('./sweeper');
  let chain: typeof import('../transactions/chain');
  let agent: Staff;
  let bankOp: Staff;
  let lakshmi: Account;

  const SYSTEM = { kind: 'SYSTEM' as const, userId: null };

  /** A transaction the customer has confirmed (the confirmation itself arrives in Phase 5). */
  async function confirmed(opts: { txnType?: 'CASH_IN' | 'CASH_OUT'; amountMinor?: number; account?: Account } = {}) {
    const account = opts.account ?? lakshmi;
    const row = await h.withTransaction((c) =>
      tx.createTransaction(c, agent.auth, {
        txnType: opts.txnType ?? 'CASH_OUT',
        amountMinor: opts.amountMinor ?? 20000,
        customerId: account.customerId,
        accountLinkId: account.accountLinkId,
      })
    );
    await h.withTransaction(async (c) => {
      // The chain stages the real flow writes (agent signature, customer confirmation):
      // sending to the bank requires both.
      await chain.appendStep(c, row.id, 'AGENT_SIGNED', { test: true });
      await tx.transition(c, row.id, ['CREATED'], 'AWAITING_CUSTOMER', SYSTEM);
      await chain.appendStep(c, row.id, 'CUSTOMER_CONFIRMED', { test: true });
      await tx.transition(c, row.id, ['AWAITING_CUSTOMER'], 'CUSTOMER_CONFIRMED', SYSTEM);
    });
    return row.id;
  }

  const stateOf = async (id: string) =>
    (await h.pool.query<{ state: string; failure_code: string | null }>(
      `SELECT state, failure_code FROM transactions WHERE id = $1`,
      [id]
    )).rows[0]!;

  before(async () => {
    h = await startHarness();
    tx = require('../transactions/service');
    provider = require('./service');
    sweeper = require('./sweeper');
    chain = require('../transactions/chain');
    agent = await h.signedIn('AGENT');
    bankOp = await h.signedIn('BANK_OPERATOR');
  });
  after(() => h?.close());

  beforeEach(async () => {
    await h.provider.setFault({ mode: null });
    lakshmi = await h.customer('Lakshmi', 'DEMO-SBI', { balanceMinor: 100_000 }); // ₹1,000
  });

  test('a confirmed cash-out is debited once, approved, and recorded on the chain', async () => {
    const id = await confirmed();
    assert.equal(await provider.sendToProvider(id), 'PROVIDER_APPROVED');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000);
    const req = (await h.pool.query(`SELECT kind, state, request_id FROM provider_requests WHERE transaction_id = $1`, [id])).rows[0];
    assert.deepEqual(req, { kind: 'DEBIT', state: 'APPROVED', request_id: `debit:${id}` });
    const stages = (await h.pool.query(`SELECT stage FROM authorization_steps WHERE transaction_id = $1 ORDER BY seq`, [id])).rows;
    assert.deepEqual(stages.map((s) => s.stage), ['INTENT_LOCKED', 'AGENT_SIGNED', 'CUSTOMER_CONFIRMED', 'LIMITS_CHECKED', 'PROVIDER_AUTHORIZED']);
  });

  test('a confirmed cash-in is credited and completes (the cash was taken before the call)', async () => {
    const id = await confirmed({ txnType: 'CASH_IN', amountMinor: 50_000 });
    assert.equal(await provider.sendToProvider(id), 'COMPLETED');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 150_000);
  });

  test('a decline is final and moves no money', async () => {
    await h.provider.setFault({ mode: 'DECLINE' });
    const id = await confirmed();
    assert.equal(await provider.sendToProvider(id), 'PROVIDER_DECLINED');
    assert.deepEqual(await stateOf(id), { state: 'PROVIDER_DECLINED', failure_code: 'SIMULATED_DECLINE' });
    assert.equal(await h.provider.balance(lakshmi.providerToken), 100_000);
  });

  test('insufficient funds is a decline', async () => {
    const id = await confirmed({ amountMinor: 500_000 });
    assert.equal(await provider.sendToProvider(id), 'PROVIDER_DECLINED');
    assert.equal((await stateOf(id)).failure_code, 'INSUFFICIENT_FUNDS');
  });

  test('bank answer lost after it debited: UNKNOWN_OUTCOME, inquiry resolves it, exactly one debit', async () => {
    await h.provider.setFault({ mode: 'TIMEOUT_AFTER_COMMIT', delayMs: 2000 });
    const id = await confirmed();
    assert.equal(await provider.sendToProvider(id), 'UNKNOWN_OUTCOME');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000); // the bank did debit
    assert.equal(await provider.resolveUnknown(id), 'PROVIDER_APPROVED');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000); // and only once
  });

  test('bank error before it saved anything: the same request id is re-sent and debits once', async () => {
    await h.provider.setFault({ mode: 'ERROR_BEFORE_COMMIT' });
    const id = await confirmed();
    assert.equal(await provider.sendToProvider(id), 'UNKNOWN_OUTCOME');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 100_000);
    assert.equal(await provider.resolveUnknown(id), 'PROVIDER_APPROVED');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000);
    assert.equal((await h.provider.request(`debit:${id}`)).body.status, 'APPROVED');
  });

  test('an unconfirmed transaction cannot be sent to the bank', async () => {
    const row = await h.withTransaction((c) =>
      tx.createTransaction(c, agent.auth, { txnType: 'CASH_OUT', amountMinor: 20000, ...lakshmi })
    );
    await assert.rejects(provider.sendToProvider(row.id), (e: AppError) => e.failureCode === 'STATE_CONFLICT');
    assert.equal((await h.pool.query(`SELECT 1 FROM provider_requests WHERE transaction_id = $1`, [row.id])).rows.length, 0);
    assert.equal(await h.provider.balance(lakshmi.providerToken), 100_000);
  });

  test('sending twice, even at the same moment, debits once', async () => {
    const id = await confirmed();
    const results = await Promise.allSettled([provider.sendToProvider(id), provider.sendToProvider(id)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000);
    await assert.rejects(provider.sendToProvider(id), (e: AppError) => e.failureCode === 'STATE_CONFLICT');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000);
  });

  test('if the bank never answers, the transaction goes to manual reconciliation; no money moves', async () => {
    await h.provider.setFault({ mode: 'ERROR_BEFORE_COMMIT', count: 50 });
    const id = await confirmed();
    assert.equal(await provider.sendToProvider(id), 'UNKNOWN_OUTCOME');
    let state = 'UNKNOWN_OUTCOME';
    for (let i = 0; i < 10 && state === 'UNKNOWN_OUTCOME'; i++) state = await provider.resolveUnknown(id);
    assert.deepEqual(await stateOf(id), { state: 'RECONCILIATION_REQUIRED', failure_code: 'PROVIDER_NO_ANSWER' });
    assert.equal(await h.provider.balance(lakshmi.providerToken), 100_000);
  });

  test('a crash after recording the send is recovered by the sweeper without a second debit', async () => {
    const id = await confirmed();
    // Simulate a crash between "recorded the send" and "called the bank".
    await h.withTransaction(async (c) => {
      await tx.transition(c, id, ['CUSTOMER_CONFIRMED'], 'PROVIDER_PENDING', SYSTEM);
      await c.query(
        `INSERT INTO provider_requests (transaction_id, kind, request_id, created_at, updated_at)
         VALUES ($1, 'DEBIT', $2, NOW() - interval '1 minute', NOW() - interval '1 minute')`,
        [id, `debit:${id}`]
      );
    });
    await sweeper.sweepOnce();
    assert.equal((await stateOf(id)).state, 'PROVIDER_APPROVED');
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000);
    await sweeper.sweepOnce(); // nothing left to do
    assert.equal(await h.provider.balance(lakshmi.providerToken), 80_000);
  });

  test('fault switches: bank staff only, and only in demo mode', async () => {
    assert.equal((await h.call('POST', '/bank/sim/faults', { mode: 'DECLINE' }, agent.token)).status, 403);
    const set = await h.call('POST', '/bank/sim/faults', { mode: 'DECLINE', count: 2 }, bankOp.token);
    assert.equal(set.status, 200);
    assert.equal(set.body.fault.mode, 'DECLINE');
    assert.equal((await h.call('POST', '/bank/sim/faults', { mode: 'EXPLODE' }, bankOp.token)).status, 400);

    const previous = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'false';
    try {
      assert.equal((await h.call('GET', '/bank/sim/faults', undefined, bankOp.token)).status, 404);
    } finally {
      process.env.DEMO_MODE = previous;
    }
  });
});
