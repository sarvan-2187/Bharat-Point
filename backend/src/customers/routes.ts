/**
 * Customer lookup for the agent's counter screen (Phase 7).
 */
import { Router } from 'express';
import { withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { requireRole } from '../auth/middleware';
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

export default router;
