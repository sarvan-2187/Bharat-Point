/**
 * Background recovery, started by index.ts (not by tests or createApp()).
 *
 * Finds transactions whose bank outcome is unknown, or that a crash left in
 * PROVIDER_PENDING for longer than two provider timeouts, and resolves them
 * by inquiry with exponential backoff (5s, 10s, 20s ... capped at 320s).
 * The agent's screen keeps saying "do not hand over cash" until this settles.
 */
import { query } from '../db/pool';
import { config } from '../config/env';
import { resolveUnknown } from './service';

export async function sweepOnce(): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `SELECT t.id
       FROM transactions t
       JOIN provider_requests p ON p.transaction_id = t.id AND p.kind IN ('DEBIT', 'CREDIT')
      WHERE (t.state = 'UNKNOWN_OUTCOME'
             OR (t.state = 'PROVIDER_PENDING' AND p.updated_at < NOW() - make_interval(secs => $1)))
        AND (p.last_inquiry_at IS NULL
             OR p.last_inquiry_at < NOW() - make_interval(secs => 5 * power(2, LEAST(p.inquiry_count, 6))))
      ORDER BY t.updated_at
      LIMIT 20`,
    [Math.ceil((2 * config.providerTimeoutMs) / 1000)]
  );
  for (const { id } of rows) {
    try {
      await resolveUnknown(id);
    } catch (err) {
      console.error(`[sweeper] could not resolve ${id}:`, (err as Error).message);
    }
  }
  return rows.length;
}

export function startProviderSweeper(intervalMs = 5000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      await sweepOnce();
    } catch (err) {
      console.error('[sweeper]', (err as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
