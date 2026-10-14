/**
 * Phase 3: the database allows exactly the documented state transitions, and
 * refuses everything else, even from a direct SQL UPDATE.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { dbSkip, startHarness, type Harness } from '../testing/harness';

const STATES = [
  'CREATED', 'AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED', 'PROVIDER_PENDING', 'PROVIDER_APPROVED', 'COMPLETED',
  'SUPERSEDED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PROVIDER_DECLINED', 'UNKNOWN_OUTCOME',
  'RECONCILIATION_REQUIRED', 'CASH_NOT_DISBURSED', 'REVERSAL_PENDING', 'REVERSED',
  'CASH_RETURN_REQUIRED', 'CASH_RETURNED',
];

/** The specification. [from, to, only for this type (null = both)] */
const ALLOWED: [string, string, 'CASH_IN' | 'CASH_OUT' | null][] = [
  ['CREATED', 'AWAITING_CUSTOMER', null],
  ['CREATED', 'SUPERSEDED', null],
  ['CREATED', 'CANCELLED', null],
  ['CREATED', 'EXPIRED', null],
  ['AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED', null],
  ['AWAITING_CUSTOMER', 'REJECTED', null],
  ['AWAITING_CUSTOMER', 'EXPIRED', null],
  ['AWAITING_CUSTOMER', 'SUPERSEDED', null],
  ['AWAITING_CUSTOMER', 'CANCELLED', null],
  ['CUSTOMER_CONFIRMED', 'PROVIDER_PENDING', null],
  ['CUSTOMER_CONFIRMED', 'REJECTED', null],
  ['CUSTOMER_CONFIRMED', 'CANCELLED', null],
  ['CUSTOMER_CONFIRMED', 'EXPIRED', null],
  ['PROVIDER_PENDING', 'PROVIDER_APPROVED', null],
  ['PROVIDER_PENDING', 'PROVIDER_DECLINED', null],
  ['PROVIDER_PENDING', 'UNKNOWN_OUTCOME', null],
  ['UNKNOWN_OUTCOME', 'PROVIDER_APPROVED', null],
  ['UNKNOWN_OUTCOME', 'PROVIDER_DECLINED', null],
  ['UNKNOWN_OUTCOME', 'RECONCILIATION_REQUIRED', null],
  ['PROVIDER_APPROVED', 'COMPLETED', null],
  ['PROVIDER_APPROVED', 'CASH_NOT_DISBURSED', 'CASH_OUT'],
  ['CASH_NOT_DISBURSED', 'REVERSAL_PENDING', 'CASH_OUT'],
  ['REVERSAL_PENDING', 'REVERSED', 'CASH_OUT'],
  ['REVERSAL_PENDING', 'RECONCILIATION_REQUIRED', 'CASH_OUT'],
  ['PROVIDER_DECLINED', 'CASH_RETURN_REQUIRED', 'CASH_IN'],
  ['CASH_RETURN_REQUIRED', 'CASH_RETURNED', 'CASH_IN'],
];

describe('transaction state machine', { skip: dbSkip }, () => {
  let h: Harness;
  let agentId: string;
  let account: Awaited<ReturnType<Harness['customer']>>;

  /** A raw transaction row (no service), optionally already expired. */
  const rawTransaction = async (opts: { expired?: boolean; state?: string } = {}) =>
    (
      await h.pool.query<{ id: string }>(
        `INSERT INTO transactions
           (id, txn_type, agent_id, customer_id, account_link_id, bank_id, amount_minor, intent_hash, nonce,
            created_at, expires_at, state)
         VALUES ($1, 'CASH_OUT', $2, $3, $4, $5, 20000, $6, $7, $8, $9, $10) RETURNING id`,
        [
          crypto.randomUUID(),
          agentId,
          account.customerId,
          account.accountLinkId,
          account.bankId,
          crypto.randomBytes(32).toString('base64url'),
          crypto.randomBytes(32).toString('hex'),
          opts.expired ? new Date(Date.now() - 20 * 60_000) : new Date(),
          opts.expired ? new Date(Date.now() - 10 * 60_000) : new Date(Date.now() + 10 * 60_000),
          opts.state ?? 'CREATED',
        ]
      )
    ).rows[0]!.id;

  before(async () => {
    h = await startHarness();
    agentId = (await h.signedIn('AGENT')).agentId!;
    account = await h.customer('Lakshmi');
  });
  after(() => h?.close());

  test('exactly the documented transitions are allowed, per transaction type', async () => {
    const { rows } = await h.pool.query<{ from_state: string; to_state: string; txn_type: string; ok: boolean }>(
      `SELECT f.s AS from_state, t.s AS to_state, ty.s AS txn_type,
              transaction_transition_allowed(f.s, t.s, ty.s) AS ok
         FROM unnest($1::text[]) f(s), unnest($1::text[]) t(s), unnest(ARRAY['CASH_IN', 'CASH_OUT']) ty(s)`,
      [STATES]
    );
    assert.equal(rows.length, STATES.length * STATES.length * 2);
    const mismatches = rows.filter((r) => {
      const expected = ALLOWED.some(([f, t, ty]) => f === r.from_state && t === r.to_state && (ty === null || ty === r.txn_type));
      return expected !== r.ok;
    });
    assert.deepEqual(mismatches, []);
  });

  test('an illegal state change is refused even by direct SQL', async () => {
    const id = await rawTransaction();
    await assert.rejects(h.pool.query(`UPDATE transactions SET state = 'COMPLETED' WHERE id = $1`, [id]), /illegal transition/);
    await h.pool.query(`UPDATE transactions SET state = 'AWAITING_CUSTOMER' WHERE id = $1`, [id]);
    await assert.rejects(h.pool.query(`UPDATE transactions SET state = 'CREATED' WHERE id = $1`, [id]), /illegal transition/);
  });

  test('a new transaction must start in CREATED', async () => {
    await assert.rejects(rawTransaction({ state: 'COMPLETED' }), /starts in CREATED/);
  });

  test('an expired transaction cannot move forward, but can expire', async () => {
    const id = await rawTransaction({ expired: true });
    await assert.rejects(
      h.pool.query(`UPDATE transactions SET state = 'AWAITING_CUSTOMER' WHERE id = $1`, [id]),
      /has expired/
    );
    await h.pool.query(`UPDATE transactions SET state = 'EXPIRED' WHERE id = $1`, [id]);
  });

  test('SUPERSEDED must point at the replacement', async () => {
    const id = await rawTransaction();
    await assert.rejects(
      h.pool.query(`UPDATE transactions SET state = 'SUPERSEDED' WHERE id = $1`, [id]),
      /requires superseded_by/
    );
  });

  test('the transition rules cannot be changed at runtime', async () => {
    await assert.rejects(
      h.pool.query(`INSERT INTO transaction_transitions VALUES ('REJECTED', 'COMPLETED', NULL)`),
      /append-only/
    );
    await assert.rejects(h.pool.query(`DELETE FROM transaction_transitions`), /append-only/);
  });
});
