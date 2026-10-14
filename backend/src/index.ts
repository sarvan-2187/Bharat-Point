/**
 * BharatPoint API.
 *
 * Express 5 forwards rejected promises from async handlers to the error
 * handler on its own, so PRISM's wrap() helper is not needed here.
 */
import express from 'express';
import helmet from 'helmet';
import { config } from './config/env';
import pool from './db/pool';
import { errorHandler } from './api/errors';

const app = express();
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

// Feature routers mount under /api/v1, each behind a role guard (audit §10).

app.use(errorHandler);

async function start() {
  // Fail loudly at boot rather than on the first transaction.
  await pool.query('SELECT 1');

  const server = app.listen(config.port, config.host, () => {
    console.log(`[api] listening on http://${config.host}:${config.port}`);
  });

  const shutdown = () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err: Error) => {
  console.error('[api] failed to start:', err.message);
  console.error('[api] is Postgres up?  docker compose up -d');
  process.exit(1);
});
