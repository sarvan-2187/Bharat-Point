/**
 * Didit Face Verification and Mock Transaction Endpoints.
 *
 * Implements:
 *   POST /api/verify and POST /api/verification/session
 *   GET  /api/verification/status/:sessionId
 *   POST /api/webhooks/didit and POST /api/verification/webhook
 *   POST /api/mock-transactions/:transactionId/complete
 *
 * Also available under /api/v1/* for consistency with BharatPoint versioned APIs.
 */
import { Router, type Request, type Response } from 'express';
import { createSession, getStatus, processWebhook, completeMockTransaction } from './service';

const router = Router();

function getCustomerId(req: Request): string | undefined {
  const header = req.get('x-customer-id');
  if (header) return header.trim();
  if (req.body?.customerId && typeof req.body.customerId === 'string') return req.body.customerId.trim();
  if (req.body?.vendorData && typeof req.body.vendorData === 'string') return req.body.vendorData.trim();
  if (req.body?.vendor_data && typeof req.body.vendor_data === 'string') return req.body.vendor_data.trim();
  if (req.query.customerId && typeof req.query.customerId === 'string') return req.query.customerId.trim();
  return undefined;
}

// ── 1. Create Verification Session ──────────────────────────────────────────
// Supports both canonical /verify and /verification/session
router.post(['/verify', '/verification/session'], async (req: Request, res: Response) => {
  const customerId = getCustomerId(req);
  const workflowId = req.body?.workflow_id || req.body?.workflowId;
  const callbackUrl = req.body?.callback || req.body?.callbackUrl;
  const result = await createSession(req.auth, {
    transactionId: req.body?.transactionId,
    customerId,
    amountMinor: req.body?.amountMinor,
    callbackUrl,
    workflowId,
  });

  // Returns session_token for native React Native SDK and url for web/browser
  res.status(201).json(result);
});

// ── 2. Get Verification Status ──────────────────────────────────────────────
router.get('/verification/status/:sessionId', async (req: Request, res: Response) => {
  const param = req.params.sessionId;
  const sessionId = Array.isArray(param) ? param[0] : param;
  if (!sessionId) {
    res.status(400).json({ failureCode: 'VALIDATION_FAILED', message: 'Missing sessionId' });
    return;
  }
  const customerId = getCustomerId(req);
  const status = await getStatus(req.auth, sessionId, customerId);
  res.json(status);
});

// ── 3. Didit Signed Webhook ─────────────────────────────────────────────────
// Supports both canonical /webhooks/didit and /verification/webhook
router.post(['/webhooks/didit', '/verification/webhook'], async (req: Request, res: Response) => {
  // Use rawBody buffer captured by express.json({ verify })
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const result = await processWebhook(rawBody, req.headers);
  res.json(result);
});

// ── 4. Complete Mock Transaction ───────────────────────────────────────────
router.post('/mock-transactions/:transactionId/complete', async (req: Request, res: Response) => {
  const param = req.params.transactionId;
  const transactionId = Array.isArray(param) ? param[0] : param;
  if (!transactionId) {
    res.status(400).json({ failureCode: 'VALIDATION_FAILED', message: 'Missing transactionId' });
    return;
  }
  const customerId = getCustomerId(req);
  const result = await completeMockTransaction(req.auth, transactionId, req.body?.amountMinor, customerId);
  res.json(result);
});

export default router;
