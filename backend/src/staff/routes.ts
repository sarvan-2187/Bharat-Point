/**
 * Admin-only staff management. The admin screens arrive in Phase 8; these
 * routes are what they will call, and what the role-matrix test exercises.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/pool';
import { fail, isUniqueViolation } from '../api/errors';
import { uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { createInvite, createStaff, parseNewStaff, resetDevices, suspendStaff } from './staff';

const router = Router();
router.use('/admin', requireRole('ADMIN'));

router.post('/admin/staff', async (req, res) => {
  const input = parseNewStaff(req.body);
  try {
    res.status(201).json(await withTransaction((c) => createStaff(c, input, req.auth!.userId)));
  } catch (err) {
    if (isUniqueViolation(err)) fail('ALREADY_EXISTS', { field: 'staffCode' });
    throw err;
  }
});

router.post('/admin/staff/:id/invites', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'`, [userId]);
  if (!rows[0]) fail('NOT_FOUND');
  res.status(201).json(await withTransaction((c) => createInvite(c, userId, req.auth!.userId)));
});

router.post('/admin/staff/:id/suspend', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  // An admin suspending themselves would lock the last admin out.
  if (userId === req.auth!.userId) fail('VALIDATION_FAILED', { field: 'id', reason: 'cannot suspend yourself' });
  await withTransaction((c) => suspendStaff(c, userId, req.auth!.userId));
  res.status(204).end();
});

router.post('/admin/staff/:id/reset-devices', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  await withTransaction((c) => resetDevices(c, userId, req.auth!.userId));
  res.status(204).end();
});

export default router;
