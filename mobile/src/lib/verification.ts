/**
 * Didit Verification client for the BharatPoint Expo Go mobile application.
 *
 * Talks to backend /api/verification/*, /api/verify, and /api/mock-transactions/* endpoints.
 * Never stores or exposes Didit API keys or secrets on the mobile client.
 */
import { api } from './api';

let nativeStartVerification: ((sessionToken: string) => Promise<void>) | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require('@didit-protocol/sdk-react-native');
  nativeStartVerification = sdk.startVerification;
} catch {
  // TurboModuleRegistry not found (e.g. standard Expo Go or unsupported runtime)
}

export const DiditSdk = {
  async startVerification(sessionToken: string): Promise<void> {
    if (nativeStartVerification) {
      await nativeStartVerification(sessionToken);
    }
  },
};

export type VerificationStatus =
  | 'Not Started'
  | 'Pending'
  | 'In Progress'
  | 'Awaiting User'
  | 'In Review'
  | 'Approved'
  | 'Declined'
  | 'Resubmitted'
  | 'Abandoned'
  | 'Expired'
  | 'Kyc Expired';

export interface VerificationSessionResponse {
  sessionId: string;
  session_id?: string;
  sessionToken?: string;
  session_token?: string;
  url: string;
  verificationUrl: string;
  status: VerificationStatus;
  transactionId: string;
  customerId: string;
  amountMinor: number;
}

export interface VerificationStatusResponse {
  sessionId: string;
  status: VerificationStatus;
  verificationUrl: string;
  transactionId: string;
  customerId: string;
  amountMinor: number;
  updatedAt: string;
}

export interface MockReceiptData {
  transactionId: string;
  txnType: 'CASH_IN' | 'CASH_OUT';
  amountMinor: number;
  state: 'COMPLETED';
  customerName: string;
  accountLabel: string;
  verificationMethod: 'DIDIT_FACE_VERIFICATION';
  verificationSessionId: string;
  verifiedAt: string;
  issuedAt: string;
  simulated: boolean;
  signature: string;
}

export interface CompleteMockTransactionResponse {
  success: boolean;
  receipt: MockReceiptData;
}

/**
 * Creates a server-bound Didit verification session for a transaction and customer.
 */
export async function createVerificationSession(params: {
  transactionId: string;
  customerId: string;
  amountMinor: number;
  workflowId?: string;
}): Promise<VerificationSessionResponse> {
  const res = await api<VerificationSessionResponse>('/api/verification/session', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return {
    ...res,
    sessionToken: res.sessionToken || res.session_token,
    sessionId: res.sessionId || res.session_id || '',
    verificationUrl: res.verificationUrl || res.url,
  };
}

/**
 * Polls or refreshes the server-verified status of a Didit session.
 * The server never trusts a client-supplied status.
 */
export async function getVerificationStatus(sessionId: string, customerId?: string): Promise<VerificationStatusResponse> {
  const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
  return api<VerificationStatusResponse>(`/api/verification/status/${encodeURIComponent(sessionId)}${query}`);
}

/**
 * Requests the backend to verify the Didit session outcome and complete the mock transaction.
 * Idempotent: rejects duplicate completion.
 */
export async function completeMockTransaction(
  transactionId: string,
  amountMinor: number,
  customerId?: string
): Promise<CompleteMockTransactionResponse> {
  return api<CompleteMockTransactionResponse>(`/api/mock-transactions/${encodeURIComponent(transactionId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ amountMinor, customerId }),
  });
}
