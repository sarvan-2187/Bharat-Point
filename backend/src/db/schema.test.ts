/**
 * Phase 1: proves the database itself refuses the dangerous writes, so no
 * application bug can perform them.
 *
 * Runs against a fresh, throwaway database created from DATABASE_URL and
 * dropped afterwards. Reported as SKIPPED (not passed) when DATABASE_URL is
 * not set: start Postgres with `docker compose up -d` to run it.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { migrate } from './migrate';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set; start Postgres to run the schema tests';

type Row = Record<string, unknown> & { id: string };

describe('schema guarantees', { skip }, () => {
  const dbName = `bp_test_${crypto.randomBytes(4).toString('hex')}`;
  let admin: Pool;
  let db: Pool;
  let f: Awaited<ReturnType<typeof fixtures>>;

  const one = async (sql: string, params: unknown[] = []): Promise<Row> =>
    (await db.query(sql, params)).rows[0] as Row;

  async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async function fixtures() {
    const bank = await one(`INSERT INTO banks (code, display_name) VALUES ('DEMO-SBI', 'Demo State Bank') RETURNING id`);
    const agentUser = await one(
      `INSERT INTO users (staff_code, display_name, role) VALUES ('AG-001', 'Ravi', 'AGENT') RETURNING id`
    );
    const adminUser = await one(
      `INSERT INTO users (staff_code, display_name, role) VALUES ('AD-001', 'Meena', 'ADMIN') RETURNING id`
    );
    const agent = await one(
      `INSERT INTO agents (user_id, agent_code, location_name) VALUES ($1, 'AG-001', 'Kothapalli') RETURNING id`,
      [agentUser.id]
    );
    const customer = async (name: string) =>
      one(`INSERT INTO customers (display_name, phone_enc, phone_lookup) VALUES ($1, '\\x00', $2) RETURNING id`, [
        name,
        crypto.createHash('sha256').update(name).digest('hex'),
      ]);
    const lakshmi = await customer('Lakshmi');
    const suresh = await customer('Suresh');
    const link = (c: Row, token: string) =>
      one(
        `INSERT INTO customer_account_links (customer_id, bank_id, provider_token, masked_label)
         VALUES ($1, $2, $3, 'Demo SBI ....4321') RETURNING id`,
        [c.id, bank.id, token]
      );
    return {
      bank,
      agentUser,
      adminUser,
      agent,
      lakshmi,
      suresh,
      lakshmiLink: await link(lakshmi, 'tok-lakshmi'),
      sureshLink: await link(suresh, 'tok-suresh'),
    };
  }

  /** A CASH_OUT for Lakshmi; override any column. */
  const newTransaction = (over: Record<string, unknown> = {}) => {
    const cols = {
      id: crypto.randomUUID(),
      txn_type: 'CASH_OUT',
      agent_id: f.agent.id,
      customer_id: f.lakshmi.id,
      account_link_id: f.lakshmiLink.id,
      bank_id: f.bank.id,
      amount_minor: 20000,
      intent_hash: crypto.randomBytes(32).toString('base64url'),
      nonce: crypto.randomBytes(32).toString('hex'),
      ...over,
    };
    const keys = Object.keys(cols);
    return one(
      `INSERT INTO transactions (${keys.join(', ')}, expires_at)
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, NOW() + interval '5 minutes') RETURNING id`,
      Object.values(cols)
    );
  };

  const newAuthorization = (txId: string, expiresIn = "interval '3 minutes'") =>
    one(
      `INSERT INTO transaction_authorizations (transaction_id, channel, mode, binding_hash, created_at, expires_at)
       VALUES ($1, 'SIMULATOR', 'BLIND_ENTRY', 'b', NOW() - interval '10 minutes', NOW() + ${expiresIn}) RETURNING id`,
      [txId]
    );

  before(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const testUrl = new URL(url!);
    testUrl.pathname = `/${dbName}`;
    db = new Pool({ connectionString: testUrl.toString() });
    await migrate(db, () => {});
    f = await fixtures();
  });

  after(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  test('audit_logs is append-only', async () => {
    const row = await one(`INSERT INTO audit_logs (event_type) VALUES ('TEST') RETURNING id`);
    await assert.rejects(db.query(`UPDATE audit_logs SET event_type = 'X' WHERE id = $1`, [row.id]), /append-only/);
    await assert.rejects(db.query(`DELETE FROM audit_logs WHERE id = $1`, [row.id]), /append-only/);
  });

  test('a bank operator has exactly one bank, and nobody else has one', async () => {
    await assert.rejects(
      db.query(`INSERT INTO users (staff_code, display_name, role) VALUES ('BO-X', 'X', 'BANK_OPERATOR')`),
      /bank_operator_has_one_bank/
    );
    await assert.rejects(
      db.query(`INSERT INTO users (staff_code, display_name, role, bank_id) VALUES ('AG-X', 'X', 'AGENT', $1)`, [
        f.bank.id,
      ]),
      /bank_operator_has_one_bank/
    );
  });

  test('only an AGENT user can be an agent, and that role is then pinned', async () => {
    await assert.rejects(
      db.query(`INSERT INTO agents (user_id, agent_code, location_name) VALUES ($1, 'AG-X', 'X')`, [f.adminUser.id]),
      /foreign key/
    );
    await assert.rejects(db.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [f.agentUser.id]), /foreign key/);
  });

  test("a transaction's locked fields cannot change, but its state can", async () => {
    const tx = await newTransaction();
    await assert.rejects(
      db.query(`UPDATE transactions SET amount_minor = 50000 WHERE id = $1`, [tx.id]),
      /locked fields cannot change/
    );
    await assert.rejects(
      db.query(`UPDATE transactions SET txn_type = 'CASH_IN' WHERE id = $1`, [tx.id]),
      /locked fields cannot change/
    );
    await db.query(`UPDATE transactions SET state = 'AWAITING_CUSTOMER' WHERE id = $1`, [tx.id]);
    await assert.rejects(db.query(`DELETE FROM transactions WHERE id = $1`, [tx.id]), /append-only/);
  });

  test('amounts are whole rupees, stored in paise', async () => {
    await assert.rejects(newTransaction({ amount_minor: 20050 }), /check constraint/);
    await assert.rejects(newTransaction({ amount_minor: 0 }), /check constraint/);
  });

  test("the account must belong to the transaction's customer", async () => {
    await assert.rejects(newTransaction({ account_link_id: f.sureshLink.id }), /foreign key/);
  });

  test('a blind-entry approval must carry the exact agent amount', async () => {
    const tx = await newTransaction({ amount_minor: 20000 });
    const auth = await newAuthorization(tx.id);
    const approve = (keyed: number) =>
      db.query(
        `UPDATE transaction_authorizations
            SET status = 'APPROVED', customer_keyed_minor = $2, decided_at = NOW()
          WHERE id = $1`,
        [auth.id, keyed]
      );
    await assert.rejects(approve(50000), /keyed amount does not match/);
    await approve(20000);
  });

  test('a decided authorization can never be re-decided', async () => {
    const tx = await newTransaction();
    const auth = await newAuthorization(tx.id);
    await db.query(
      `UPDATE transaction_authorizations SET status = 'REJECTED', decided_at = NOW() WHERE id = $1`,
      [auth.id]
    );
    await assert.rejects(
      db.query(
        `UPDATE transaction_authorizations
            SET status = 'APPROVED', customer_keyed_minor = 20000 WHERE id = $1`,
        [auth.id]
      ),
      /already decided/
    );
  });

  test('an expired authorization cannot be approved', async () => {
    const tx = await newTransaction();
    const auth = await newAuthorization(tx.id, "interval '-1 minute'");
    await assert.rejects(
      db.query(
        `UPDATE transaction_authorizations
            SET status = 'APPROVED', customer_keyed_minor = 20000, decided_at = NOW() WHERE id = $1`,
        [auth.id]
      ),
      /expired/
    );
  });

  test('at most one live confirmation request per transaction', async () => {
    const tx = await newTransaction();
    await newAuthorization(tx.id);
    await assert.rejects(newAuthorization(tx.id), /uq_authorization_pending/);
  });

  test('chain steps and transaction events are append-only', async () => {
    const tx = await newTransaction();
    const step = await one(
      `INSERT INTO authorization_steps (transaction_id, attempt, seq, stage, payload, prev_hash, row_hash, mac)
       VALUES ($1, 1, 0, 'INTENT_LOCKED', '{}', 'p', $2, 'm') RETURNING id`,
      [tx.id, crypto.randomUUID()]
    );
    await assert.rejects(db.query(`UPDATE authorization_steps SET mac = 'x' WHERE id = $1`, [step.id]), /append-only/);
    const ev = await one(
      `INSERT INTO transaction_events (transaction_id, to_state, actor_kind) VALUES ($1, 'CREATED', 'SYSTEM') RETURNING id`,
      [tx.id]
    );
    await assert.rejects(db.query(`DELETE FROM transaction_events WHERE id = $1`, [ev.id]), /append-only/);
  });

  test('a settlement capability is consumed exactly once and is otherwise immutable', async () => {
    const tx = await newTransaction();
    const cap = () =>
      one(
        `INSERT INTO settlement_capabilities (transaction_id, attempt, intent_hash, chain_tip_hash, required_stages, mac, expires_at)
         VALUES ($1, 1, 'h', 't', ARRAY['INTENT_LOCKED'], 'm', NOW() + interval '90 seconds') RETURNING id`,
        [tx.id]
      );
    const a = await cap();
    await db.query(`UPDATE settlement_capabilities SET consumed_at = NOW() WHERE id = $1`, [a.id]);
    await assert.rejects(
      db.query(`UPDATE settlement_capabilities SET consumed_at = NOW() WHERE id = $1`, [a.id]),
      /already consumed/
    );
    const b = await cap();
    await assert.rejects(
      db.query(`UPDATE settlement_capabilities SET mac = 'forged' WHERE id = $1`, [b.id]),
      /only allowed change is consuming it/
    );
  });

  test('a provider request is unique per transaction and final once decided', async () => {
    const tx = await newTransaction();
    const req = await one(
      `INSERT INTO provider_requests (transaction_id, kind, request_id) VALUES ($1, 'DEBIT', $2) RETURNING id`,
      [tx.id, `debit:${tx.id}`]
    );
    await assert.rejects(
      db.query(`INSERT INTO provider_requests (transaction_id, kind, request_id) VALUES ($1, 'DEBIT', 'other')`, [tx.id]),
      /unique/
    );
    await db.query(`UPDATE provider_requests SET state = 'UNKNOWN' WHERE id = $1`, [req.id]);
    await db.query(`UPDATE provider_requests SET state = 'APPROVED' WHERE id = $1`, [req.id]);
    await assert.rejects(db.query(`UPDATE provider_requests SET state = 'DECLINED' WHERE id = $1`, [req.id]), /final/);
  });

  describe('ledger', () => {
    let drawer: Row;
    let equity: Row;

    before(async () => {
      drawer = await one(
        `INSERT INTO ledger_accounts (owner_type, owner_id, kind) VALUES ('AGENT', $1, 'CASH_DRAWER') RETURNING id`,
        [f.agent.id]
      );
      equity = await one(
        `INSERT INTO ledger_accounts (owner_type, kind) VALUES ('PLATFORM', 'OPENING_EQUITY') RETURNING id`
      );
    });

    const journalWith = (amounts: number[]) =>
      inTx(async (c) => {
        const j = (await c.query(`INSERT INTO ledger_journals (purpose) VALUES ('OPENING') RETURNING id`)).rows[0];
        for (const [i, amt] of amounts.entries()) {
          await c.query(`INSERT INTO ledger_postings (journal_id, ledger_account_id, amount_minor) VALUES ($1, $2, $3)`, [
            j.id,
            i % 2 === 0 ? drawer.id : equity.id,
            amt,
          ]);
        }
      });

    test('a balanced journal commits', async () => {
      await journalWith([1_000_000, -1_000_000]);
    });

    test('an unbalanced journal is rejected at commit', async () => {
      await assert.rejects(journalWith([10_000, -5_000]), /unbalanced/);
    });

    test('a journal with no postings is rejected', async () => {
      await assert.rejects(journalWith([]), /unbalanced/);
    });

    test('postings cannot be added to an already committed journal', async () => {
      await journalWith([500, -500]);
      const old = await one(`SELECT id FROM ledger_journals ORDER BY created_at DESC LIMIT 1`);
      await assert.rejects(
        inTx(async (c) => {
          await c.query(`INSERT INTO ledger_postings (journal_id, ledger_account_id, amount_minor) VALUES ($1, $2, 100)`, [
            old.id,
            drawer.id,
          ]);
          await c.query(`INSERT INTO ledger_postings (journal_id, ledger_account_id, amount_minor) VALUES ($1, $2, -100)`, [
            old.id,
            equity.id,
          ]);
        }),
        /not created in this transaction/
      );
    });

    test('postings are immutable', async () => {
      const p = await one(`SELECT id FROM ledger_postings LIMIT 1`);
      await assert.rejects(db.query(`UPDATE ledger_postings SET amount_minor = 1 WHERE id = $1`, [p.id]), /append-only/);
    });
  });
});