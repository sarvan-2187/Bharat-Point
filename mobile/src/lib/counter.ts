/**
 * The agent's counter: customer lookup, transactions and cash events.
 * See backend/src/{customers,transactions,confirmation,cash}/routes.ts.
 *
 * Every money step is signed on this phone, behind its biometric prompt, over
 * the transaction's intent hash, and the server checks each signature. The
 * server decides every state; this file only asks and displays.
 */
import { api } from './api';
import { cashReturnedMessage, handoverFailedMessage, handoverMessage, intentMessage, signWithDeviceKey } from './device-key';

export type TxnType = 'CASH_IN' | 'CASH_OUT';

export interface Account {
  accountLinkId: string;
  bankCode: string;
  bankName: string;
  maskedLabel: string;
}

export interface CustomerMatch {
  customerId: string;
  displayName: string;
  reachable: boolean; // false: the IVR has no number to ring, so they cannot confirm
  accounts: Account[];
}

export interface Tx {
  id: string;
  txnType: TxnType;
  amountMinor: number;
  state: string;
  failureCode: string | null;
  customerId: string;
  customerName: string;
  accountLabel: string;
  intentHash: string;
  agentSigned: boolean;
  createdAt: string;
  expiresAt: string;
  supersededBy: string | null;
  confirmation: {
    status: string;
    mode: string;
    expiresAt: string;
    dial: number | null;
    callState: string | null;
  } | null;
}

export interface SignedReceipt {
  receipt: {
    transactionId: string;
    txnType: TxnType;
    amountMinor: number;
    state: string;
    customerName: string;
    accountLabel: string;
    agentCode: string;
    agentLocation: string;
    bankCode: string;
    bankRef: string | null;
    issuedAt: string;
    simulated: boolean;
  };
  signature: string;
  keyId: string;
}

/** States the server will never move out of: stop polling. */
export const FINAL_STATES = new Set([
  'COMPLETED',
  'SUPERSEDED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'PROVIDER_DECLINED',
  'RECONCILIATION_REQUIRED',
  'REVERSED',
  'CASH_RETURNED',
]);
export const RECEIPT_STATES = new Set(['COMPLETED', 'REVERSED', 'CASH_RETURNED']);

export const TXN_LABEL: Record<TxnType, string> = { CASH_OUT: 'Cash-out', CASH_IN: 'Cash-in' };

/** Why it stopped, in words the agent can say to the customer. */
export const FAILURE_TEXT: Record<string, string> = {
  AMOUNT_MISMATCH: 'The customer keyed a different amount.',
  CUSTOMER_DECLINED: 'The customer declined on the call.',
  INVALID_INPUT: 'The customer did not key a valid answer.',
  NO_ANSWER: 'The customer did not answer the call.',
  CONFIRMATION_EXPIRED: 'The customer did not confirm in time.',
  INSUFFICIENT_FUNDS: 'Not enough money in the account.',
  SIMULATED_DECLINE: 'The bank declined (demo fault switch).',
  PROVIDER_NO_ANSWER: 'The bank never answered. The bank will check it manually.',
  REVERSAL_DECLINED: 'The bank refused the refund. The bank will check it manually.',
  CHAIN_INCOMPLETE: 'The approval record is incomplete, so nothing was sent to the bank.',
  LIMIT_EXCEEDED: "Over this agent's daily limit, so nothing was sent to the bank.",
  AGENT_SUSPENDED: 'This agent was suspended, so nothing was sent to the bank.',
};

export const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN')}`;
export const stateLabel = (state: string) => state.charAt(0) + state.slice(1).replace(/_/g, ' ').toLowerCase();

const V1 = '/api/v1';
const post = <T>(path: string, body: unknown = {}) => api<T>(`${V1}${path}`, { method: 'POST', body: JSON.stringify(body) });

export const findCustomers = async (phone: string) =>
  (await api<{ customers: CustomerMatch[] }>(`${V1}/customers?phone=${encodeURIComponent(phone)}`)).customers;
export const listTransactions = async () => (await api<{ transactions: Tx[] }>(`${V1}/transactions`)).transactions;
export const getTransaction = (id: string) => api<Tx>(`${V1}/transactions/${id}`);
export const getReceipt = (id: string) => api<SignedReceipt>(`${V1}/transactions/${id}/receipt`);

export const createTransaction = (input: { txnType: TxnType; amountMinor: number; customerId: string; accountLinkId: string }) =>
  post<Tx>('/transactions', input);
export const cancelTransaction = (id: string) => post<Tx>(`/transactions/${id}/cancel`);
/** Ring the customer for their confirmation (the IVR call). */
export const callCustomer = (id: string) => post(`/transactions/${id}/confirmation`);

const signed = async (tx: Tx, message: (hash: string) => string, reason: string) => ({
  signature: await signWithDeviceKey(message(tx.intentHash), reason),
});

/** "I entered exactly this transaction." */
export const signTransaction = async (tx: Tx) =>
  post<Tx>(`/transactions/${tx.id}/sign`, await signed(tx, intentMessage, `Sign ${TXN_LABEL[tx.txnType]} of ${rupees(tx.amountMinor)}`));
/** Cash-out: the cash is in the customer's hand. */
export const handOver = async (tx: Tx) =>
  post<Tx>(`/transactions/${tx.id}/handover`, await signed(tx, handoverMessage, `Confirm you handed over ${rupees(tx.amountMinor)}`));
/** Cash-out: the cash could not be paid; the bank debit is reversed. */
export const cashNotPaid = async (tx: Tx) =>
  post<Tx>(`/transactions/${tx.id}/handover-failed`, await signed(tx, handoverFailedMessage, `Confirm ${rupees(tx.amountMinor)} was NOT paid`));
/** Declined cash-in: the cash went back to the customer. */
export const cashReturned = async (tx: Tx) =>
  post<Tx>(`/transactions/${tx.id}/cash-returned`, await signed(tx, cashReturnedMessage, `Confirm you gave back ${rupees(tx.amountMinor)}`));
