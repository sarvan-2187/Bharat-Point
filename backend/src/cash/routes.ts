/**
 * Cash at the counter and receipts (Phase 6).
 */
import { Router } from 'express';
import pool from '../db/pool';
import { fail } from '../api/errors';
import { optionalStr, uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { canSee, loadView, present } from '../transactions/service';
import { buildReceipt, confirmCashReturned, confirmHandover, receiptPublicKey, reportHandoverFailed } from './service';

const router = Router();
const view = async (txId: string) => present((await loadView(pool, txId))!);

router.post('/transactions/:id/handover', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  await confirmHandover(req.auth!, txId, req.body?.signature);
  res.json(await view(txId));
});

router.post('/transactions/:id/handover-failed', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  await reportHandoverFailed(req.auth!, txId, req.body?.signature, optionalStr(req.body, 'reason', { max: 200 }));
  res.json(await view(txId));
});

router.post('/transactions/:id/cash-returned', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  await confirmCashReturned(req.auth!, txId, req.body?.signature);
  res.json(await view(txId));
});

router.get('/transactions/:id/receipt', requireRole(), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  const tx = await loadView(pool, txId);
  if (!tx || !canSee(req.auth!, tx)) fail('NOT_FOUND');
  res.json(await buildReceipt(pool, txId));
});

/** Public: anyone can verify a receipt offline with this key. */
router.get('/receipts/key', (_req, res) => {
  res.json(receiptPublicKey());
});

export default router;
