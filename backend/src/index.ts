/**
 * BharatPoint API entrypoint: checks the database, then listens.
 */
import { config } from './config/env';
import pool from './db/pool';
import { createApp } from './app';

async function start() {
  // Fail loudly at boot rather than on the first transaction.
  await pool.query('SELECT 1');

  const server = createApp().listen(config.port, config.host, () => {
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
