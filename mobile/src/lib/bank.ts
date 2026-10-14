/**
 * The bank operations console's calls. See backend/src/provider/routes.ts.
 * Transactions come from the shared /transactions list, which the server
 * already scopes to this operator's bank. Fault switches exist only when the
 * backend runs with DEMO_MODE=true (otherwise 404).
 */
import { api } from './api';

export type FaultMode = 'DECLINE' | 'ERROR_BEFORE_COMMIT' | 'TIMEOUT_AFTER_COMMIT';

export interface Fault {
  mode: FaultMode | null;
  count: number;
}

export const FAULT_LABEL: Record<FaultMode, string> = {
  DECLINE: 'Decline',
  ERROR_BEFORE_COMMIT: 'Error before saving',
  TIMEOUT_AFTER_COMMIT: 'Answer too late',
};

/** Where a transaction sits from the bank's side. */
export type Section = 'INCOMING' | 'REVERSALS' | 'RECONCILIATION' | 'DONE';

const INCOMING = new Set(['CUSTOMER_CONFIRMED', 'PROVIDER_PENDING', 'UNKNOWN_OUTCOME', 'PROVIDER_APPROVED', 'CASH_NOT_DISBURSED']);
const REVERSALS = new Set(['REVERSAL_PENDING', 'REVERSED']);
const AUTHORIZING = new Set(['CREATED', 'AWAITING_CUSTOMER']);

export const sectionOf = (state: string): Section | null =>
  state === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION' : REVERSALS.has(state) ? 'REVERSALS' : INCOMING.has(state) ? 'INCOMING' : AUTHORIZING.has(state) ? null : 'DONE';

export const getFault = () => api<Fault>('/api/v1/bank/sim/faults');
export const setFault = (mode: FaultMode | null, count = 1) =>
  api<Fault>('/api/v1/bank/sim/faults', { method: 'POST', body: JSON.stringify({ mode, count }) });
