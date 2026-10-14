/**
 * The Express app, without listening, so tests can start it on a random port.
 *
 * Express 5 forwards rejected promises from async handlers to the error
 * handler on its own, so PRISM's wrap() helper is not needed here.
 */
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import pool from './db/pool';
import { errorHandler } from './api/errors';
import { authenticate } from './auth/middleware';
import authRoutes from './auth/routes';
import staffRoutes from './staff/routes';
import transactionRoutes from './transactions/routes';
import providerRoutes from './provider/routes';
import confirmationRoutes from './confirmation/routes';
import cashRoutes from './cash/routes';
import customerRoutes from './customers/routes';
import adminRoutes from './admin/routes';

export function createApp() {
  const app = express();
  // The admin console is plain files on this server. Its own CSP: same-origin only, and no
  // upgrade-insecure-requests (this is served over http on the laptop's loopback address).
  app.use(
    '/console',
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'], upgradeInsecureRequests: null },
      },
    }),
    express.static(path.resolve(__dirname, '../console'))
  );
  app.use(helmet());
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Every /api/v1 route sees req.auth (or not); each declares its own requireRole.
  app.use('/api/v1', authenticate, authRoutes, staffRoutes, transactionRoutes, providerRoutes, confirmationRoutes, cashRoutes, customerRoutes, adminRoutes);

  app.use(errorHandler);
  return app;
}
