/**
 * Phase 8: an admin controls agents. Limits hold at entry and, authoritatively,
 * before the bank; a suspension stops an agent mid-day; replenishment needs two
 * different admins; alerts surface what needs a person.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, startHarness, type Harness } from '../testing/harness';
import { handoverMessage, intentMessage } from '../auth/crypto';

type Staff = Awaited<ReturnType<Harness['signedIn']>>;
type Customer = Awaited<ReturnType<Harness['customer']>>;
type TxView = { id: string; intentHash: string; state: string };

describe('admin controls', { skip: dbSkip }, () => {
  let h: Harness;
  let confirmationSweep: () => Promise<void>;
  let providerSweep: () => Promise<void>;
  let admin: Staff;
  let admin2: Staff;

  before(async () => {
    h = await startHarness();
    confirmationSweep = require('../confirmation/sweeper').sweepConfirmationsOnce;
    providerSweep = require('../provider/sweeper').sweepOnce;
    admin = await h.signedIn('ADMIN');
    admin2 = await h.signedIn('ADMIN');
  });
  after(() => h?.close());
  beforeEach(() => h.provider.setFault({ mode: null }));

  async function signed(agent: Staff, cust: Customer, amountMinor: number): Promise<TxView> {
    const res = await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor, customerId: cust.customerId, accountLinkId: cust.accountLinkId }, agent.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await h.call('POST', `/transactions/${res.body.id}/sign`, { signature: agent.device.sign(intentMessage(res.body.intentHash)) }, agent.token)).status, 200);
    return res.body;
  }
  async function call(agent: Staff, cust: Customer, t: TxView, decision: 'ACCEPTED' | 'MISMATCH', keyedRupees: number) {
    h.ivr.script(cust.sipExtension!, { decision, keyedRupees });
    assert.equal((await h.call('POST', `/transactions/${t.id}/confirmation`, {}, agent.token)).status, 202);
  }
  const stateOf = async (id: string) => (await h.pool.query(`SELECT state, failure_code FROM transactions WHERE id = $1`, [id])).rows[0];
  const stages = async (id: string) =>
    (await h.pool.query(`SELECT stage FROM authorization_steps WHERE transaction_id = $1 ORDER BY seq`, [id])).rows.map((r) => r.stage);
  const setLimits = (agent: Staff, perTxnLimitMinor: number, dailyLimitMinor: number, token = admin.token) =>
    h.call('PUT', `/admin/agents/${agent.agentId}/limits`, { perTxnLimitMinor, dailyLimitMinor }, token);
  const staffEntry = async (userId: string) =>
    (await h.call('GET', '/admin/staff', undefined, admin.token)).body.staff.find((s: { userId: string }) => s.userId === userId);
  async function replenish(agent: Staff, amountMinor: number) {
    const req = await h.call('POST', `/admin/agents/${agent.agentId}/replenishments`, { accountKind: 'CASH_DRAWER', amountMinor }, admin.token);
    assert.equal(req.status, 201);
    return req.body.id as string;
  }

  test('over the per-transaction limit is refused at entry, until an admin raises it', async () => {
    const agent = await h.signedIn('AGENT');
    const cust = await h.customer('Lakshmi');
    assert.equal((await setLimits(agent, 50_000, 100_000)).status, 204); // ₹500 per transaction
    const over = await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor: 60_000, customerId: cust.customerId, accountLinkId: cust.accountLinkId }, agent.token);
    assert.equal(over.status, 403);
    assert.equal(over.body.failureCode, 'LIMIT_EXCEEDED');
    assert.equal(over.body.details.limit, 'PER_TRANSACTION');

    assert.equal((await setLimits(agent, 200_000, 100_000)).status, 400); // per-transaction above daily
    assert.equal((await setLimits(agent, 100_050, 200_000)).status, 400); // not whole rupees
    assert.equal((await setLimits(agent, 100_000, 100_000, agent.token)).status, 403); // agents cannot raise their own
    assert.equal((await setLimits(agent, 100_000, 100_000)).status, 204);
    await signed(agent, cust, 60_000);
  });

  test('the daily limit is enforced again before the bank, and written to the chain', async () => {
    const agent = await h.signedIn('AGENT');
    assert.equal((await setLimits(agent, 30_000, 30_000)).status, 204); // ₹300 a day
    const a = await h.customer('Ravi', 'DEMO-SBI', { balanceMinor: 100_000 });
    const b = await h.customer('Meena', 'DEMO-SBI', { balanceMinor: 100_000 });
    // Both fit at entry (nothing has moved yet); together they do not.
    const t1 = await signed(agent, a, 20_000);
    const t2 = await signed(agent, b, 20_000);
    await call(agent, a, t1, 'ACCEPTED', 200);
    await call(agent, b, t2, 'ACCEPTED', 200);
    await confirmationSweep();
    await providerSweep();

    const results = [await stateOf(t1.id), await stateOf(t2.id)];
    const sent = results.findIndex((r) => r.state === 'PROVIDER_APPROVED');
    assert.notEqual(sent, -1);
    assert.deepEqual(results[1 - sent], { state: 'REJECTED', failure_code: 'LIMIT_EXCEEDED' });
    const [approved, refused] = sent === 0 ? [t1, t2] : [t2, t1];
    assert.ok((await stages(approved.id)).includes('LIMITS_CHECKED'));
    assert.deepEqual(await stages(refused.id), ['INTENT_LOCKED', 'AGENT_SIGNED', 'CUSTOMER_CONFIRMED']);
    const total = (await h.provider.balance(a.providerToken)) + (await h.provider.balance(b.providerToken));
    assert.equal(total, 180_000); // exactly one ₹200 debit
    const audited = await h.pool.query(`SELECT 1 FROM audit_logs WHERE event_type = 'LIMIT_REJECTED' AND transaction_id = $1`, [refused.id]);
    assert.equal(audited.rows.length, 1);
  });

  test("an admin suspends an agent mid-day: the agent's next request fails and nothing more reaches the bank", async () => {
    const agent = await h.signedIn('AGENT');
    const cust = await h.customer('Suresh', 'DEMO-SBI', { balanceMinor: 100_000 });
    const t = await signed(agent, cust, 20_000);
    await call(agent, cust, t, 'ACCEPTED', 200); // the customer is on the call...

    assert.equal((await h.call('POST', `/admin/staff/${agent.userId}/suspend`, {}, admin.token)).status, 204);
    assert.equal((await h.call('GET', '/transactions', undefined, agent.token)).status, 401);

    await confirmationSweep(); // ...and confirms, but the agent is suspended
    await providerSweep();
    assert.deepEqual(await stateOf(t.id), { state: 'REJECTED', failure_code: 'AGENT_SUSPENDED' });
    assert.equal(await h.provider.balance(cust.providerToken), 100_000);

    assert.equal((await h.call('POST', `/admin/staff/${agent.userId}/reactivate`, {}, admin.token)).status, 204);
    assert.equal((await staffEntry(agent.userId)).status, 'ACTIVE');
    assert.equal((await h.call('GET', '/transactions', undefined, agent.token)).status, 401); // the old session stays ended
    assert.equal((await h.call('POST', `/admin/staff/${agent.userId}/reactivate`, {}, admin.token)).status, 404); // not suspended
  });

  test('replenishment needs two different admins, and only the approval moves the ledger', async () => {
    const agent = await h.signedIn('AGENT');
    const id = await replenish(agent, 5_000_000); // ₹50,000 of cash
    assert.equal((await staffEntry(agent.userId)).agent.drawerMinor, 0);

    const self = await h.call('POST', `/admin/replenishments/${id}/approve`, {}, admin.token);
    assert.equal(self.status, 403);
    assert.equal(self.body.failureCode, 'MAKER_CHECKER');
    assert.equal((await h.call('POST', `/admin/replenishments/${id}/approve`, {}, admin2.token)).status, 204);
    assert.equal((await staffEntry(agent.userId)).agent.drawerMinor, 5_000_000);
    assert.equal((await h.call('POST', `/admin/replenishments/${id}/approve`, {}, admin2.token)).status, 409); // decided once
    assert.equal((await h.call('POST', `/admin/replenishments/${id}/reject`, {}, admin2.token)).status, 409);

    const rejected = await replenish(agent, 1_000_000);
    assert.equal((await h.call('POST', `/admin/replenishments/${rejected}/reject`, {}, admin2.token)).status, 204);
    assert.equal((await staffEntry(agent.userId)).agent.drawerMinor, 5_000_000);

    const list = (await h.call('GET', '/admin/replenishments', undefined, admin.token)).body.replenishments;
    assert.equal(list.find((r: { id: string }) => r.id === id).decidedByCode, admin2.auth.staffCode);
    assert.equal((await h.call('POST', `/admin/agents/${agent.agentId}/replenishments`, { accountKind: 'CASH_DRAWER', amountMinor: 100 }, agent.token)).status, 403);
    assert.equal((await h.call('POST', `/admin/agents/${agent.agentId}/replenishments`, { accountKind: 'GOLD', amountMinor: 100 }, admin.token)).status, 400);

    // The database holds the line even if the code did not.
    const pending = await replenish(agent, 100_000);
    await assert.rejects(
      h.pool.query(`UPDATE replenishments SET status = 'REJECTED', decided_by = requested_by, decided_at = NOW() WHERE id = $1`, [pending]),
      /maker_checker/
    );
    await assert.rejects(h.pool.query(`DELETE FROM replenishments WHERE id = $1`, [id]));
  });

  test('alerts: repeated amount mismatches, and a drawer the ledger says is empty', async () => {
    const agent = await h.signedIn('AGENT');
    const code = agent.auth.staffCode;
    const mine = async () => (await h.call('GET', '/admin/alerts', undefined, admin.token)).body.alerts.filter((a: { agentCode: string }) => a.agentCode === code);

    for (const name of ['Gopal', 'Kavya']) {
      const cust = await h.customer(name);
      await call(agent, cust, await signed(agent, cust, 20_000), 'MISMATCH', 500); // the customer asked for ₹500, not ₹200
    }
    await confirmationSweep();
    assert.deepEqual((await mine()).map((a: { kind: string }) => a.kind), ['AMOUNT_MISMATCHES']);

    const cust = await h.customer('Anil');
    const t = await signed(agent, cust, 20_000);
    await call(agent, cust, t, 'ACCEPTED', 200);
    await confirmationSweep();
    await providerSweep();
    const handed = await h.call('POST', `/transactions/${t.id}/handover`, { signature: agent.device.sign(handoverMessage(t.intentHash)) }, agent.token);
    assert.equal(handed.status, 200);
    assert.ok((await mine()).some((a: { kind: string }) => a.kind === 'NEGATIVE_DRAWER')); // ₹200 paid out of a drawer never filled

    const id = await replenish(agent, 1_000_000);
    await h.call('POST', `/admin/replenishments/${id}/approve`, {}, admin2.token);
    assert.equal((await mine()).some((a: { kind: string }) => a.kind === 'NEGATIVE_DRAWER'), false);
    assert.equal((await h.call('GET', '/admin/alerts', undefined, agent.token)).status, 403);
  });

  test("the staff list shows each agent's limits, usage and balances; invites come with a QR image", async () => {
    const agent = await h.signedIn('AGENT');
    const entry = await staffEntry(agent.userId);
    assert.equal(entry.role, 'AGENT');
    assert.equal(entry.activeDevices, 1);
    assert.deepEqual(
      { per: entry.agent.perTxnLimitMinor, daily: entry.agent.dailyLimitMinor, used: entry.agent.usedTodayMinor, float: entry.agent.floatMinor },
      { per: 1_000_000, daily: 5_000_000, used: 0, float: 0 }
    );

    const created = await h.call('POST', '/admin/staff', { role: 'AGENT', staffCode: 'AG-7001', displayName: 'Priya', locationName: 'Ramapuram' }, admin.token);
    assert.equal(created.status, 201);
    assert.match(created.body.invite.qrDataUrl, /^data:image\/png;base64,/);
    const again = await h.call('POST', `/admin/staff/${created.body.user.id}/invites`, {}, admin.token);
    assert.match(again.body.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal((await h.call('GET', '/admin/staff', undefined, agent.token)).status, 403);
  });
});
