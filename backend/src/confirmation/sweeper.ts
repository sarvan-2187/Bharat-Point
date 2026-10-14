/**
 * Confirmation sweeper, started by index.ts every 2 seconds (not by tests).
 *
 *  1. Expires confirmations whose time ran out (the transaction expires).
 *  2. Polls the IVR for every open call and applies the answer.
 *     404 (the IVR never got the request) -> re-send the SAME callId, which the
 *     IVR treats as idempotent, so the customer is never called twice for one dial.
 *     A badly signed reply is ignored and audited; polling continues to expiry.
 */
import { query } from '../db/pool';
import { config, ivrSettings } from '../config/env';
import * as ivr from './client';
import { applyRecord, expireOverdue, placeCall, planForAttempt, rejectReply } from './service';

export async function sweepConfirmationsOnce(): Promise<void> {
  await expireOverdue();
  const settings = ivrSettings();
  if (!settings) return;

  const { rows } = await query<{ id: string; call_id: string }>(
    `SELECT ca.id, ca.call_id
       FROM call_attempts ca
       JOIN transaction_authorizations a ON a.id = ca.authorization_id
      WHERE a.status = 'PENDING' AND a.expires_at > NOW()
        AND ca.state IN ('SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN')
        AND NOT (ca.state = 'SENDING' AND ca.created_at > NOW() - make_interval(secs => $1)) -- a start still in flight
      ORDER BY ca.created_at
      LIMIT 50`,
    [Math.ceil((2 * config.ivrTimeoutMs) / 1000)]
  );
  for (const attempt of rows) {
    try {
      await pollAttempt(settings, attempt);
    } catch (err) {
      console.error(`[confirmation] ${attempt.call_id}:`, (err as Error).message);
    }
  }
}

async function pollAttempt(settings: ivr.IvrSettings, attempt: { id: string; call_id: string }): Promise<void> {
  await query(`UPDATE call_attempts SET poll_count = poll_count + 1, last_polled_at = NOW() WHERE id = $1`, [attempt.id]);
  const outcome = await ivr.getDecision(settings, attempt.call_id);
  if (outcome.kind === 'ANSWERED') {
    const redial = await applyRecord(attempt.id, outcome);
    if (redial) await placeCall(settings, redial);
  } else if (outcome.kind === 'NOT_FOUND') {
    await placeCall(settings, await planForAttempt(attempt.id)); // same callId again
  } else if (outcome.kind === 'REJECTED') {
    await rejectReply(attempt.id, outcome.reason);
  }
  // UNKNOWN: ask again on the next sweep.
}

export function startConfirmationSweeper(intervalMs = 2000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      await sweepConfirmationsOnce();
    } catch (err) {
      console.error('[confirmation]', (err as Error).message);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
