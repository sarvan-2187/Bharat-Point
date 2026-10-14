/**
 * Admin console API (Phase 8). Staff lifecycle (create, invite, suspend,
 * reactivate, reset devices) stays in src/staff/routes.ts.
 */
import { Router } from 'express';
import pool, { withTransaction } from '../db/pool';
import { uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { alerts, listStaff, setLimits } from './admin';
import { live, timeline } from './console';
import { backfill, describeSettings, listAssessments, rerun as rerunAssessment, review as reviewAssessment } from '../fraud/service';
import { callCustomer, listTickets, refreshTicketCalls, resolveTicket, syncTickets } from './tickets';
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

router.get('/admin/live', async (_req, res) => {
  res.json({ ...(await live(pool)), alerts: await alerts(pool) });
});

router.get('/admin/transactions/:id/timeline', async (req, res) => {
  res.json(await timeline(pool, uuid(req.params.id, 'id')));
});

router.get('/admin/tickets', async (_req, res) => {
  await syncTickets(pool);
  await refreshTicketCalls(pool);
  res.json({ tickets: await listTickets(pool) });
});

router.get('/admin/support-requests', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.message, s.created_at AS "createdAt", cu.display_name AS "customerName"
       FROM support_requests s JOIN customers cu ON cu.id = s.customer_id
      WHERE s.status = 'OPEN' ORDER BY s.created_at DESC LIMIT 100`
  );
  res.json({ requests: rows });
});

router.get('/admin/fraud', async (_req, res) => {
  void backfill(); // payments with no assessment yet get one in the background
  res.json({ settings: describeSettings(), assessments: await listAssessments(pool) });
});

router.post('/admin/fraud/:txId/rerun', async (req, res) => {
  await rerunAssessment(uuid(req.params.txId, 'txId'));
  res.status(204).end();
});

router.post('/admin/fraud/:txId/review', async (req, res) => {
  await withTransaction((c) => reviewAssessment(c, uuid(req.params.txId, 'txId'), req.body, req.auth!.userId));
  res.status(204).end();
});

router.post('/admin/tickets/:id/call', async (req, res) => {
  await withTransaction((c) => callCustomer(c, uuid(req.params.id, 'id'), req.auth!.userId));
  res.status(202).end();
});

router.post('/admin/tickets/:id/resolve', async (req, res) => {
  await withTransaction((c) => resolveTicket(c, uuid(req.params.id, 'id'), req.body, req.auth!.userId));
  res.status(204).end();
});

export default router;
