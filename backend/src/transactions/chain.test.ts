/**
 * Phase 3: the authorization chain detects forged or out-of-order steps, and a
 * settlement capability works only for its own transaction, only once, and
 * only while the chain is exactly as it was when the capability was minted.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { dbSkip, startHarness, type Harness } from '../testing/harness';
import type { AppError } from '../api/errors';

const failsWith = (code: string, reason?: RegExp) => (err: unknown) => {
  const e = err as AppError;
  assert.equal(e.failureCode, code, `expected ${code}, got ${e.failureCode}: ${e.message}`);
  if (reason) assert.match(String(e.details?.reason ?? ''), reason);
  return true;
};

describe('authorization chain and settlement capability', { skip: dbSkip }, () => {
  let h: Harness;
  // Loaded after the harness points DATABASE_URL at the throwaway database.
  let chain: typeof import('./chain');
  let service: typeof import('./service');
  let agent: Awaited<ReturnType<Harness['signedIn']>>;
  let account: Awaited<ReturnType<Harness['customer']>>;

  const newTx = () =>
    h.withTransaction((c) =>
      service.createTransaction(c, agent.auth, { txnType: 'CASH_OUT', amountMinor: 20000, ...account })
    );

  /** Run fn with the transaction row locked, as the money-moving code will. */
  const withLocked = <T>(txId: string, fn: (c: import('pg').PoolClient, tx: import('./service').TxRow) => Promise<T>) =>
    h.withTransaction(async (c) => {
      const tx = (await c.query(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0];
      return fn(c, tx);
    });

  before(async () => {
    h = await startHarness();
    chain = require('./chain');
    service = require('./service');
    agent = await h.signedIn('AGENT');
    account = await h.customer('Lakshmi');
  });
  after(() => h?.close());

  test('a new transaction has a valid chain rooted in its intent hash', async () => {
    const tx = await newTx();
    const result = await withLocked(tx.id, (c) => chain.verifyChain(c, tx.id, tx.intent_hash));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.stages, ['INTENT_LOCKED']);
    // Rooted in this intent: verifying against another hash fails.
    const wrongRoot = await withLocked(tx.id, (c) => chain.verifyChain(c, tx.id, 'x'.repeat(43)));
    assert.equal(wrongRoot.ok, false);
  });

  test('stages only move forward and never repeat', async () => {
    const tx = await newTx();
    await withLocked(tx.id, (c) => chain.appendStep(c, tx.id, 'CUSTOMER_CONFIRMED', {}));
    await assert.rejects(
      withLocked(tx.id, (c) => chain.appendStep(c, tx.id, 'AGENT_SIGNED', {})),
      failsWith('CHAIN_INVALID', /cannot follow/)
    );
    await assert.rejects(
      withLocked(tx.id, (c) => chain.appendStep(c, tx.id, 'CUSTOMER_CONFIRMED', {})),
      failsWith('CHAIN_INVALID', /cannot follow/)
    );
  });

  test('a step written without the server key breaks verification', async () => {
    const tx = await newTx();
    const tip = (await h.pool.query(`SELECT row_hash FROM authorization_steps WHERE transaction_id = $1`, [tx.id])).rows[0];
    await h.pool.query(
      `INSERT INTO authorization_steps (transaction_id, attempt, seq, stage, payload, prev_hash, row_hash, mac)
       VALUES ($1, 1, 1, 'CUSTOMER_CONFIRMED', '{"approved":true}', $2, $3, 'forged')`,
      [tx.id, tip.row_hash, crypto.randomBytes(32).toString('base64url')]
    );
    const result = await withLocked(tx.id, (c) => chain.verifyChain(c, tx.id, tx.intent_hash));
    assert.equal(result.ok, false);
  });

  test('a capability needs every required stage', async () => {
    const tx = await newTx();
    await assert.rejects(
      withLocked(tx.id, (c) => chain.mintCapability(c, tx.id, tx.intent_hash, ['INTENT_LOCKED', 'AGENT_SIGNED'], 90)),
      failsWith('CHAIN_INCOMPLETE')
    );
  });

  test("a capability minted for T1 cannot settle T2", async () => {
    const t1 = await newTx();
    const t2 = await newTx();
    const cap = await withLocked(t1.id, (c) => chain.mintCapability(c, t1.id, t1.intent_hash, ['INTENT_LOCKED'], 90));
    await assert.rejects(
      withLocked(t2.id, (c, tx) => chain.consumeCapability(c, cap.id, tx)),
      failsWith('CAPABILITY_INVALID', /different transaction/)
    );
  });

  test('a capability is consumed exactly once', async () => {
    const tx = await newTx();
    const cap = await withLocked(tx.id, (c) => chain.mintCapability(c, tx.id, tx.intent_hash, ['INTENT_LOCKED'], 90));
    await withLocked(tx.id, (c, row) => chain.consumeCapability(c, cap.id, row));
    await assert.rejects(
      withLocked(tx.id, (c, row) => chain.consumeCapability(c, cap.id, row)),
      failsWith('CAPABILITY_INVALID', /already consumed/)
    );
  });

  test('a capability dies if the chain moves after it was minted', async () => {
    const tx = await newTx();
    const cap = await withLocked(tx.id, (c) => chain.mintCapability(c, tx.id, tx.intent_hash, ['INTENT_LOCKED'], 90));
    await withLocked(tx.id, (c) => chain.appendStep(c, tx.id, 'AGENT_SIGNED', {}));
    await assert.rejects(
      withLocked(tx.id, (c, row) => chain.consumeCapability(c, cap.id, row)),
      failsWith('CAPABILITY_INVALID', /chain moved/)
    );
  });

  test('a capability row written without the server key does not verify', async () => {
    const tx = await newTx();
    const forged = (
      await h.pool.query(
        `INSERT INTO settlement_capabilities (transaction_id, attempt, intent_hash, chain_tip_hash, required_stages, mac, expires_at)
         VALUES ($1, 1, $2, 'tip', ARRAY['INTENT_LOCKED'], 'forged', NOW() + interval '90 seconds') RETURNING id`,
        [tx.id, tx.intent_hash]
      )
    ).rows[0];
    await assert.rejects(
      withLocked(tx.id, (c, row) => chain.consumeCapability(c, forged.id, row)),
      failsWith('CAPABILITY_INVALID', /MAC invalid/)
    );
  });
});
