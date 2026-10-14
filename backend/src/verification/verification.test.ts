/**
 * Test suite for Didit Face Verification and Mock Transactions.
 *
 * Covers all required test scenarios:
 *   1. Successful verification flow
 *   2. Declined verification
 *   3. Expired session
 *   4. Invalid webhook signature rejection
 *   5. Duplicate webhook delivery (idempotency)
 *   6. Unauthenticated status request rejection
 *   7. Cross-customer session access attempt rejection
 *   8. Altered withdrawal amount rejection
 *   9. Repeated transaction-completion requests (idempotency)
 *  10. Backend restart and session persistence
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Server } from 'http';
import { createApp } from '../app';
import { _resetStoreForTesting } from './service';

const TEST_SECRET = 'test_webhook_secret_for_didit_testing_32chars';
process.env.DIDIT_WEBHOOK_SECRET = TEST_SECRET;
process.env.ATTESTATION_SECRET = 'test_attestation_secret_at_least_32_chars_long';

describe('Didit Face Verification & Mock Transactions', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    _resetStoreForTesting();
  });

  function signPayload(body: string, secret = TEST_SECRET): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  // 1. Successful verification flow
  test('1. Successful verification: session creation -> approved webhook -> transaction completion with receipt', async () => {
    const customerId = 'cust-1001';
    const amountMinor = 50000; // ₹500

    // Step A: Create verification session
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-customer-id': customerId,
      },
      body: JSON.stringify({ amountMinor }),
    });

    assert.equal(createRes.status, 201);
    const session = await createRes.json();
    assert.ok(session.sessionId);
    assert.ok(session.verificationUrl);
    assert.equal(session.status, 'Not Started');
    assert.equal(session.amountMinor, amountMinor);

    // Step B: Send signed Didit webhook with Approved decision
    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-approved-001',
      timestamp: new Date().toISOString(),
      data: {
        session_id: session.sessionId,
        status: 'Approved',
        vendor_data: `${customerId}:${session.transactionId}`,
      },
    });

    const signature = signPayload(webhookPayload);
    const webhookRes = await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': signature,
      },
      body: webhookPayload,
    });

    assert.equal(webhookRes.status, 200);
    const webhookData = await webhookRes.json();
    assert.equal(webhookData.status, 'Approved');

    // Step C: Verify status reflects Approved
    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`, {
      headers: { 'x-customer-id': customerId },
    });
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'Approved');

    // Step D: Complete mock transaction
    const completeRes = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-customer-id': customerId,
      },
      body: JSON.stringify({ amountMinor }),
    });

    assert.equal(completeRes.status, 200);
    const completeData = await completeRes.json();
    assert.equal(completeData.success, true);
    assert.equal(completeData.receipt.state, 'COMPLETED');
    assert.equal(completeData.receipt.amountMinor, amountMinor);
    assert.equal(completeData.receipt.verificationMethod, 'DIDIT_FACE_VERIFICATION');
    assert.equal(completeData.receipt.simulated, true);
    assert.ok(completeData.receipt.signature);
  });

  // 2. Declined verification
  test('2. Declined verification: webhook receives Declined -> completion is rejected', async () => {
    const customerId = 'cust-1002';
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: 20000 }),
    });
    const session = await createRes.json();

    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-declined-002',
      data: {
        session_id: session.sessionId,
        status: 'Declined',
      },
    });

    await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(webhookPayload) },
      body: webhookPayload,
    });

    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`, {
      headers: { 'x-customer-id': customerId },
    });
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'Declined');

    // Completion must be rejected
    const completeRes = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: 20000 }),
    });
    assert.notEqual(completeRes.status, 200);
  });

  // 3. Expired session
  test('3. Expired session: session marked expired cannot be used to complete transaction', async () => {
    const customerId = 'cust-1003';
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: 30000 }),
    });
    const session = await createRes.json();

    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-expired-003',
      data: {
        session_id: session.sessionId,
        status: 'Expired',
      },
    });

    await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(webhookPayload) },
      body: webhookPayload,
    });

    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`, {
      headers: { 'x-customer-id': customerId },
    });
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'Expired');

    const completeRes = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
    });
    assert.notEqual(completeRes.status, 200);
  });

  // 4. Invalid webhook signature
  test('4. Invalid webhook signature: rejected with 401 and status unchanged', async () => {
    const customerId = 'cust-1004';
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: 10000 }),
    });
    const session = await createRes.json();

    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-bad-sig-004',
      data: {
        session_id: session.sessionId,
        status: 'Approved',
      },
    });

    // Provide invalid signature
    const webhookRes = await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': '0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: webhookPayload,
    });
    assert.equal(webhookRes.status, 401);

    // Verify session remained Not Started
    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`, {
      headers: { 'x-customer-id': customerId },
    });
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'Not Started');
  });

  // 5. Duplicate webhook delivery
  test('5. Duplicate webhook delivery: handled safely and idempotently without errors', async () => {
    const customerId = 'cust-1005';
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: 20000 }),
    });
    const session = await createRes.json();

    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-duplicate-005',
      data: {
        session_id: session.sessionId,
        status: 'Approved',
      },
    });
    const sig = signPayload(webhookPayload);

    // Delivery 1
    const res1 = await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': sig },
      body: webhookPayload,
    });
    assert.equal(res1.status, 200);

    // Delivery 2 (Duplicate with same event_id)
    const res2 = await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': sig },
      body: webhookPayload,
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.ok, true);
    assert.equal(data2.duplicate, true);
  });

  // 6. Unauthenticated status request
  test('6. Unauthenticated status request: rejected with 401 AUTH_FAILED', async () => {
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': 'cust-1006' },
      body: JSON.stringify({ amountMinor: 10000 }),
    });
    const session = await createRes.json();

    // Call status without authentication header
    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`);
    assert.equal(statusRes.status, 401);
  });

  // 7. A customer trying to access another customer's session
  test("7. Cross-customer access: Customer B cannot access Customer A's session", async () => {
    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': 'cust-alice' },
      body: JSON.stringify({ amountMinor: 10000 }),
    });
    const session = await createRes.json();

    // Bob tries to access Alice's session
    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`, {
      headers: { 'x-customer-id': 'cust-bob' },
    });
    assert.equal(statusRes.status, 403);
  });

  // 8. An altered withdrawal amount
  test('8. Altered withdrawal amount: completion is rejected if amount differs from authorized session', async () => {
    const customerId = 'cust-1008';
    const authorizedMinor = 50000; // ₹500

    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: authorizedMinor }),
    });
    const session = await createRes.json();

    // Approve verification
    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-approve-008',
      data: { session_id: session.sessionId, status: 'Approved' },
    });
    await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(webhookPayload) },
      body: webhookPayload,
    });

    // Attempt completion with altered amount ₹1,000 (100000 paise)
    const completeRes = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor: 100000 }),
    });
    assert.equal(completeRes.status, 400);
    const body = await completeRes.json();
    assert.equal(body.failureCode, 'VALIDATION_FAILED');
  });

  // 9. Repeated transaction-completion requests
  test('9. Repeated transaction completion: first succeeds, second is rejected with STATE_CONFLICT', async () => {
    const customerId = 'cust-1009';
    const amountMinor = 20000;

    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor }),
    });
    const session = await createRes.json();

    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-approve-009',
      data: { session_id: session.sessionId, status: 'Approved' },
    });
    await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(webhookPayload) },
      body: webhookPayload,
    });

    // Attempt 1: Succeeds
    const res1 = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor }),
    });
    assert.equal(res1.status, 200);

    // Attempt 2: Replay / duplicate completion attempt rejected
    const res2 = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor }),
    });
    assert.equal(res2.status, 409); // STATE_CONFLICT
  });

  // 10. Backend restart and session persistence
  test('10. Backend restart and session persistence: session survives simulated restart and maintains integrity', async () => {
    const customerId = 'cust-1010';
    const amountMinor = 40000;

    const createRes = await fetch(`${baseUrl}/api/verification/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor }),
    });
    const session = await createRes.json();

    // Approve before restart
    const webhookPayload = JSON.stringify({
      webhook_type: 'status.updated',
      event_id: 'evt-approve-010',
      data: { session_id: session.sessionId, status: 'Approved' },
    });
    await fetch(`${baseUrl}/api/verification/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': signPayload(webhookPayload) },
      body: webhookPayload,
    });

    // Simulate backend server restart by shutting down server and starting a new instance
    await new Promise((resolve) => server.close(resolve));

    const newApp = createApp();
    server = newApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Status check after restart confirms session was persisted
    const statusRes = await fetch(`${baseUrl}/api/verification/status/${session.sessionId}`, {
      headers: { 'x-customer-id': customerId },
    });
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.sessionId, session.sessionId);
    assert.equal(statusData.status, 'Approved');
    assert.equal(statusData.amountMinor, amountMinor);

    // Completion succeeds on restarted backend
    const completeRes = await fetch(`${baseUrl}/api/mock-transactions/${session.transactionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-id': customerId },
      body: JSON.stringify({ amountMinor }),
    });
    assert.equal(completeRes.status, 200);
    const completeData = await completeRes.json();
    assert.equal(completeData.success, true);
    assert.equal(completeData.receipt.state, 'COMPLETED');
  });
});
