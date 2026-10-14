/**
 * Admin-only staff management, called by the admin screens (Phase 8) and
 * exercised by the role-matrix test. Invites come back with their QR as a PNG
 * data URL, so the admin's phone can show it for the new staff member to scan.
 */
import { Router } from 'express';
import QRCode from 'qrcode';
import { query, withTransaction } from '../db/pool';
import { fail, isUniqueViolation } from '../api/errors';
import { uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { createInvite, createStaff, parseNewStaff, reactivateStaff, resetDevices, suspendStaff, type Invite } from './staff';

const router = Router();
router.use('/admin', requireRole('ADMIN'));

const withQr = async (invite: Invite) => ({ ...invite, qrDataUrl: await QRCode.toDataURL(invite.qrPayload, { margin: 2, width: 320 }) });

router.post('/admin/staff', async (req, res) => {
  const input = parseNewStaff(req.body);
  try {
    const created = await withTransaction((c) => createStaff(c, input, req.auth!.userId));
    res.status(201).json({ ...created, invite: await withQr(created.invite) });
  } catch (err) {
    if (isUniqueViolation(err)) fail('ALREADY_EXISTS', { field: 'staffCode' });
    throw err;
  }
});

router.post('/admin/staff/:id/invites', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'`, [userId]);
  if (!rows[0]) fail('NOT_FOUND');
  res.status(201).json(await withQr(await withTransaction((c) => createInvite(c, userId, req.auth!.userId))));
});

router.post('/admin/staff/:id/suspend', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  // An admin suspending themselves would lock the last admin out.
  if (userId === req.auth!.userId) fail('VALIDATION_FAILED', { field: 'id', reason: 'cannot suspend yourself' });
  await withTransaction((c) => suspendStaff(c, userId, req.auth!.userId));
  res.status(204).end();
});

router.post('/admin/staff/:id/reactivate', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  await withTransaction((c) => reactivateStaff(c, userId, req.auth!.userId));
  res.status(204).end();
});

router.post('/admin/staff/:id/reset-devices', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  await withTransaction((c) => resetDevices(c, userId, req.auth!.userId));
  res.status(204).end();
});

export default router;
