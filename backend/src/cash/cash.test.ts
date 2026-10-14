/**
 * Phase 6: after the customer confirms, the money moves exactly once and every
 * step is on the ledger: automatic dispatch to the bank, signed cash handover,
 * reversal when cash could not be paid, cash-in completion or cash return,
 * and signed receipts.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { dbSkip, newDevice, startHarness, type Harness } from '../testing/harness';
import { cashReturnedMessage, handoverFailedMessage, handoverMessage, intentMessage } from '../auth/crypto';
import type { AppError } from '../api/errors';

process.env.PROVIDER_TIMEOUT_MS = '300'; // late bank answers are late within the test

type Staff = Awaited<ReturnType<Harness['signedIn']>>;
type Customer = Awaited<ReturnType<Harness['customer']>>;
type TxView = { id: string; intentHash: string; state: string };

describe('cash, ledger and receipts', { skip: dbSkip }, () => {
  let h: Harness;
  let confirmationSweep: () => Promise<void>;
  let providerSweep: () => Promise<void>;
  let chain: typeof import('../transactions/chain');
  let tx: typeof import('../transactions/service');
  let provider: typeof import('../provider/service');
  let agent: Staff;
  let otherAgent: Staff;
  let bankOp: Staff;

  async function created(cust: Customer, txnType: 'CASH_IN' | 'CASH_OUT', amountMinor: number): Promise<TxView> {
    const res = await h.call('POST', '/transactions', { txnType, amountMinor, customerId: cust.customerId, accountLinkId: cust.accountLinkId }, agent.token);
    assert.equal(res.status, 201);
    const signed = await h.call('POST', `/transactions/${res.body.id}/sign`, { signature: agent.device.sign(intentMessage(res.body.intentHash)) }, agent.token);
    assert.equal(signed.status, 200);
    return res.body;
  }

  /** Create, sign, have the customer confirm on the (fake) IVR, and let the sweeper send it to the bank. */
  async function throughBank(cust: Customer, txnType: 'CASH_IN' | 'CASH_OUT' = 'CASH_OUT', amountMinor = 20000) {
    const t = await created(cust, txnType, amountMinor);
    h.ivr.script(cust.sipExtension!, { decision: 'ACCEPTED', keyedRupees: amountMinor / 100 });
    assert.equal((await h.call('POST', `/transactions/${t.id}/confirmation`, {}, agent.token)).status, 202);
    await confirmationSweep();
    await providerSweep();
    return t;
  }

  const sign = (message: (hash: string) => string, t: TxView, device = agent.device) => device.sign(message(t.intentHash));
  const stateOf = async (id: string) => (await h.pool.query(`SELECT state, failure_code FROM transactions WHERE id = $1`, [id])).rows[0];
  const journals = async (id: string) =>
    (await h.pool.query(`SELECT purpose FROM ledger_journals WHERE transaction_id = $1 ORDER BY created_at, purpose`, [id])).rows.map((r) => r.purpose);
  const drawer = async (agentId: string) =>
    Number(
      (
        await h.pool.query(
          `SELECT COALESCE(SUM(p.amount_minor), 0) AS total FROM ledger_postings p
             JOIN ledger_accounts a ON a.id = p.ledger_account_id
            WHERE a.owner_type = 'AGENT' AND a.owner_id = $1 AND a.kind = 'CASH_DRAWER'`,
          [agentId]
        )
      ).rows[0].total
    );

  before(async () => {
    h = await startHarness();
    confirmationSweep = require('../confirmation/sweeper').sweepConfirmationsOnce;
    providerSweep = require('../provider/sweeper').sweepOnce;
    chain = require('../transactions/chain');
    tx = require('../transactions/service');
    provider = require('../provider/service');
    agent = await h.signedIn('AGENT');
    otherAgent = await h.signedIn('AGENT');
    bankOp = await h.signedIn('BANK_OPERATOR');
  });
  after(() => h?.close());
  beforeEach(() => h.provider.setFault({ mode: null }));

  test('a confirmed cash-out goes to the bank by itself; a signed handover completes it', async () => {
    const cust = await h.customer('Lakshmi', 'DEMO-SBI', { balanceMinor: 100_000 });
    const before = await drawer(agent.agentId!);
    const t = await throughBank(cust);
    assert.equal((await stateOf(t.id)).state, 'PROVIDER_APPROVED');
    assert.equal(await h.provider.balance(cust.providerToken), 80_000);

    const res = await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t) }, agent.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'COMPLETED');
    assert.deepEqual(await journals(t.id), ['PROVIDER_APPROVAL', 'CASH_HANDOVER']);
    assert.equal(await drawer(agent.agentId!), before - 20000); // ₹200 left the drawer
    const consumed = await h.pool.query(`SELECT 1 FROM settlement_capabilities WHERE transaction_id = $1 AND consumed_at IS NOT NULL`, [t.id]);
    assert.equal(consumed.rows.length, 2); // one to send to the bank, one to pay the cash
  });

  test('cash cannot be handed over before the bank approves', async () => {
    const t = await created(await h.customer('Suresh'), 'CASH_OUT', 20000);
    assert.equal((await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t) }, agent.token)).status, 409);
  });

  test("a handover needs the agent's own phone, and happens once", async () => {
    const t = await throughBank(await h.customer('Meena'));
    assert.equal((await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t, newDevice()) }, agent.token)).status, 401);
    assert.equal((await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t) }, otherAgent.token)).status, 404);
    // A signature for a different cash event does not count as a handover.
    assert.equal((await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverFailedMessage, t) }, agent.token)).status, 401);
    assert.equal((await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t) }, agent.token)).status, 200);
    assert.equal((await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t) }, agent.token)).status, 409);
  });

  test('cash that could not be paid: the debit is reversed exactly once and the ledger mirrors it', async () => {
    const cust = await h.customer('Ravi', 'DEMO-SBI', { balanceMinor: 100_000 });
    const t = await throughBank(cust);
    const res = await h.call('POST', `/transactions/${t.id}/handover-failed`, { signature: sign(handoverFailedMessage, t), reason: 'drawer empty' }, agent.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'REVERSED');
    assert.equal(await h.provider.balance(cust.providerToken), 100_000);
    assert.deepEqual(await journals(t.id), ['PROVIDER_APPROVAL', 'REVERSAL']);
    const net = await h.pool.query(
      `SELECT p.ledger_account_id, SUM(p.amount_minor)::int AS total
         FROM ledger_postings p JOIN ledger_journals j ON j.id = p.journal_id
        WHERE j.transaction_id = $1 GROUP BY p.ledger_account_id`,
      [t.id]
    );
    assert.ok(net.rows.every((r) => r.total === 0)); // every account is back where it started
  });

  test('a lost reversal answer is retried with the same request id and reverses once', async () => {
    const cust = await h.customer('Anil', 'DEMO-SBI', { balanceMinor: 100_000 });
    const t = await throughBank(cust);
    await h.provider.setFault({ mode: 'TIMEOUT_AFTER_COMMIT', delayMs: 2000 });
    const res = await h.call('POST', `/transactions/${t.id}/handover-failed`, { signature: sign(handoverFailedMessage, t) }, agent.token);
    assert.equal(res.body.state, 'REVERSAL_PENDING');
    assert.equal(await h.provider.balance(cust.providerToken), 100_000); // the bank did reverse
    await providerSweep(); // same reversal id again: the bank returns its stored answer
    assert.equal((await stateOf(t.id)).state, 'REVERSED');
    assert.equal(await h.provider.balance(cust.providerToken), 100_000); // and only once
  });

  test('an approved cash-in completes by itself, with its ledger journal', async () => {
    const cust = await h.customer('Kavya', 'DEMO-SBI', { balanceMinor: 100_000 });
    const t = await throughBank(cust, 'CASH_IN', 50_000);
    assert.equal((await stateOf(t.id)).state, 'COMPLETED');
    assert.deepEqual(await journals(t.id), ['CASH_IN']);
    assert.equal(await h.provider.balance(cust.providerToken), 150_000);
  });

  test("a declined cash-in requires the cash back, confirmed on the agent's phone", async () => {
    await h.provider.setFault({ mode: 'DECLINE' });
    const t = await throughBank(await h.customer('Gopal'), 'CASH_IN', 50_000);
    assert.equal((await stateOf(t.id)).state, 'CASH_RETURN_REQUIRED');
    const res = await h.call('POST', `/transactions/${t.id}/cash-returned`, { signature: sign(cashReturnedMessage, t) }, agent.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'CASH_RETURNED');
    assert.deepEqual(await journals(t.id), []);
  });

  test("nothing reaches the bank without the customer's confirmation on the chain", async () => {
    const cust = await h.customer('Hari', 'DEMO-SBI', { balanceMinor: 100_000 });
    const t = await created(cust, 'CASH_OUT', 20000); // agent-signed, never confirmed by the customer
    await h.withTransaction(async (c) => {
      await tx.transition(c, t.id, ['CREATED'], 'AWAITING_CUSTOMER', { kind: 'SYSTEM', userId: null });
      await tx.transition(c, t.id, ['AWAITING_CUSTOMER'], 'CUSTOMER_CONFIRMED', { kind: 'SYSTEM', userId: null });
    });
    await assert.rejects(provider.sendToProvider(t.id), (e: AppError) => e.failureCode === 'CHAIN_INCOMPLETE');
    assert.equal((await stateOf(t.id)).state, 'CUSTOMER_CONFIRMED');
    assert.equal((await h.pool.query(`SELECT 1 FROM provider_requests WHERE transaction_id = $1`, [t.id])).rows.length, 0);
    // The sweeper ends it for good rather than retrying forever; still nothing reaches the bank.
    await providerSweep();
    assert.deepEqual(await stateOf(t.id), { state: 'REJECTED', failure_code: 'CHAIN_INCOMPLETE' });
    assert.equal(await h.provider.balance(cust.providerToken), 100_000);
  });

  test('receipts are signed, verifiable with the published key, and only for those who may see them', async () => {
    const cust = await h.customer('Priya');
    const t = await throughBank(cust);
    assert.equal((await h.call('GET', `/transactions/${t.id}/receipt`, undefined, agent.token)).status, 409); // not finished
    await h.call('POST', `/transactions/${t.id}/handover`, { signature: sign(handoverMessage, t) }, agent.token);

    const res = await h.call('GET', `/transactions/${t.id}/receipt`, undefined, agent.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.receipt.amountMinor, 20000);
    assert.equal(res.body.receipt.simulated, true);
    const key = (await h.call('GET', '/receipts/key')).body;
    const verify = (receipt: unknown) =>
      crypto.verify(null, Buffer.from(chain.canonicalJson(receipt), 'utf8'), key.publicKeyPem, Buffer.from(res.body.signature, 'base64url'));
    assert.equal(verify(res.body.receipt), true);
    assert.equal(verify({ ...res.body.receipt, amountMinor: 50000 }), false); // a forged amount fails

    assert.equal((await h.call('GET', `/transactions/${t.id}/receipt`, undefined, bankOp.token)).status, 200);
    assert.equal((await h.call('GET', `/transactions/${t.id}/receipt`, undefined, otherAgent.token)).status, 404);
  });
});
