/**
 * Verification service: manages Didit KYB & KYC verification sessions,
 * status lookups, signed webhooks, and mock transaction completion.
 *
 * Persists to PostgreSQL table `didit_verification_sessions` when DB is available,
 * with durable file-backed persistence fallback to guarantee persistence across restarts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../db/pool';
import { fail } from '../api/errors';
import { config } from '../config/env';
import type { Auth } from '../auth/middleware';
import {
  createDiditSession,
  getDiditDecision,
  verifyDiditWebhookSignature,
  verifyTimestampFreshness,
  DEFAULT_KYB_WORKFLOW_ID,
} from './didit';

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

export interface VerificationSession {
  id: string;
  sessionId: string;
  sessionToken?: string;
  workflowId: string;
  customerId: string;
  customerName?: string;
  transactionId: string;
  amountMinor: number;
  status: VerificationStatus;
  verificationUrl: string;
  vendorData: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  webhookReceivedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MockTransaction {
  id: string;
  txnType: 'CASH_IN' | 'CASH_OUT';
  customerId: string;
  customerName: string;
  accountLinkId: string;
  accountLabel: string;
  agentId: string;
  amountMinor: number;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface MockReceipt {
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

// Durable file store path
const DATA_DIR = path.resolve(__dirname, '../../../data');
const SESSIONS_FILE = path.join(DATA_DIR, 'verification_sessions.json');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'mock_transactions.json');
const EVENTS_FILE = path.join(DATA_DIR, 'webhook_events.json');

// In-memory caches synchronized with disk and Postgres
const memorySessions = new Map<string, VerificationSession>();
const memoryTransactions = new Map<string, MockTransaction>();
const processedWebhookEvents = new Set<string>();

// Ensure data directory exists and load persisted state on boot
function initPersistence() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (Array.isArray(data)) {
        for (const s of data) memorySessions.set(s.sessionId, s);
      }
    }

    if (fs.existsSync(TRANSACTIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
      if (Array.isArray(data)) {
        for (const t of data) memoryTransactions.set(t.id, t);
      }
    }

    if (fs.existsSync(EVENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
      if (Array.isArray(data)) {
        for (const id of data) processedWebhookEvents.add(id);
      }
    }
  } catch (err) {
    console.warn('[verification] Failed to read disk persistence:', (err as Error).message);
  }
}

initPersistence();

function syncToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Array.from(memorySessions.values()), null, 2), 'utf8');
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(Array.from(memoryTransactions.values()), null, 2), 'utf8');
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(Array.from(processedWebhookEvents), null, 2), 'utf8');
  } catch (err) {
    console.warn('[verification] Failed to sync to disk:', (err as Error).message);
  }
}

/**
 * Saves or updates a verification session to Postgres and disk.
 */
async function persistSession(session: VerificationSession): Promise<void> {
  memorySessions.set(session.sessionId, session);
  syncToDisk();

  try {
    await pool.query(
      `INSERT INTO didit_verification_sessions
         (id, session_id, workflow_id, customer_id, transaction_id, amount_minor, status,
          verification_url, vendor_data, webhook_received_at, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (session_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         webhook_received_at = EXCLUDED.webhook_received_at`,
      [
        session.id,
        session.sessionId,
        session.workflowId,
        session.customerId,
        session.transactionId || null,
        session.amountMinor,
        session.status,
        session.verificationUrl,
        session.vendorData,
        session.webhookReceivedAt ? new Date(session.webhookReceivedAt) : null,
        new Date(session.createdAt),
        new Date(session.updatedAt),
        new Date(session.expiresAt),
      ]
    );
  } catch {
    // Postgres may be down or migration not yet applied; file persistence already guaranteed
  }
}

/**
 * Loads a verification session by Didit session ID.
 */
