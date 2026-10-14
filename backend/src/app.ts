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
import verificationRoutes from './verification/routes';

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

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-customer-id, x-signature-v2, x-signature');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    express.json({
      limit: '64kb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Didit verification and mock transaction endpoints available at /api and /api/v1
  app.use('/api', authenticate, verificationRoutes);

  // Every /api/v1 route sees req.auth (or not); each declares its own requireRole.
  app.use(
    '/api/v1',
    authenticate,
    authRoutes,
    staffRoutes,
    transactionRoutes,
    providerRoutes,
    confirmationRoutes,
    cashRoutes,
    customerRoutes,
    adminRoutes,
    verificationRoutes
  );

  app.use(errorHandler);
  return app;
}
