/**
 * Phase 3: the transaction API over real HTTP. An agent creates a transaction
 * locked to an intent hash, signs it with their enrolled phone, and can amend
 * (supersede) or cancel it before confirmation. Nobody else can touch it.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { dbSkip, newDevice, startHarness, type Device, type Harness } from '../testing/harness';
import { intentMessage } from '../auth/crypto';

type Staff = Awaited<ReturnType<Harness['signedIn']>>;
type TxView = { id: string; intentHash: string; state: string; amountMinor: number; agentSigned: boolean; supersededBy: string | null };

describe('transaction API', { skip: dbSkip }, () => {
  let h: Harness;
  let agentA: Staff;
  let agentB: Staff;
  let admin: Staff;
  let opSbi: Staff;
  let opHdfc: Staff;
  let lakshmi: Awaited<ReturnType<Harness['customer']>>;
  let suresh: Awaited<ReturnType<Harness['customer']>>;

  const create = (agent: Staff, over: Record<string, unknown> = {}) =>
    h.call(
      'POST',
      '/transactions',
      { txnType: 'CASH_OUT', customerId: lakshmi.customerId, accountLinkId: lakshmi.accountLinkId, amountMinor: 20000, ...over },
      agent.token
    );

  const created = async (agent: Staff): Promise<TxView> => {
    const res = await create(agent);
    assert.equal(res.status, 201);
    return res.body;
  };

  const sign = (agent: Staff, tx: TxView, signer: Device = agent.device, hash = tx.intentHash) =>
    h.call('POST', `/transactions/${tx.id}/sign`, { signature: signer.sign(intentMessage(hash)) }, agent.token);

  before(async () => {
    h = await startHarness();
    agentA = await h.signedIn('AGENT');
    agentB = await h.signedIn('AGENT');
    admin = await h.signedIn('ADMIN');
    opSbi = await h.signedIn('BANK_OPERATOR', { bankCode: 'DEMO-SBI' });
    opHdfc = await h.signedIn('BANK_OPERATOR', { bankCode: 'DEMO-HDFC' });
    lakshmi = await h.customer('Lakshmi', 'DEMO-SBI');
    suresh = await h.customer('Suresh', 'DEMO-SBI');
  });
  after(() => h?.close());

  test('an agent creates a transaction locked to an intent hash', async () => {
    const res = await create(agentA);
    assert.equal(res.status, 201);
    assert.equal(res.body.state, 'CREATED');
    assert.equal(res.body.amountMinor, 20000);
    assert.equal(res.body.agentSigned, false);
    assert.equal(res.body.customerName, 'Lakshmi');
    assert.match(res.body.intentHash, /^[A-Za-z0-9_-]{43}$/);
    assert.match(res.body.accountLabel, /^Demo DEMO-SBI ••••\d{4}$/);
  });

  test('the agent signs the intent with their phone key, once', async () => {
    const tx = await created(agentA);
    const signed = await sign(agentA, tx);
    assert.equal(signed.status, 200);
    assert.equal(signed.body.agentSigned, true);
    assert.equal((await sign(agentA, tx)).status, 409);
  });

  test('a signature from any other key is refused', async () => {
    const tx = await created(agentA);
    assert.equal((await sign(agentA, tx, newDevice())).status, 401);
    assert.equal((await sign(agentA, tx, agentB.device)).status, 401);
  });

  test('other agents can neither see nor touch the transaction', async () => {
    const tx = await created(agentA);
    assert.equal((await h.call('GET', `/transactions/${tx.id}`, undefined, agentB.token)).status, 404);
    assert.equal((await sign(agentB, tx)).status, 404);
    assert.equal((await h.call('POST', `/transactions/${tx.id}/cancel`, {}, agentB.token)).status, 404);
    assert.equal((await h.call('POST', `/transactions/${tx.id}/amend`, { amountMinor: 50000 }, agentB.token)).status, 404);
  });

  test('admins see every transaction; bank operators see only their own bank', async () => {
    const tx = await created(agentA);
    assert.equal((await h.call('GET', `/transactions/${tx.id}`, undefined, admin.token)).status, 200);
    assert.equal((await h.call('GET', `/transactions/${tx.id}`, undefined, opSbi.token)).status, 200);
    assert.equal((await h.call('GET', `/transactions/${tx.id}`, undefined, opHdfc.token)).status, 404);
  });

  test('only agents create transactions', async () => {
    assert.equal((await create(admin)).status, 403);
    assert.equal((await create(opSbi)).status, 403);
    assert.equal(
      (await h.call('POST', '/transactions', { txnType: 'CASH_OUT' })).status,
      401
    );
  });

  test('bad input is a 400, never a 500', async () => {
    assert.equal((await create(agentA, { amountMinor: 20050 })).status, 400); // paise in a cash amount
    assert.equal((await create(agentA, { amountMinor: '20000' })).status, 400);
    assert.equal((await create(agentA, { amountMinor: -100 })).status, 400);
    assert.equal((await create(agentA, { txnType: 'TRANSFER' })).status, 400);
    assert.equal((await create(agentA, { accountLinkId: suresh.accountLinkId })).status, 400); // not Lakshmi's account
    assert.equal((await create(agentA, { customerId: 'nope' })).status, 400);
  });

  test('amending supersedes the old transaction with a new one, atomically', async () => {
    const old = await created(agentA);
    const res = await h.call('POST', `/transactions/${old.id}/amend`, { amountMinor: 50000 }, agentA.token);
    assert.equal(res.status, 201);
    const replacement: TxView = res.body;
    assert.notEqual(replacement.id, old.id);
    assert.notEqual(replacement.intentHash, old.intentHash);
    assert.equal(replacement.amountMinor, 50000);
    assert.equal(replacement.agentSigned, false);

    const after = (await h.call('GET', `/transactions/${old.id}`, undefined, agentA.token)).body;
    assert.equal(after.state, 'SUPERSEDED');
    assert.equal(after.supersededBy, replacement.id);

    const events = await h.pool.query(`SELECT to_state FROM transaction_events WHERE transaction_id = $1 ORDER BY created_at`, [old.id]);
    assert.deepEqual(events.rows.map((r) => r.to_state), ['CREATED', 'SUPERSEDED']);
  });

  test("a signature over the old amount cannot sign the replacement", async () => {
    const old = await created(agentA);
    const replacement: TxView = (await h.call('POST', `/transactions/${old.id}/amend`, { amountMinor: 50000 }, agentA.token)).body;
    assert.equal((await sign(agentA, replacement, agentA.device, old.intentHash)).status, 401);
    assert.equal((await sign(agentA, replacement)).status, 200);
  });

  test('two simultaneous amendments: exactly one wins', async () => {
    const tx = await created(agentA);
    const [a, b] = await Promise.all([
      h.call('POST', `/transactions/${tx.id}/amend`, { amountMinor: 30000 }, agentA.token),
      h.call('POST', `/transactions/${tx.id}/amend`, { amountMinor: 40000 }, agentA.token),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  });

  test('a cancelled transaction cannot be amended or signed', async () => {
    const tx = await created(agentA);
    const cancelled = await h.call('POST', `/transactions/${tx.id}/cancel`, {}, agentA.token);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, 'CANCELLED');
    assert.equal((await h.call('POST', `/transactions/${tx.id}/amend`, { amountMinor: 50000 }, agentA.token)).status, 409);
    assert.equal((await sign(agentA, tx)).status, 409);
  });

  test('an expired transaction cannot be signed', async () => {
    const id = crypto.randomUUID();
    const hash = crypto.randomBytes(32).toString('base64url');
    await h.pool.query(
      `INSERT INTO transactions
         (id, txn_type, agent_id, customer_id, account_link_id, bank_id, amount_minor, intent_hash, nonce, created_at, expires_at)
       VALUES ($1, 'CASH_OUT', $2, $3, $4, $5, 20000, $6, $7, NOW() - interval '20 minutes', NOW() - interval '10 minutes')`,
      [id, agentA.agentId, lakshmi.customerId, lakshmi.accountLinkId, lakshmi.bankId, hash, crypto.randomBytes(32).toString('hex')]
    );
    const tx = { id, intentHash: hash } as TxView;
    assert.equal((await sign(agentA, tx)).status, 410);
  });
});
