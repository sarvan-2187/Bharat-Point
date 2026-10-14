/**
 * "This wasn't me": the answer to an agent who holds the customer's phone and
 * confirms for them. The customer reports from their own app; only the owner
 * can, only once; it never moves money and it reaches the admin's alert board.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, newDevice, startHarness, type Harness } from '../testing/harness';
import { enrolMessage, intentMessage, loginMessage } from '../auth/crypto';

describe('customer reports a transaction', { skip: dbSkip }, () => {
  let h: Harness;
  let seq = 0;
  before(async () => {
    process.env.DEMO_MODE = 'true';
    h = await startHarness();
    await h.bank('DEMO-SBI');
  });
  after(() => h?.close());

  /** A customer who signed up in the app: own passkey, own session. */
  async function signUp() {
    const phone = `9876500${String(++seq).padStart(3, '0')}`;
    const device = newDevice();
    const res = await h.call('POST', '/auth/signup', {
      displayName: `Self Signup ${seq}`,
      phone,
      bankCode: 'DEMO-SBI',
      language: 'te',
      pin: '4827',
      sipExtension: String(7000 + seq),
      publicKey: device.publicKey,
      signature: device.sign(enrolMessage(`signup:${phone}`)),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const ch = await h.call('POST', '/auth/challenge', { deviceKeyId: res.body.deviceKeyId });
    const login = await h.call('POST', '/auth/login', {
      challengeId: ch.body.challengeId,
      signature: device.sign(loginMessage(ch.body.challengeId, ch.body.nonce)),
    });
    assert.equal(login.status, 200);
    const row = (
      await h.pool.query(
        `SELECT c.id AS "customerId", l.id AS "accountLinkId" FROM customers c
           JOIN customer_account_links l ON l.customer_id = c.id WHERE c.display_name = $1`,
        [`Self Signup ${seq}`]
      )
    ).rows[0];
    return { token: login.body.token as string, ...row };
  }

  test('only the owner can report, once, and the admin sees it against the agent', async () => {
    const agent = await h.signedIn('AGENT');
    const admin = await h.signedIn('ADMIN');
    const owner = await signUp();
    const stranger = await signUp();

    const created = await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor: 20_000, customerId: owner.customerId, accountLinkId: owner.accountLinkId }, agent.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;
    await h.call('POST', `/transactions/${id}/sign`, { signature: agent.device.sign(intentMessage(created.body.intentHash)) }, agent.token);

    // The customer sees only their own transaction.
    const mine = await h.call('GET', '/transactions', undefined, owner.token);
    assert.deepEqual(mine.body.transactions.map((t: { id: string; disputed: boolean }) => [t.id, t.disputed]), [[id, false]]);
    assert.equal((await h.call('GET', '/transactions', undefined, stranger.token)).body.transactions.length, 0);

    assert.equal((await h.call('POST', `/transactions/${id}/report`, {}, agent.token)).status, 403); // an agent cannot
    assert.equal((await h.call('POST', `/transactions/${id}/report`, {}, stranger.token)).status, 404); // nor another customer
    assert.equal((await h.call('POST', `/transactions/${id}/report`, { note: 'I was not at the shop' }, owner.token)).status, 204);
    assert.equal((await h.call('POST', `/transactions/${id}/report`, {}, owner.token)).status, 409); // once

    assert.equal((await h.call('GET', `/transactions/${id}`, undefined, owner.token)).body.disputed, true);
    const alerts = (await h.call('GET', '/admin/alerts', undefined, admin.token)).body.alerts;
    assert.ok(alerts.some((a: { kind: string; transactionId: string }) => a.kind === 'CUSTOMER_REPORTED' && a.transactionId === id));

    // Append-only: not even the app's own database role can erase a report.
    await assert.rejects(h.pool.query(`DELETE FROM transaction_disputes WHERE transaction_id = $1`, [id]));
  });
});