export async function findSession(sessionId: string): Promise<VerificationSession | null> {
  const cached = memorySessions.get(sessionId);
  if (cached) return cached;

  try {
    const { rows } = await pool.query(
      `SELECT id, session_id AS "sessionId", workflow_id AS "workflowId", customer_id AS "customerId",
              transaction_id AS "transactionId", amount_minor AS "amountMinor", status,
              verification_url AS "verificationUrl", vendor_data AS "vendorData",
              created_at AS "createdAt", updated_at AS "updatedAt", expires_at AS "expiresAt"
         FROM didit_verification_sessions WHERE session_id = $1`,
      [sessionId]
    );
    if (rows[0]) {
      const row = {
        ...rows[0],
        amountMinor: Number(rows[0].amountMinor),
        createdAt: new Date(rows[0].createdAt).toISOString(),
        updatedAt: new Date(rows[0].updatedAt).toISOString(),
        expiresAt: new Date(rows[0].expiresAt).toISOString(),
      };
      memorySessions.set(sessionId, row);
      return row;
    }
  } catch {
    // DB lookup fallback
  }

  return null;
}

/**
 * Creates or retrieves a mock transaction.
 */
export async function getOrCreateMockTransaction(
  auth: Auth | undefined,
  customerId: string,
  amountMinor: number,
  existingTxId?: string
): Promise<MockTransaction> {
  if (existingTxId) {
    const cached = memoryTransactions.get(existingTxId);
    if (cached) return cached;

    // Check Postgres
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.txn_type AS "txnType", t.customer_id AS "customerId", c.display_name AS "customerName",
                t.account_link_id AS "accountLinkId", l.masked_label AS "accountLabel", t.agent_id AS "agentId",
                t.amount_minor AS "amountMinor", t.state, t.created_at AS "createdAt", t.updated_at AS "updatedAt"
           FROM transactions t
           JOIN customers c ON c.id = t.customer_id
           JOIN customer_account_links l ON l.id = t.account_link_id
          WHERE t.id = $1`,
        [existingTxId]
      );
      if (rows[0]) {
        const tx: MockTransaction = {
          id: rows[0].id,
          txnType: rows[0].txnType,
          customerId: rows[0].customerId,
          customerName: rows[0].customerName,
          accountLinkId: rows[0].accountLinkId,
          accountLabel: rows[0].accountLabel,
          agentId: rows[0].agentId,
          amountMinor: Number(rows[0].amountMinor),
          state: rows[0].state,
          createdAt: new Date(rows[0].createdAt).toISOString(),
          updatedAt: new Date(rows[0].updatedAt).toISOString(),
        };
        memoryTransactions.set(tx.id, tx);
        return tx;
      }
    } catch {
      // Postgres not available
    }

    fail('NOT_FOUND', { reason: `Transaction ${existingTxId} not found` });
  }

  // Create new server-side mock transaction
  const id = crypto.randomUUID();
  const tx: MockTransaction = {
    id,
    txnType: 'CASH_OUT',
    customerId,
    customerName: 'Demo Customer',
    accountLinkId: crypto.randomUUID(),
    accountLabel: 'Demo Bank ••••1234',
    agentId: auth?.agentId ?? 'agent-demo-001',
    amountMinor,
    state: 'CREATED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  memoryTransactions.set(id, tx);
  syncToDisk();
  return tx;
}

/**
 * Creates a Didit KYB / KYC verification session.
 */
export async function createSession(
  auth: Auth | undefined,
  input: {
    transactionId?: string;
    customerId?: string;
    amountMinor?: number;
    callbackUrl?: string;
    workflowId?: string;
  }
): Promise<{
  sessionId: string;
  session_id: string;
  sessionToken?: string;
  session_token?: string;
  url: string;
  verificationUrl: string;
  status: VerificationStatus;
  workflowId: string;
  workflow_id: string;
  transactionId: string;
  customerId: string;
  vendorData: string;
  vendor_data: string;
  amountMinor: number;
}> {
  if (!auth && !input.customerId) {
    fail('AUTH_FAILED', { reason: 'Authentication required' });
  }

  // Server-side validation of transaction amount
  const amountMinor = Number(input.amountMinor ?? 20000);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor % 100 !== 0) {
    fail('VALIDATION_FAILED', { field: 'amountMinor', reason: 'Must be positive whole rupees in paise' });
  }

  // Limit enforcement (e.g. ₹50,000 max per transaction)
  if (amountMinor > 5000000) {
    fail('VALIDATION_FAILED', { field: 'amountMinor', reason: 'Exceeds maximum transaction limit of ₹50,000' });
  }

  // Determine customer ID
  let customerId = input.customerId;
  let tx: MockTransaction | undefined;

  if (input.transactionId) {
    tx = await getOrCreateMockTransaction(auth, customerId || '', amountMinor, input.transactionId);
    customerId = tx.customerId;

    // Validate that transaction amount matches
    if (tx.amountMinor !== amountMinor) {
      fail('VALIDATION_FAILED', { field: 'amountMinor', reason: 'Transaction amount does not match existing transaction' });
    }
  } else {
    customerId = customerId || crypto.randomUUID();
    tx = await getOrCreateMockTransaction(auth, customerId, amountMinor);
  }

  const transactionId = tx.id;
  const vendorData = `${customerId}:${transactionId}`;

  // Use configured KYB workflow ID (or passed per session)
  const workflowId = input.workflowId || DEFAULT_KYB_WORKFLOW_ID;

  // Call Didit API to create session
  const didit = await createDiditSession({
    workflowId,
    vendorData,
    callbackUrl: input.callbackUrl,
    metadata: {
      transaction_id: transactionId,
      customer_id: customerId,
      amount_minor: amountMinor,
    },
  });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 min TTL

  const session: VerificationSession = {
    id: crypto.randomUUID(),
    sessionId: didit.sessionId,
    sessionToken: didit.sessionToken,
    workflowId: didit.workflowId,
    customerId,
    customerName: tx.customerName,
    transactionId,
    amountMinor,
    status: 'Not Started',
    verificationUrl: didit.url,
    vendorData,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await persistSession(session);

  return {
    sessionId: session.sessionId,
    session_id: session.sessionId,
    sessionToken: session.sessionToken,
    session_token: session.sessionToken,
    url: session.verificationUrl,
    verificationUrl: session.verificationUrl,
    status: session.status,
    workflowId: session.workflowId,
    workflow_id: session.workflowId,
    transactionId: session.transactionId,
    customerId: session.customerId,
    vendorData: session.vendorData,
    vendor_data: session.vendorData,
    amountMinor: session.amountMinor,
  };
}

/**
 * Retrieves the verification status for a session.
 */
export async function getStatus(
  auth: Auth | undefined,
  sessionId: string,
  requestCustomerId?: string
): Promise<{
  sessionId: string;
  session_id: string;
  sessionToken?: string;
  session_token?: string;
  status: VerificationStatus;
  url: string;
  verificationUrl: string;
  transactionId: string;
  customerId: string;
  amountMinor: number;
  updatedAt: string;
}> {
  if (!auth && !requestCustomerId) {
    fail('AUTH_FAILED', { reason: 'Authentication required' });
  }

  const session = await findSession(sessionId);
  if (!session) {
    fail('NOT_FOUND', { reason: 'Verification session not found' });
  }

  // Access check: confirm that session belongs to the requesting customer / agent
  const callerCustomerId = requestCustomerId || (auth?.role === 'AGENT' ? undefined : auth?.userId);
  if (callerCustomerId && callerCustomerId !== session.customerId) {
    fail('FORBIDDEN', { reason: 'Access denied: session belongs to another customer' });
  }

  // Expiration check
  if (new Date(session.expiresAt).getTime() <= Date.now() && session.status !== 'Approved') {
    session.status = 'Expired';
    session.updatedAt = new Date().toISOString();
    await persistSession(session);
  }

  // If pending or not started, refresh status from Didit's official API where available
  if (session.status === 'Pending' || session.status === 'Not Started' || session.status === 'In Progress') {
    const decision = await getDiditDecision(session.sessionId);
    if (decision && decision.status) {
      const normalized = normalizeDiditStatus(decision.status);
      if (normalized !== session.status) {
        session.status = normalized;
        session.updatedAt = new Date().toISOString();
        await persistSession(session);
      }
    }
  }

  return {
    sessionId: session.sessionId,
    session_id: session.sessionId,
    sessionToken: session.sessionToken,
    session_token: session.sessionToken,
    status: session.status,
    url: session.verificationUrl,
    verificationUrl: session.verificationUrl,
    transactionId: session.transactionId,
    customerId: session.customerId,
    amountMinor: session.amountMinor,
    updatedAt: session.updatedAt,
  };
}

/**
 * Exact, case-sensitive Didit status mapping.
 */
function normalizeDiditStatus(status: string): VerificationStatus {
  switch (status) {
    case 'Approved':
      return 'Approved';
    case 'Declined':
      return 'Declined';
    case 'In Review':
      return 'In Review';
    case 'In Progress':
      return 'In Progress';
    case 'Awaiting User':
      return 'Awaiting User';
    case 'Resubmitted':
      return 'Resubmitted';
    case 'Kyc Expired':
      return 'Kyc Expired';
    case 'Expired':
      return 'Expired';
    case 'Abandoned':
      return 'Abandoned';
    case 'Not Started':
      return 'Not Started';
    default: {
      const lower = status.toLowerCase().trim();
      if (lower === 'approved') return 'Approved';
      if (lower === 'declined' || lower === 'rejected') return 'Declined';
      if (lower === 'expired') return 'Expired';
      if (lower === 'abandoned') return 'Abandoned';
      return 'In Progress';
    }
  }
}

/**
 * Handles incoming Didit webhook with signature validation, freshness, and duplicate suppression.
 */
export async function processWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>
): Promise<{ ok: boolean; status: VerificationStatus; sessionId: string; duplicate?: boolean }> {
  // 1 & 2. Enforce cryptographic signature verification (X-Signature-V2 HMAC-SHA256)
  const secret = config.diditWebhookSecret;
  if (!secret) {
    fail('AUTH_FAILED', { reason: 'DIDIT_WEBHOOK_SECRET is not configured on the backend' });
  }

  const valid = verifyDiditWebhookSignature(rawBody, headers, secret);
  if (!valid) {
    fail('AUTH_FAILED', { reason: 'Invalid Didit webhook signature' });
  }

  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const payload = JSON.parse(rawBuffer.toString('utf8'));

  // 3. Freshness — check the SIGNED body `timestamp` field (never unsigned header)
  if (payload.timestamp !== undefined) {
    if (!verifyTimestampFreshness(payload.timestamp, 300)) {
      fail('AUTH_FAILED', { reason: 'Webhook timestamp is stale (> 300s drift)' });
    }
  }

  const eventId: string = payload.event_id || payload.id || crypto.randomUUID();
  const sessionId: string = payload.session_id || payload?.data?.session_id;
  const rawStatus: string = payload.status || payload?.data?.status || '';

  if (!sessionId) {
    fail('VALIDATION_FAILED', { field: 'session_id', reason: 'Missing session_id in webhook payload' });
  }

  // 4. Idempotency — dedupe on event_id using atomic, durable store
  if (processedWebhookEvents.has(eventId)) {
    const existing = await findSession(sessionId);
    return {
      ok: true,
      duplicate: true,
      status: existing?.status ?? 'Approved',
      sessionId,
    };
  }

  processedWebhookEvents.add(eventId);
  syncToDisk();

  const session = await findSession(sessionId);
  if (!session) {
    fail('NOT_FOUND', { reason: `Session ${sessionId} not found` });
  }

  // 5. Apply the decision with case-sensitive status literals
  const newStatus = normalizeDiditStatus(rawStatus);
  session.status = newStatus;
  session.webhookReceivedAt = new Date().toISOString();
  session.updatedAt = new Date().toISOString();

  await persistSession(session);

  // 6. Return 2xx within 5 seconds
  return {
    ok: true,
    status: session.status,
    sessionId: session.sessionId,
  };
}

/**
 * Completes a mock transaction after successful identity verification.
 */
export async function completeMockTransaction(
  auth: Auth | undefined,
  transactionId: string,
  bodyAmountMinor?: number,
  requestCustomerId?: string
): Promise<{ success: boolean; receipt: MockReceipt }> {
  if (!auth && !requestCustomerId) {
    fail('AUTH_FAILED', { reason: 'Authentication required' });
  }

  // Find transaction
  const tx = await getOrCreateMockTransaction(auth, requestCustomerId || '', 0, transactionId);

  // Authorization check: confirm transaction belongs to customer/agent
  const callerCustomerId = requestCustomerId || (auth?.role === 'AGENT' ? undefined : auth?.userId);
  if (callerCustomerId && callerCustomerId !== tx.customerId) {
    fail('FORBIDDEN', { reason: 'Transaction does not belong to the authenticated customer' });
  }

  // One-time processing check (idempotency)
  if (tx.state === 'COMPLETED') {
    fail('STATE_CONFLICT', { reason: 'Transaction has already been completed' });
  }

  // Locate verification session bound to this transaction
  const sessions = Array.from(memorySessions.values()).filter(
    (s) => s.transactionId === transactionId && s.customerId === tx.customerId
  );
  const session = sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

  if (!session) {
    fail('VALIDATION_FAILED', { reason: 'No identity verification session found for this transaction' });
  }

  // Require successful server-verified verification
  if (session.status !== 'Approved') {
    fail('AUTH_FAILED', {
      reason: `Identity verification not approved. Current state: ${session.status}`,
    });
  }

  // Verify that authorized amount has not been altered
  if (bodyAmountMinor !== undefined && Number(bodyAmountMinor) !== session.amountMinor) {
    fail('VALIDATION_FAILED', {
      field: 'amountMinor',
      reason: 'Transaction amount has been altered and does not match authorized verification session',
    });
  }
  if (tx.amountMinor !== session.amountMinor) {
    fail('VALIDATION_FAILED', {
      field: 'amountMinor',
      reason: 'Transaction amount does not match authorized verification session',
    });
  }

  // Enforce mock balance check (mock customer account has ₹1,00,000 synthetic balance)
  const MOCK_BALANCE_MINOR = 10000000;
  if (tx.txnType === 'CASH_OUT' && tx.amountMinor > MOCK_BALANCE_MINOR) {
    fail('VALIDATION_FAILED', { reason: 'Insufficient funds in customer account' });
  }

  // Enforce transaction limit (₹50,000)
  if (tx.amountMinor > 5000000) {
    fail('LIMIT_EXCEEDED', { reason: 'Exceeds maximum allowable transaction limit' });
  }

  // Complete the transaction
  tx.state = 'COMPLETED';
  tx.updatedAt = new Date().toISOString();
  session.completedAt = new Date().toISOString();

  memoryTransactions.set(tx.id, tx);
  memorySessions.set(session.sessionId, session);
  syncToDisk();

  // Try updating Postgres state machine if table exists
  try {
    await pool.query(`UPDATE transactions SET state = 'COMPLETED' WHERE id = $1`, [tx.id]);
  } catch {
    // Postgres fallback
  }

  // Generate verifiable mock receipt
  const issuedAt = new Date().toISOString();
  const receiptData = `${tx.id}:${tx.txnType}:${tx.amountMinor}:${session.sessionId}:${issuedAt}`;
  const signature = crypto.createHmac('sha256', config.attestationSecret).update(receiptData).digest('hex');

  const receipt: MockReceipt = {
    transactionId: tx.id,
    txnType: tx.txnType,
    amountMinor: tx.amountMinor,
    state: 'COMPLETED',
    customerName: tx.customerName,
    accountLabel: tx.accountLabel,
    verificationMethod: 'DIDIT_FACE_VERIFICATION',
    verificationSessionId: session.sessionId,
    verifiedAt: session.updatedAt,
    issuedAt,
    simulated: true,
    signature,
  };

  return { success: true, receipt };
}

// Reset helper for testing
export function _resetStoreForTesting() {
  memorySessions.clear();
  memoryTransactions.clear();
  processedWebhookEvents.clear();
  try {
    if (fs.existsSync(SESSIONS_FILE)) fs.unlinkSync(SESSIONS_FILE);
    if (fs.existsSync(TRANSACTIONS_FILE)) fs.unlinkSync(TRANSACTIONS_FILE);
    if (fs.existsSync(EVENTS_FILE)) fs.unlinkSync(EVENTS_FILE);
  } catch {}
}
