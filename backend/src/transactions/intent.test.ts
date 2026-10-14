/**
 * The intent hash is a contract: stored hashes, agent signatures and customer
 * approvals all depend on it never changing shape by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIntent, intentHash, type LockedIntent } from './intent';

const intent: LockedIntent = {
  accountLinkId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  amountMinor: 20000,
  bankId: '33333333-3333-4333-8333-333333333333',
  createdAt: 1790000000,
  customerId: '44444444-4444-4444-8444-444444444444',
  expiresAt: 1790000600,
  nonce: 'ab'.repeat(32),
  txId: '55555555-5555-4555-8555-555555555555',
  txnType: 'CASH_OUT',
};

test('the canonical form is fixed: sorted keys, no whitespace', () => {
  assert.equal(
    canonicalIntent(intent),
    '{"accountLinkId":"11111111-1111-4111-8111-111111111111","agentId":"22222222-2222-4222-8222-222222222222",' +
      '"amountMinor":20000,"bankId":"33333333-3333-4333-8333-333333333333","createdAt":1790000000,' +
      '"customerId":"44444444-4444-4444-8444-444444444444","expiresAt":1790000600,' +
      `"nonce":"${'ab'.repeat(32)}","txId":"55555555-5555-4555-8555-555555555555","txnType":"CASH_OUT"}`
  );
  assert.match(intentHash(intent), /^[A-Za-z0-9_-]{43}$/);
});

test('every field is inside the hash', () => {
  const original = intentHash(intent);
  const changed: { [K in keyof LockedIntent]: LockedIntent[K] } = {
    accountLinkId: '11111111-1111-4111-8111-111111111112',
    agentId: '22222222-2222-4222-8222-222222222223',
    amountMinor: 50000,
    bankId: '33333333-3333-4333-8333-333333333334',
    createdAt: 1790000001,
    customerId: '44444444-4444-4444-8444-444444444445',
    expiresAt: 1790000601,
    nonce: 'cd'.repeat(32),
    txId: '55555555-5555-4555-8555-555555555556',
    txnType: 'CASH_IN',
  };
  for (const key of Object.keys(changed) as (keyof LockedIntent)[]) {
    assert.notEqual(intentHash({ ...intent, [key]: changed[key] }), original, `${key} must change the hash`);
  }
});

test('amounts and times must be integers', () => {
  assert.throws(() => canonicalIntent({ ...intent, amountMinor: 200.5 }), /must be an integer/);
  assert.throws(() => canonicalIntent({ ...intent, amountMinor: '20000' as unknown as number }), /must be an integer/);
  assert.throws(() => canonicalIntent({ ...intent, createdAt: Number.NaN }), /must be an integer/);
});
