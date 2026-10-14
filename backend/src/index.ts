/**
 * BharatPoint API entrypoint: checks the database, then listens.
 */
import { config } from './config/env';
import pool from './db/pool';
import { createApp } from './app';
import { startProviderSweeper } from './provider/sweeper';
import { startConfirmationSweeper } from './confirmation/sweeper';
import { ivrSettings } from './config/env';

async function start() {
  // Fail loudly at boot rather than on the first transaction.
  await pool.query('SELECT 1');
  if (!ivrSettings()) console.warn('[api] IVR_URL is not set: customer confirmation calls are unavailable');

  const server = createApp().listen(config.port, config.host, () => {
    console.log(`[api] listening on http://${config.host}:${config.port}`);
  });
  // Resolves bank outcomes that were lost to timeouts or crashes.
  const stopSweeper = startProviderSweeper();
  // Polls the IVR for customer decisions and expires overdue confirmations.
  const stopConfirmations = startConfirmationSweeper();

  const shutdown = () => {
    stopSweeper();
    stopConfirmations();
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
