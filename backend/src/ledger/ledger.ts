/**
 * Double-entry ledger (Phase 6). Debit = positive, credit = negative; the
 * database refuses any journal that does not sum to zero (0004_ledger.sql),
 * and journals and postings are append-only. Customer balances live at the
 * bank; this ledger tracks what BharatPoint must reconcile:
 *
 *   cash-out approved   Dr PROVIDER_RECEIVABLE (bank owes the agent)   Cr agent FLOAT_PENDING
 *   cash handed over    Dr agent FLOAT_PENDING                          Cr agent CASH_DRAWER
 *   cash-in credited    Dr agent CASH_DRAWER (cash taken in)            Cr agent FLOAT
 *   reversal            the mirror image of the journal it reverses
 */
import type { PoolClient } from 'pg';

type OwnerType = 'AGENT' | 'PROVIDER' | 'PLATFORM';
type Kind = 'CASH_DRAWER' | 'FLOAT' | 'FLOAT_PENDING' | 'PROVIDER_RECEIVABLE' | 'COMMISSION' | 'OPENING_EQUITY';

interface LedgerTx {
  id: string;
  txn_type: 'CASH_IN' | 'CASH_OUT';
  agent_id: string;
  bank_id: string;
  amount_minor: string | number;
}

export async function accountId(c: PoolClient, ownerType: OwnerType, ownerId: string | null, kind: Kind): Promise<string> {
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO ledger_accounts (owner_type, owner_id, kind) VALUES ($1, $2, $3)
     ON CONFLICT (owner_type, owner_id, kind) DO NOTHING RETURNING id`,
    [ownerType, ownerId, kind]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  return (
    await c.query<{ id: string }>(
      `SELECT id FROM ledger_accounts WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND kind = $3`,
      [ownerType, ownerId, kind]
    )
  ).rows[0]!.id;
}

async function postJournal(
  c: PoolClient,
  j: { transactionId: string; purpose: string; reversesJournalId?: string; postings: [string, number][] }
): Promise<string> {
  const journal = (
    await c.query<{ id: string }>(
      `INSERT INTO ledger_journals (transaction_id, purpose, reverses_journal_id) VALUES ($1, $2, $3) RETURNING id`,
      [j.transactionId, j.purpose, j.reversesJournalId ?? null]
    )
  ).rows[0]!;
  for (const [account, amountMinor] of j.postings) {
    await c.query(`INSERT INTO ledger_postings (journal_id, ledger_account_id, amount_minor) VALUES ($1, $2, $3)`, [
      journal.id,
      account,
      amountMinor,
    ]);
  }
  return journal.id;
}

/** The bank approved the transaction's money movement. */
export async function postProviderApproval(c: PoolClient, tx: LedgerTx): Promise<string> {
  const amount = Number(tx.amount_minor);
  if (tx.txn_type === 'CASH_OUT') {
    return postJournal(c, {
      transactionId: tx.id,
      purpose: 'PROVIDER_APPROVAL',
      postings: [
        [await accountId(c, 'PROVIDER', tx.bank_id, 'PROVIDER_RECEIVABLE'), amount],
        [await accountId(c, 'AGENT', tx.agent_id, 'FLOAT_PENDING'), -amount],
      ],
    });
  }
  return postJournal(c, {
    transactionId: tx.id,
    purpose: 'CASH_IN',
    postings: [
      [await accountId(c, 'AGENT', tx.agent_id, 'CASH_DRAWER'), amount],
      [await accountId(c, 'AGENT', tx.agent_id, 'FLOAT'), -amount],
    ],
  });
}

/** The agent handed the cash to the customer (cash-out only). */
export async function postHandover(c: PoolClient, tx: LedgerTx): Promise<string> {
  const amount = Number(tx.amount_minor);
  return postJournal(c, {
    transactionId: tx.id,
    purpose: 'CASH_HANDOVER',
    postings: [
      [await accountId(c, 'AGENT', tx.agent_id, 'FLOAT_PENDING'), amount],
      [await accountId(c, 'AGENT', tx.agent_id, 'CASH_DRAWER'), -amount],
    ],
  });
}

/** Mirror the bank-approval journal: the bank reversed the money movement. */
export async function postReversal(c: PoolClient, tx: LedgerTx): Promise<string> {
  const original = (
    await c.query<{ id: string }>(
      `SELECT id FROM ledger_journals WHERE transaction_id = $1 AND purpose IN ('PROVIDER_APPROVAL', 'CASH_IN')`,
      [tx.id]
    )
  ).rows[0]!;
  const postings = (
    await c.query<{ ledger_account_id: string; amount_minor: string }>(
      `SELECT ledger_account_id, amount_minor FROM ledger_postings WHERE journal_id = $1`,
      [original.id]
    )
  ).rows.map((p): [string, number] => [p.ledger_account_id, -Number(p.amount_minor)]);
  return postJournal(c, { transactionId: tx.id, purpose: 'REVERSAL', reversesJournalId: original.id, postings });
}
