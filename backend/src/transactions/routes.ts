/**
 * Transaction API: an agent creates a transaction, signs its intent hash with
 * their phone, and may amend (supersede) or cancel it before the customer
 * confirms. Staff list the recent transactions they may see (Phase 7).
 */
import { Router } from 'express';
import pool, { withTransaction } from '../db/pool';
import { fail } from '../api/errors';
import { optionalStr, uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { assessInBackground } from '../fraud/service';
import {
  amendTransaction,
  canSee,
  cancelTransaction,
  createTransaction,
  listViews,
  loadView,
  parseAmount,
  parseNewTransaction,
  present,
  reportTransaction,
  signIntent,
} from './service';

const router = Router();

const view = async (txId: string) => present((await loadView(pool, txId))!);

router.post('/transactions', requireRole('AGENT'), async (req, res) => {
  const input = parseNewTransaction(req.body);
  const tx = await withTransaction((c) => createTransaction(c, req.auth!, input));
  assessInBackground(tx.id); // advisory fraud review for the admin; never delays or changes the payment
  res.status(201).json(await view(tx.id));
});

router.get('/transactions', requireRole(), async (req, res) => {
  res.json({ transactions: (await listViews(pool, req.auth!)).map(present) });
});

router.get('/transactions/:id', requireRole(), async (req, res) => {
  const tx = await loadView(pool, uuid(req.params.id, 'id'));
  if (!tx || !canSee(req.auth!, tx)) fail('NOT_FOUND');
  res.json(present(tx));
});

router.post('/transactions/:id/report', requireRole('CUSTOMER'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  const note = optionalStr(req.body, 'note', { max: 300 });
  await withTransaction((c) => reportTransaction(c, req.auth!, txId, note));
  res.status(204).end();
});

router.post('/transactions/:id/sign', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  await withTransaction((c) => signIntent(c, req.auth!, txId, req.body?.signature));
  res.json(await view(txId));
});

router.post('/transactions/:id/amend', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  const amountMinor = parseAmount(req.body?.amountMinor);
  const replacement = await withTransaction((c) => amendTransaction(c, req.auth!, txId, amountMinor));
  assessInBackground(replacement.id);
  res.status(201).json(await view(replacement.id));
});

router.post('/transactions/:id/cancel', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  await withTransaction((c) => cancelTransaction(c, req.auth!, txId));
  res.json(await view(txId));
});

export default router;
