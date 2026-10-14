/**
 * The transaction intent hash. Adapted from PRISM@680037b (utils/canonical.ts).
 *
 *   canonical(intent) -> fixed, sorted field order, integers only, no whitespace
 *   sha256(utf8)      -> base64url  =  transactions.intent_hash
 *
 * Every field that defines "what the customer is agreeing to" is inside it:
 * type, amount, customer, account, bank, agent, and the transaction's own
 * id, nonce and lifetime. Change any one and the hash changes, so every
 * signature and approval bound to the old hash stops matching.
 *
 * The server computes it; clients only ever receive it.
 */
import crypto from 'crypto';

export interface LockedIntent {
  accountLinkId: string;
  agentId: string;
  amountMinor: number; // paise
  bankId: string;
  createdAt: number; // epoch seconds
  customerId: string;
  expiresAt: number; // epoch seconds
  nonce: string;
  txId: string;
  txnType: 'CASH_IN' | 'CASH_OUT';
}

/** Field order IS the hash. Sorted ASCII-ascending. */
const FIELDS: (keyof LockedIntent)[] = [
  'accountLinkId',
  'agentId',
  'amountMinor',
  'bankId',
  'createdAt',
  'customerId',
  'expiresAt',
  'nonce',
  'txId',
  'txnType',
];

const INTEGER_FIELDS: (keyof LockedIntent)[] = ['amountMinor', 'createdAt', 'expiresAt'];

export function canonicalIntent(intent: LockedIntent): string {
  for (const field of INTEGER_FIELDS) {
    if (!Number.isSafeInteger(intent[field])) {
      throw new Error(`canonicalIntent: ${field} must be an integer, got ${String(intent[field])}`);
    }
  }
  return `{${FIELDS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(intent[k])}`).join(',')}}`;
}

export const intentHash = (intent: LockedIntent) =>
  crypto.createHash('sha256').update(canonicalIntent(intent), 'utf8').digest('base64url');

/** The intent as stored in a transactions row (BIGINT arrives from pg as a string). */
export function intentFromRow(row: {
  id: string;
  txn_type: 'CASH_IN' | 'CASH_OUT';
  agent_id: string;
  customer_id: string;
  account_link_id: string;
  bank_id: string;
  amount_minor: string | number;
  nonce: string;
  created_at: Date;
  expires_at: Date;
}): LockedIntent {
  return {
    accountLinkId: row.account_link_id,
    agentId: row.agent_id,
    amountMinor: Number(row.amount_minor),
    bankId: row.bank_id,
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    customerId: row.customer_id,
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    nonce: row.nonce,
    txId: row.id,
    txnType: row.txn_type,
  };
}

/** Timing-safe comparison of two hashes (or MACs) of possibly different lengths. */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}
