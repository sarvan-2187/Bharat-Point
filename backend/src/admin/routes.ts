/**
 * Admin console API (Phase 8). Staff lifecycle (create, invite, suspend,
 * reactivate, reset devices) stays in src/staff/routes.ts.
 */
import { Router } from 'express';
import pool, { withTransaction } from '../db/pool';
import { uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { alerts, listStaff, setLimits } from './admin';
import { decideReplenishment, listReplenishments, requestReplenishment } from './replenishment';

const router = Router();
router.use('/admin', requireRole('ADMIN'));

router.get('/admin/staff', async (_req, res) => {
  res.json({ staff: await listStaff(pool) });
});

router.put('/admin/agents/:id/limits', async (req, res) => {
  await withTransaction((c) => setLimits(c, uuid(req.params.id, 'id'), req.body, req.auth!.userId));
  res.status(204).end();
});

router.get('/admin/alerts', async (_req, res) => {
  res.json({ alerts: await alerts(pool) });
});

router.get('/admin/replenishments', async (_req, res) => {
  res.json({ replenishments: await listReplenishments(pool) });
});

router.post('/admin/agents/:id/replenishments', async (req, res) => {
  const id = await withTransaction((c) => requestReplenishment(c, uuid(req.params.id, 'id'), req.body, req.auth!.userId));
  res.status(201).json({ id });
});

router.post('/admin/replenishments/:id/approve', async (req, res) => {
  await withTransaction((c) => decideReplenishment(c, uuid(req.params.id, 'id'), true, req.auth!.userId));
  res.status(204).end();
});

router.post('/admin/replenishments/:id/reject', async (req, res) => {
  await withTransaction((c) => decideReplenishment(c, uuid(req.params.id, 'id'), false, req.auth!.userId));
  res.status(204).end();
});

export default router;
