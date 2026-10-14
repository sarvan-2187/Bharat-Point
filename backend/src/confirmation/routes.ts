/**
 * The owning agent asks for the customer's confirmation call. The result
 * arrives asynchronously; the agent's screen polls GET /transactions/:id,
 * which now includes a `confirmation` block.
 */
import { Router } from 'express';
import pool from '../db/pool';
import { uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { loadView, present } from '../transactions/service';
import { startConfirmation } from './service';

const router = Router();

router.post('/transactions/:id/confirmation', requireRole('AGENT'), async (req, res) => {
  const txId = uuid(req.params.id, 'id');
  await startConfirmation(req.auth!, txId);
  res.status(202).json(present((await loadView(pool, txId))!));
});

export default router;
