/**
 * Phase 7: the agent finds the customer by mobile number (exactly, never by
 * browsing), the number is never stored in the clear, and staff list only the
 * transactions they may see.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { dbSkip, startHarness, type Harness } from '../testing/harness';

type Staff = Awaited<ReturnType<Harness['signedIn']>>;

describe('customer lookup and transaction lists', { skip: dbSkip }, () => {
  let h: Harness;
  let agent: Staff;

  before(async () => {
    h = await startHarness();
    agent = await h.signedIn('AGENT');
  });
  after(() => h?.close());

  const lookup = (phone: string, token = agent.token) => h.call('GET', `/customers?phone=${encodeURIComponent(phone)}`, undefined, token);

  test('an agent finds a customer by mobile number, in any common format', async () => {
    const cust = await h.customer('Lakshmi', 'DEMO-SBI', { phone: '9876543210' });
    for (const typed of ['9876543210', '+91 98765 43210', '09876543210', '91-98765-43210']) {
      const res = await lookup(typed);
      assert.equal(res.status, 200, typed);
      assert.equal(res.body.customers.length, 1, typed);
    }
    const [found] = (await lookup('9876543210')).body.customers;
    assert.equal(found.customerId, cust.customerId);
    assert.equal(found.displayName, 'Lakshmi');
    assert.equal(found.reachable, true);
    assert.deepEqual(found.accounts.map((a: { accountLinkId: string; bankCode: string }) => [a.accountLinkId, a.bankCode]), [
      [cust.accountLinkId, 'DEMO-SBI'],
    ]);
  });

  test('the number is stored encrypted, and its search hash is keyed', async () => {
    const cust = await h.customer('Ravi', 'DEMO-SBI', { phone: '9123456780' });
    const row = (await h.pool.query(`SELECT phone_enc, phone_lookup FROM customers WHERE id = $1`, [cust.customerId])).rows[0];
    assert.equal(row.phone_enc.includes(Buffer.from('9123456780')), false);
    assert.notEqual(row.phone_lookup, crypto.createHash('sha256').update('9123456780').digest('hex')); // not guessable offline
  });

  test('a shared family phone returns everyone on it; an unknown number returns nobody', async () => {
    await h.customer('Gopal', 'DEMO-SBI', { phone: '9000000001' });
    await h.customer('Kavya', 'DEMO-HDFC', { phone: '9000000001', sipExtension: null });
    const res = await lookup('9000000001');
    assert.deepEqual(res.body.customers.map((c: { displayName: string; reachable: boolean }) => [c.displayName, c.reachable]), [
      ['Gopal', true],
      ['Kavya', false], // no number for the IVR to ring: cannot confirm
    ]);
    assert.deepEqual((await lookup('9000000002')).body.customers, []);
  });

  test('a malformed number is refused', async () => {
    for (const bad of ['', '12345', '5876543210', '98765432100', 'nine eight seven']) {
      assert.equal((await lookup(bad)).status, 400, bad);
    }
  });

  test('only agents may look up customers, and every lookup is audited without the number', async () => {
    const admin = await h.signedIn('ADMIN');
    const bankOp = await h.signedIn('BANK_OPERATOR');
    assert.equal((await lookup('9876543210', admin.token)).status, 403);
    assert.equal((await lookup('9876543210', bankOp.token)).status, 403);
    assert.equal((await h.call('GET', '/customers?phone=9876543210')).status, 401);

    const audits = (
      await h.pool.query(`SELECT event_data FROM audit_logs WHERE event_type = 'CUSTOMER_LOOKUP' AND actor_user_id = $1`, [agent.userId])
    ).rows;
    assert.ok(audits.length > 0);
    assert.ok(audits.every((a) => !JSON.stringify(a.event_data).includes('98765')));
  });

  test('staff list only the transactions they may see', async () => {
    const otherAgent = await h.signedIn('AGENT');
    const admin = await h.signedIn('ADMIN');
    const sbiOp = await h.signedIn('BANK_OPERATOR', { bankCode: 'DEMO-SBI' });
    const hdfcOp = await h.signedIn('BANK_OPERATOR', { bankCode: 'DEMO-HDFC' });
    const sbi = await h.customer('Meena', 'DEMO-SBI');
    const hdfc = await h.customer('Suresh', 'DEMO-HDFC');
    const create = async (who: Staff, cust: typeof sbi) =>
      (await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor: 20000, customerId: cust.customerId, accountLinkId: cust.accountLinkId }, who.token))
        .body.id as string;
    const mineSbi = await create(agent, sbi);
    const mineHdfc = await create(agent, hdfc);
    const theirs = await create(otherAgent, sbi);

    const ids = async (who: Staff) => {
      const res = await h.call('GET', '/transactions', undefined, who.token);
      assert.equal(res.status, 200);
      return res.body.transactions.map((t: { id: string }) => t.id) as string[];
    };
    const agentSees = await ids(agent);
    assert.deepEqual(agentSees.slice(0, 2).sort(), [mineHdfc, mineSbi].sort()); // newest first (to the second)
    assert.equal(agentSees.includes(theirs), false);
    assert.deepEqual(await ids(otherAgent), [theirs]);
    const sbiSees = await ids(sbiOp);
    assert.ok(sbiSees.includes(mineSbi) && sbiSees.includes(theirs) && !sbiSees.includes(mineHdfc));
    assert.deepEqual(await ids(hdfcOp), [mineHdfc]);
    const adminSees = await ids(admin);
    assert.ok([mineSbi, mineHdfc, theirs].every((id) => adminSees.includes(id)));
  });
});
