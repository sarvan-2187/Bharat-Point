/**
 * Fraud review: an advisory risk assessment of each payment, shown to admins.
 *
 *   assess(txId)   gathers the nine features, asks the scorer, classifies the
 *                  probability against the configured thresholds, and stores
 *                  the outcome in fraud_assessments.
 *
 * Three outcomes, never conflated:
 *   SCORED      a probability and a category (LOW / MEDIUM / HIGH);
 *   INCOMPLETE  a feature could not be sourced, so the model was NOT asked;
 *   UNAVAILABLE the scorer is off, down, slow, or gave an unusable answer.
 * INCOMPLETE and UNAVAILABLE carry no score and no category: they are shown as
 * "no assessment", never as low risk.
 *
 * This is advisory by design. It does not touch the payment's state and does
 * not stand in for customer confirmation, the PIN, limits or the bank. An
 * admin reviews flagged payments and either clears them (with a note) or
 * escalates them to a ticket, where the existing callback-call workflow lets
 * them check with the customer.
 */
import fs from 'node:fs';
import type { PoolClient } from 'pg';
import pool, { withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import * as provider from '../provider/client';
import { classify, fraudSettings, type Category, type FraudSettings } from './config';
import { ASSUMPTIONS, buildFeatures, parseFeatureMap, type FeatureMap, type Missing } from './features';

type Q = Pick<PoolClient, 'query'>;

const EMPTY_MAP: FeatureMap = { source: 'none', gender: {}, location: {} };

function loadFeatureMap(file: string): { map: FeatureMap; error: string | null } {
  try {
    return { map: parseFeatureMap(JSON.parse(fs.readFileSync(file, 'utf8'))), error: null };
  } catch (err) {
    return { map: EMPTY_MAP, error: `feature map unusable (${(err as Error).message})` };
  }
}

type ScoreResult = { ok: true; probability: number; modelSha256: string } | { ok: false; reason: string };

async function askScorer(s: NonNullable<FraudSettings['scorer']>, features: Record<string, number>): Promise<ScoreResult> {
  let res: Response;
  try {
    res = await fetch(`${s.url}/v1/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ features }),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: (err as Error).name === 'TimeoutError' ? 'SCORER_TIMEOUT' : 'SCORER_UNREACHABLE' };
  }
  const body = (await res.json().catch(() => null)) as { probability?: unknown; modelSha256?: unknown; fields?: unknown } | null;
  if (res.status === 422) return { ok: false, reason: `SCORER_REJECTED_FEATURES ${JSON.stringify(body?.fields ?? {})}`.slice(0, 300) };
  if (res.status !== 200) return { ok: false, reason: `SCORER_HTTP_${res.status}` };
  const p = body?.probability;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1 || typeof body?.modelSha256 !== 'string') {
    return { ok: false, reason: 'SCORER_BAD_REPLY' }; // never coerce an odd answer into a score
  }
  return { ok: true, probability: p, modelSha256: body.modelSha256 };
}

export interface Outcome {
  status: 'SCORED' | 'INCOMPLETE' | 'UNAVAILABLE';
  probability: number | null;
  category: Category | null;
  missing: Missing[];
  reason: string | null;
  features: Record<string, number> | null;
  modelSha256: string | null;
}

/** Decide the outcome for one payment's inputs. Pure apart from the scorer call. */
export async function evaluate(
  settings: FraudSettings,
  input: Parameters<typeof buildFeatures>[0],
  mapError: string | null
): Promise<Outcome> {
  const { features, missing } = buildFeatures(input);
  if (!features) {
    return { status: 'INCOMPLETE', probability: null, category: null, missing, reason: mapError, features: null, modelSha256: null };
  }
  const none = (reason: string): Outcome => ({ status: 'UNAVAILABLE', probability: null, category: null, missing: [], reason, features, modelSha256: null });
  if (!settings.scorer) return none('SCORER_NOT_CONFIGURED');
  const scored = await askScorer(settings.scorer, features);
  if (!scored.ok) return none(scored.reason);
  return {
    status: 'SCORED',
    probability: scored.probability,
    category: classify(scored.probability, settings),
    missing: [],
    reason: null,
    features,
    modelSha256: scored.modelSha256,
  };
}

export async function assess(txId: string): Promise<void> {
  let settings: FraudSettings | null = null;
  let configError: string | null = null;
  try {
    settings = fraudSettings();
  } catch (err) {
    configError = (err as Error).message;
  }

  const row = (
    await pool.query<{ amount_minor: string; created_at: Date; dob: string | null; gender: string | null; location: string | null; provider_token: string }>(
      `SELECT t.amount_minor, t.created_at, cu.date_of_birth::text AS dob, cu.gender, cu.location, l.provider_token
         FROM transactions t
         JOIN customers cu             ON cu.id = t.customer_id
         JOIN customer_account_links l ON l.id = t.account_link_id
        WHERE t.id = $1`,
      [txId]
    )
  ).rows[0];
  if (!row) fail('NOT_FOUND');

  let outcome: Outcome;
  if (!settings) {
    // An invalid setting is an operator error, not a reason to guess: record "no assessment" and say why.
    outcome = { status: 'UNAVAILABLE', probability: null, category: null, missing: [], reason: `CONFIG_INVALID: ${configError}`.slice(0, 300), features: null, modelSha256: null };
  } else {
    const { map, error: mapError } = loadFeatureMap(settings.featureMapFile);
    outcome = await evaluate(
      settings,
      {
        amountMinor: Number(row.amount_minor),
        balanceMinor: await provider.getBalance(row.provider_token),
        dateOfBirth: row.dob,
        gender: row.gender,
        location: row.location,
        at: row.created_at,
        map,
      },
      mapError
    );
  }

  const thresholds = settings ? { medium: settings.medium, high: settings.high } : {};
  await withTransaction(async (c) => {
    const saved = await c.query(
      `INSERT INTO fraud_assessments
         (transaction_id, status, probability, category, missing, reason, features, model_sha256, thresholds, assumptions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (transaction_id) DO UPDATE
          SET status = EXCLUDED.status, probability = EXCLUDED.probability, category = EXCLUDED.category,
              missing = EXCLUDED.missing, reason = EXCLUDED.reason, features = EXCLUDED.features,
              model_sha256 = EXCLUDED.model_sha256, thresholds = EXCLUDED.thresholds,
              assumptions = EXCLUDED.assumptions, updated_at = NOW()
        WHERE fraud_assessments.review_status = 'PENDING'`,
      [
        txId,
        outcome.status,
        outcome.probability,
        outcome.category,
        JSON.stringify(outcome.missing),
        outcome.reason,
        outcome.features ? JSON.stringify(outcome.features) : null,
        outcome.modelSha256,
        JSON.stringify(thresholds),
        JSON.stringify(ASSUMPTIONS),
      ]
    );
    if (saved.rowCount) {
      await audit(c, 'FRAUD_ASSESSED', {
        transactionId: txId,
        data: { status: outcome.status, category: outcome.category, probability: outcome.probability, reason: outcome.reason },
      });
    }
  });
}

/** Called after a payment is created. Never throws and never delays the agent: a failure here is logged, not surfaced. */
export function assessInBackground(txId: string): void {
  assess(txId).catch((err) => console.error(`[fraud] ${txId}:`, (err as Error).message));
}

let backfilling = false;
/** Assess payments that have no assessment yet (older ones, or ones whose background run was lost). */
export async function backfill(limit = 10): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT t.id FROM transactions t LEFT JOIN fraud_assessments f ON f.transaction_id = t.id
        WHERE f.id IS NULL ORDER BY t.created_at DESC LIMIT $1`,
      [limit]
    );
    for (const r of rows) await assess(r.id).catch((err) => console.error(`[fraud] ${r.id}:`, (err as Error).message));
  } finally {
    backfilling = false;
  }
}

export async function listAssessments(q: Q) {
  const { rows } = await q.query(
    `SELECT f.transaction_id AS "transactionId", f.status, f.probability::float8 AS probability, f.category,
            f.missing, f.reason, f.thresholds, f.model_sha256 AS "modelSha256",
            f.review_status AS "reviewStatus", f.review_note AS "reviewNote", f.created_at AS "assessedAt",
            t.amount_minor::int AS "amountMinor", t.txn_type AS "txnType", t.state AS "txState", t.created_at AS "createdAt",
            ag.agent_code AS "agentCode", u.display_name AS "agentName", ag.location_name AS "agentLocation",
            'CUS-' || upper(left(cu.id::text, 8)) AS "customerRef", l.masked_label AS "accountLabel"
       FROM fraud_assessments f
       JOIN transactions t           ON t.id = f.transaction_id
       JOIN agents ag                ON ag.id = t.agent_id
       JOIN users u                  ON u.id = ag.user_id
       JOIN customers cu             ON cu.id = t.customer_id
       JOIN customer_account_links l ON l.id = t.account_link_id
      ORDER BY (f.review_status = 'PENDING') DESC,
               CASE f.category WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
               f.created_at DESC
      LIMIT 100`
  );
  return rows;
}

/** What the dashboard needs to explain how scoring is configured right now. */
export function describeSettings() {
  try {
    const s = fraudSettings();
    const { map, error } = loadFeatureMap(s.featureMapFile);
    return {
      scorerConfigured: s.scorer !== null,
      thresholds: { medium: s.medium, high: s.high },
      featureMap: { source: map.source, genders: Object.keys(map.gender).length, locations: Object.keys(map.location).length, error },
      error: null as string | null,
    };
  } catch (err) {
    return { scorerConfigured: false, thresholds: null, featureMap: null, error: (err as Error).message };
  }
}

export async function rerun(txId: string): Promise<void> {
  const existing = (await pool.query<{ review_status: string }>(`SELECT review_status FROM fraud_assessments WHERE transaction_id = $1`, [txId])).rows[0];
  if (existing && existing.review_status !== 'PENDING') fail('STATE_CONFLICT', { reason: 'already reviewed' });
  await assess(txId);
}

/**
 * The admin's decision on a payment. CLEARED: the admin accepts it, with a note
 * (also allowed when there is no model score; the note then says why). ESCALATED:
 * opens a ticket, where the admin can call the customer to check. Neither one
 * changes the payment: that stays with customer confirmation, limits and the bank.
 */
export async function review(c: PoolClient, txId: string, body: Record<string, unknown> | undefined, adminUserId: string): Promise<void> {
  const decision = body?.decision;
  if (decision !== 'CLEARED' && decision !== 'ESCALATED') fail('VALIDATION_FAILED', { field: 'decision' });
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note || note.length > 300) fail('VALIDATION_FAILED', { field: 'note' });

  const { rowCount } = await c.query(
    `UPDATE fraud_assessments SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
      WHERE transaction_id = $1 AND review_status = 'PENDING'`,
    [txId, decision, note, adminUserId]
  );
  if (!rowCount) {
    const exists = (await c.query(`SELECT 1 FROM fraud_assessments WHERE transaction_id = $1`, [txId])).rows[0];
    fail(exists ? 'STATE_CONFLICT' : 'NOT_FOUND');
  }
  if (decision === 'ESCALATED') {
    await c.query(`INSERT INTO tickets (kind, transaction_id) VALUES ('FRAUD_REVIEW', $1) ON CONFLICT DO NOTHING`, [txId]);
  }
  await audit(c, 'FRAUD_REVIEWED', { actorUserId: adminUserId, transactionId: txId, data: { decision } });
}
