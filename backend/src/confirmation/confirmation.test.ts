/**
 * Phase 5: the customer confirmation call, against an in-process fake IVR that
 * implements the real IVR's contract. Covers the plan's 16 cases.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, startHarness, type Harness } from '../testing/harness';
import { intentMessage } from '../auth/crypto';
import type { AppError } from '../api/errors';

type Staff = Awaited<ReturnType<Harness['signedIn']>>;
type Customer = Awaited<ReturnType<Harness['customer']>>;
type TxView = { id: string; intentHash: string };

describe('customer confirmation call (IVR)', { skip: dbSkip }, () => {
  let h: Harness;
  // Loaded after the harness points the app at the throwaway database and fakes.
  let sweep: () => Promise<void>;
  let provider: typeof import('../provider/service');
  let agent: Staff;
  let otherAgent: Staff;
  let admin: Staff;
  let bankOp: Staff;

  async function signedTx(customer: Customer, opts: { amountMinor?: number; sign?: boolean } = {}): Promise<TxView> {
    const res = await h.call(
      'POST',
      '/transactions',
      { txnType: 'CASH_OUT', customerId: customer.customerId, accountLinkId: customer.accountLinkId, amountMinor: opts.amountMinor ?? 20000 },
      agent.token
    );
    assert.equal(res.status, 201);
    if (opts.sign !== false) {
      const signed = await h.call(
        'POST',
        `/transactions/${res.body.id}/sign`,
        { signature: agent.device.sign(intentMessage(res.body.intentHash)) },
        agent.token
      );
      assert.equal(signed.status, 200);
    }
    return res.body;
  }

  const confirm = (tx: TxView, token = agent.token) => h.call('POST', `/transactions/${tx.id}/confirmation`, {}, token);

  const stateOf = async (txId: string) =>
    (await h.pool.query<{ state: string; failure_code: string | null }>(`SELECT state, failure_code FROM transactions WHERE id = $1`, [txId]))
      .rows[0]!;

  const authOf = async (txId: string) =>
    (
      await h.pool.query<{ id: string; status: string; keyed: number | null }>(
        `SELECT id, status, customer_keyed_minor::int AS keyed FROM transaction_authorizations
          WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [txId]
      )
    ).rows[0]!;

  const auditCount = async (txId: string, event: string) =>
    (await h.pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE transaction_id = $1 AND event_type = $2`, [txId, event]))
      .rows[0]!.n;

  /** Change an authorization row as a database superuser would, bypassing its triggers. */
  async function tamper(sql: string, params: unknown[]) {
    const c = await h.pool.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(sql, params);
    } finally {
      await c.query(`SET session_replication_role = DEFAULT`);
      c.release();
    }
  }

  before(async () => {
    h = await startHarness();
    sweep = require('./sweeper').sweepConfirmationsOnce;
    provider = require('../provider/service');
    agent = await h.signedIn('AGENT');
    otherAgent = await h.signedIn('AGENT');
    admin = await h.signedIn('ADMIN');
    bankOp = await h.signedIn('BANK_OPERATOR');
  });
  after(() => h?.close());

  test('1. the customer keys the exact amount and presses 1: confirmed, with the call on the chain', async () => {
    const cust = await h.customer('Lakshmi');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200 });
    const tx = await signedTx(cust);
    const res = await confirm(tx);
    assert.equal(res.status, 202);
    assert.equal(res.body.state, 'AWAITING_CUSTOMER');
    assert.equal(res.body.confirmation.status, 'PENDING');
    assert.equal(res.body.confirmation.channel, 'IVR');

    await sweep();
    assert.equal((await stateOf(tx.id)).state, 'CUSTOMER_CONFIRMED');
    const authz = await authOf(tx.id);
    assert.deepEqual({ status: authz.status, keyed: authz.keyed }, { status: 'APPROVED', keyed: 20000 });
    const step = (
      await h.pool.query(`SELECT payload FROM authorization_steps WHERE transaction_id = $1 AND stage = 'CUSTOMER_CONFIRMED'`, [tx.id])
    ).rows[0].payload;
    assert.equal(step.callId, `confirm:${authz.id}:1`);
    assert.equal(step.keyedMinor, 20000);
    assert.equal(step.channel, 'IVR');
    assert.ok(step.ivrSignature);
  });

  test('2. the customer keys a different amount: rejected as AMOUNT_MISMATCH, evidence against the agent', async () => {
    const cust = await h.customer('Suresh');
    h.ivr.script(cust.sipExtension!, { decision: 'MISMATCH', keyedRupees: 500 });
    const tx = await signedTx(cust);
    await confirm(tx);
    await sweep();
    assert.deepEqual(await stateOf(tx.id), { state: 'REJECTED', failure_code: 'AMOUNT_MISMATCH' });
    const authz = await authOf(tx.id);
    assert.deepEqual({ status: authz.status, keyed: authz.keyed }, { status: 'MISMATCH', keyed: 50000 });
    assert.equal(await auditCount(tx.id, 'AMOUNT_MISMATCH'), 1);
  });

  test('3. an IVR that claims ACCEPTED for a different amount is overruled: still a mismatch', async () => {
    const cust = await h.customer('Meena');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 500 });
    const tx = await signedTx(cust);
    await confirm(tx);
    await sweep();
    assert.deepEqual(await stateOf(tx.id), { state: 'REJECTED', failure_code: 'AMOUNT_MISMATCH' });
    assert.equal((await authOf(tx.id)).status, 'MISMATCH');
  });

  test('4. the customer presses 2: rejected as CUSTOMER_DECLINED', async () => {
    const cust = await h.customer('Ravi');
    h.ivr.script(cust.sipExtension!, { decision: 'DECLINED' });
    const tx = await signedTx(cust);
    await confirm(tx);
    await sweep();
    assert.deepEqual(await stateOf(tx.id), { state: 'REJECTED', failure_code: 'CUSTOMER_DECLINED' });
    assert.equal((await authOf(tx.id)).status, 'REJECTED');
  });

  test('5. no answer: one redial with a new callId, then EXPIRED / NO_ANSWER', async () => {
    const cust = await h.customer('Anil');
    h.ivr.script(cust.sipExtension!, { status: 'NO_ANSWER' }, { status: 'NO_ANSWER' });
    const tx = await signedTx(cust);
    await confirm(tx);
    const authId = (await authOf(tx.id)).id;
    await sweep(); // dial 1: no answer -> dial 2 placed
    assert.equal(h.ivr.callsPlaced(`confirm:${authId}:1`), 1);
    assert.equal(h.ivr.callsPlaced(`confirm:${authId}:2`), 1);
    assert.equal((await stateOf(tx.id)).state, 'AWAITING_CUSTOMER');
    await sweep(); // dial 2: no answer -> give up
    assert.deepEqual(await stateOf(tx.id), { state: 'EXPIRED', failure_code: 'NO_ANSWER' });
    assert.equal((await authOf(tx.id)).status, 'NO_ANSWER');
  });

  test('6. nothing keyed: EXPIRED / INVALID_INPUT', async () => {
    const cust = await h.customer('Kavya');
    h.ivr.script(cust.sipExtension!, { decision: 'INVALID_INPUT' });
    const tx = await signedTx(cust);
    await confirm(tx);
    await sweep();
    assert.deepEqual(await stateOf(tx.id), { state: 'EXPIRED', failure_code: 'INVALID_INPUT' });
  });

  test('7. the same decision polled twice, by two sweeps at once: exactly one decision', async () => {
    const cust = await h.customer('Gopal');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200 });
    const tx = await signedTx(cust);
    await confirm(tx);
    await Promise.all([sweep(), sweep()]);
    await sweep();
    const steps = await h.pool.query(`SELECT 1 FROM authorization_steps WHERE transaction_id = $1 AND stage = 'CUSTOMER_CONFIRMED'`, [tx.id]);
    assert.equal(steps.rows.length, 1);
    assert.equal((await stateOf(tx.id)).state, 'CUSTOMER_CONFIRMED');
  });

  test('8. a reply with a bad signature is ignored and audited', async () => {
    const cust = await h.customer('Hari');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200, badSignature: true });
    const tx = await signedTx(cust);
    await confirm(tx);
    await sweep();
    assert.equal((await stateOf(tx.id)).state, 'AWAITING_CUSTOMER');
    assert.equal((await authOf(tx.id)).status, 'PENDING');
    assert.ok((await auditCount(tx.id, 'IVR_REPLY_REJECTED')) >= 1);
  });

  test('9. a reply after the agent amended has no effect; the replacement needs its own call', async () => {
    const cust = await h.customer('Priya');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200 });
    const tx = await signedTx(cust);
    await confirm(tx);
    const amended = await h.call('POST', `/transactions/${tx.id}/amend`, { amountMinor: 30000 }, agent.token);
    assert.equal(amended.status, 201);
    await sweep();
    assert.equal((await stateOf(tx.id)).state, 'SUPERSEDED');
    assert.equal((await authOf(tx.id)).status, 'EXPIRED');
    assert.equal((await stateOf(amended.body.id)).state, 'CREATED');
  });

  test('10. a reply after the confirmation expired approves nothing', async () => {
    const cust = await h.customer('Deepa');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200, pendingPolls: 5 });
    const tx = await signedTx(cust);
    await confirm(tx);
    await tamper(`UPDATE transaction_authorizations SET expires_at = created_at + interval '1 millisecond' WHERE transaction_id = $1`, [tx.id]);
    await sweep();
    assert.deepEqual(await stateOf(tx.id), { state: 'EXPIRED', failure_code: 'CONFIRMATION_EXPIRED' });
    assert.equal((await authOf(tx.id)).status, 'EXPIRED');
  });

  test('11. IVR unreachable at the start: the same callId is re-sent and exactly one call is placed', async () => {
    const cust = await h.customer('Imran');
    h.ivr.script(cust.sipExtension!, { unreachable: true }, { decision: 'ACCEPTED', keyedRupees: 200 });
    const tx = await signedTx(cust);
    assert.equal((await confirm(tx)).status, 202);
    const callId = `confirm:${(await authOf(tx.id)).id}:1`;
    assert.equal(h.ivr.callsPlaced(callId), 0);
    await sweep(); // 404 -> same callId again -> placed
    await sweep(); // decision
    assert.equal((await stateOf(tx.id)).state, 'CUSTOMER_CONFIRMED');
    assert.equal(h.ivr.callsPlaced(callId), 1);
    assert.equal(h.ivr.posts.filter((p) => p.callId === callId).length, 2);
  });

  test('12. fails closed: unsigned transaction, no extension, or no IVR configured', async () => {
    const cust = await h.customer('Jaya');
    const before = h.ivr.posts.length;
    assert.equal((await confirm(await signedTx(cust, { sign: false }))).status, 503);

    const noPhone = await h.customer('Lalitha', 'DEMO-SBI', { sipExtension: null });
    assert.equal((await confirm(await signedTx(noPhone))).status, 503);

    const url = process.env.IVR_URL;
    delete process.env.IVR_URL;
    try {
      assert.equal((await confirm(await signedTx(cust))).status, 503);
    } finally {
      process.env.IVR_URL = url;
    }
    assert.equal(h.ivr.posts.length, before);
  });

  test('13. an authorization tampered with in the database is never approved', async () => {
    const cust = await h.customer('Mohan');
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200, pendingPolls: 1 });
    const tx = await signedTx(cust);
    await confirm(tx);
    await tamper(`UPDATE transaction_authorizations SET binding_hash = 'forged' WHERE transaction_id = $1`, [tx.id]);
    await sweep();
    await sweep();
    assert.equal((await stateOf(tx.id)).state, 'AWAITING_CUSTOMER');
    assert.equal((await authOf(tx.id)).status, 'PENDING');
  });

  test('14. only the owning agent can start a confirmation', async () => {
    const tx = await signedTx(await h.customer('Nisha'));
    assert.equal((await confirm(tx, otherAgent.token)).status, 404);
    assert.equal((await confirm(tx, admin.token)).status, 403);
    assert.equal((await confirm(tx, bankOp.token)).status, 403);
    assert.equal((await h.call('POST', `/transactions/${tx.id}/confirmation`, {})).status, 401);
  });

  test('15. at most 3 confirmation calls per customer in 10 minutes', async () => {
    const cust = await h.customer('Omkar'); // unscripted: the phone just rings
    for (let i = 0; i < 3; i++) assert.equal((await confirm(await signedTx(cust))).status, 202);
    assert.equal((await confirm(await signedTx(cust))).status, 429);
  });

  test('16. end to end: only a confirmed transaction reaches the bank', async () => {
    const cust = await h.customer('Pooja', 'DEMO-SBI', { balanceMinor: 100_000 });
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: 200 });
    const tx = await signedTx(cust);
    await confirm(tx);
    await sweep();
    assert.equal(await provider.sendToProvider(tx.id), 'PROVIDER_APPROVED');
    assert.equal(await h.provider.balance(cust.providerToken), 80_000);

    const refused = await h.customer('Qadir');
    h.ivr.script(refused.sipExtension!, { decision: 'DECLINED' });
    const tx2 = await signedTx(refused);
    await confirm(tx2);
    await sweep();
    await assert.rejects(provider.sendToProvider(tx2.id), (e: AppError) => e.failureCode === 'STATE_CONFLICT');
  });
});
