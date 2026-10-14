/**
 * Customer lookup for the agent's counter screen (Phase 7).
 */
import { Router } from 'express';
import pool, { withTransaction } from '../db/pool';
import { parseLanguage, signUp } from './signup';
import { audit } from '../db/audit';
import { requireRole } from '../auth/middleware';
import { str } from '../api/validate';
import { findByPhone, normalizePhone } from './customers';

const router = Router();

// ponytail: every lookup is audited but not throttled; add a per-agent rate limit if lookups are abused.
router.get('/customers', requireRole('AGENT'), async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  const customers = await withTransaction(async (c) => {
    const found = await findByPhone(c, phone);
    await audit(c, 'CUSTOMER_LOOKUP', { actorUserId: req.auth!.userId, data: { matches: found.length } });
    return found;
  });
  res.json({ customers });
});

// Public: the signup screen's bank picker.
router.get('/banks', async (_req, res) => {
  const { rows } = await pool.query(`SELECT code, display_name AS "displayName" FROM banks ORDER BY code`);
  res.json({ banks: rows });
});

// Public (demo mode only): the proof of key possession inside the body is the credential.
router.post('/auth/signup', async (req, res) => {
  res.status(201).json(await signUp(req.body));
});

router.get('/me/preferences', requireRole('CUSTOMER'), async (req, res) => {
  const { rows } = await pool.query(`SELECT preferred_language AS language FROM customers WHERE id = $1`, [req.auth!.customerId]);
  res.json(rows[0]);
});

router.put('/me/preferences', requireRole('CUSTOMER'), async (req, res) => {
  const language = parseLanguage(req.body?.language);
  await withTransaction(async (c) => {
    await c.query(`UPDATE customers SET preferred_language = $2 WHERE id = $1`, [req.auth!.customerId, language]);
    await audit(c, 'CUSTOMER_LANGUAGE_SET', { actorUserId: req.auth!.userId, data: { language } });
  });
  res.json({ language });
});

// ponytail: no rate limit; add one per customer if this is spammed.
router.post('/me/support', requireRole('CUSTOMER'), async (req, res) => {
  const message = str(req.body, 'message', { max: 500 });
  await withTransaction(async (c) => {
    await c.query(`INSERT INTO support_requests (customer_id, message) VALUES ($1, $2)`, [req.auth!.customerId, message]);
    await audit(c, 'SUPPORT_REQUEST_RAISED', { actorUserId: req.auth!.userId });
  });
  res.status(201).end();
});

export default router;
