/**
 * Background money mover and recovery, started by index.ts (not by tests or createApp()).
 *
 * Every sweep:
 *  1. sends customer-confirmed transactions to the bank;
 *  2. resolves transactions whose bank outcome is unknown, or that a crash
 *     left in PROVIDER_PENDING for longer than two provider timeouts, by
 *     inquiry with exponential backoff (5s, 10s, 20s ... capped at 320s);
 *  3. retries pending reversals with the same request id, same backoff.
 * The agent's screen keeps saying "do not hand over cash" until this settles.
 */
import { query } from '../db/pool';
import { config } from '../config/env';
import { dispatchConfirmed, resolveUnknown, sendReversal } from './service';

const BACKOFF = `(p.last_inquiry_at IS NULL
                  OR p.last_inquiry_at < NOW() - make_interval(secs => 5 * power(2, LEAST(p.inquiry_count, 6))))`;

async function eachSafely(ids: string[], fn: (id: string) => Promise<unknown>) {
  for (const id of ids) {
    try {
      await fn(id);
    } catch (err) {
      console.error(`[sweeper] ${id}:`, (err as Error).message);
    }
  }
}

export async function sweepOnce(): Promise<void> {
  await dispatchConfirmed();

  const unknown = await query<{ id: string }>(
    `SELECT t.id
       FROM transactions t
       JOIN provider_requests p ON p.transaction_id = t.id AND p.kind IN ('DEBIT', 'CREDIT')
      WHERE (t.state = 'UNKNOWN_OUTCOME'
             OR (t.state = 'PROVIDER_PENDING' AND p.updated_at < NOW() - make_interval(secs => $1)))
        AND ${BACKOFF}
      ORDER BY t.updated_at
      LIMIT 20`,
    [Math.ceil((2 * config.providerTimeoutMs) / 1000)]
  );
  await eachSafely(unknown.rows.map((r) => r.id), resolveUnknown);

  const reversals = await query<{ id: string }>(
    `SELECT t.id
       FROM transactions t
       LEFT JOIN provider_requests p ON p.transaction_id = t.id AND p.kind = 'REVERSAL'
      WHERE t.state = 'REVERSAL_PENDING' AND (p.id IS NULL OR ${BACKOFF})
      ORDER BY t.updated_at
      LIMIT 20`
  );
  await eachSafely(reversals.rows.map((r) => r.id), sendReversal);
}

export function startProviderSweeper(intervalMs = 2000): () => void {
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
