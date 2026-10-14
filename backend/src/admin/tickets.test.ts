/**
 * The admin console's data: the live payments view with each payment's stages,
 * and tickets with ticket-based calling (a callback "did you make this?" that
 * is evidence for the admin and never moves a payment).
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, startHarness, type Harness } from '../testing/harness';
import { intentMessage } from '../auth/crypto';

describe('admin console', { skip: dbSkip }, () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h?.close());

  test('live view shows each payment with its stages; tickets can be called and resolved', async () => {
    const admin = await h.signedIn('ADMIN');
    const agent = await h.signedIn('AGENT');
    const cust = await h.customer('Lakshmi');

    const created = await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor: 30_000, customerId: cust.customerId, accountLinkId: cust.accountLinkId }, agent.token);
    const id = created.body.id as string;
    await h.call('POST', `/transactions/${id}/sign`, { signature: agent.device.sign(intentMessage(created.body.intentHash)) }, agent.token);

    // Live: the payment, how far it got, and the headline numbers. Staff other than admins cannot see it.
    const live = await h.call('GET', '/admin/live', undefined, admin.token);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    const row = live.body.transactions.find((t: { id: string }) => t.id === id);
    assert.deepEqual(row.stages, ['INTENT_LOCKED', 'AGENT_SIGNED']);
    assert.equal(row.amountMinor, 30_000);
    assert.ok(live.body.summary.inFlight >= 1);
    assert.equal((await h.call('GET', '/admin/live', undefined, agent.token)).status, 403);
    const tl = await h.call('GET', `/admin/transactions/${id}/timeline`, undefined, admin.token);
    assert.equal(tl.body.events[0].to, 'CREATED');
    assert.deepEqual(tl.body.steps.map((s: { stage: string }) => s.stage), ['INTENT_LOCKED', 'AGENT_SIGNED']);

    // A ticket exists for this payment (here opened directly; in life a report, a wrong PIN or a failed settlement does it).
    await h.pool.query(`INSERT INTO tickets (kind, transaction_id) VALUES ('BANK_EXCEPTION', $1)`, [id]);
    const list = async () => (await h.call('GET', '/admin/tickets', undefined, admin.token)).body.tickets as { id: string; status: string; calls: number; canCall: boolean; lastCall: { state: string; answer: string | null } | null }[];
    let ticket = (await list())[0]!;
    assert.equal(ticket.status, 'OPEN');
    assert.equal(ticket.canCall, true);

    // Ticket-based calling: the customer says "no, I did not make this".
    h.ivr.script(cust.sipExtension!, { decision: 'DECLINED' });
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/call`, {}, admin.token)).status, 202);
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/call`, {}, admin.token)).status, 409); // one call at a time
    assert.equal(h.ivr.posts.at(-1)?.mode, 'READBACK');
    for (let i = 0; i < 4 && !(ticket.lastCall?.answer); i++) ticket = (await list())[0]!;
    assert.equal(ticket.lastCall?.answer, 'NO');
    assert.equal((await h.pool.query(`SELECT state FROM transactions WHERE id = $1`, [id])).rows[0].state, 'CREATED', 'a callback never moves the payment');

    // Resolve needs a note, then the ticket is closed for good.
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/resolve`, {}, admin.token)).status, 400);
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/resolve`, { resolution: 'Customer denied it; agent suspended.' }, agent.token)).status, 403);
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/resolve`, { resolution: 'Customer denied it; agent suspended.' }, admin.token)).status, 204);
    assert.equal((await list())[0]!.status, 'RESOLVED');
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/call`, {}, admin.token)).status, 409);
    assert.equal((await h.call('POST', `/admin/tickets/${ticket.id}/resolve`, { resolution: 'again' }, admin.token)).status, 409);
  });
});
