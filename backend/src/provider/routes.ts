/**
 * Demo-only bank fault switches for the bank operations console (Phase 9 UI).
 * Bank staff and admins can make the mock bank decline, error before saving,
 * or answer too late after the money has moved, to rehearse each failure.
 * Unavailable (404) unless DEMO_MODE=true.
 */
import { Router } from 'express';
import { withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { config, isDemoMode } from '../config/env';
import { requireRole } from '../auth/middleware';
import * as client from './client';

const MODES = ['DECLINE', 'ERROR_BEFORE_COMMIT', 'TIMEOUT_AFTER_COMMIT'];

const router = Router();

router.use('/bank/sim', requireRole('BANK_OPERATOR', 'ADMIN'), (_req, _res, next) => {
  if (!isDemoMode()) fail('NOT_FOUND');
  next();
});

router.get('/bank/sim/faults', async (_req, res) => {
  res.json(await client.getFault());
});

router.post('/bank/sim/faults', async (req, res) => {
  const mode = req.body?.mode ?? null;
  if (mode !== null && !MODES.includes(mode)) fail('VALIDATION_FAILED', { field: 'mode' });
  const count = req.body?.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) fail('VALIDATION_FAILED', { field: 'count' });

  // A "late" answer must arrive after the backend has already given up waiting.
  const result = await client.setFault({ mode, count, delayMs: config.providerTimeoutMs * 2 });
  await withTransaction((c) => audit(c, 'PROVIDER_FAULT_SET', { actorUserId: req.auth!.userId, data: { mode, count } }));
  res.json(result);
});

export default router;
