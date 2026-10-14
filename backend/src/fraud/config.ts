/**
 * Fraud review settings, read from the environment on every call (like
 * ivrSettings) and validated: a bad setting is an error at startup, never a
 * silently different threshold.
 *
 *   FRAUD_SCORER_URL         the scorer service (services/fraud-scorer); unset = scoring is off
 *   FRAUD_SCORER_TOKEN       its bearer token (16+ characters)
 *   FRAUD_SCORER_TIMEOUT_MS  how long to wait for a score (default 3000)
 *   FRAUD_THRESHOLD_MEDIUM   probability at or above which a payment is MEDIUM risk (default 0.50)
 *   FRAUD_THRESHOLD_HIGH     probability at or above which it is HIGH risk (default 0.80)
 *   FRAUD_FEATURE_MAP        path to the gender / location encoding file (default backend/config/fraud-feature-map.json)
 *
 * The model author published no threshold, so the two defaults are this
 * project's own starting points and must be tuned by whoever owns the risk.
 *
 * This file imports nothing from the app, so tests can import it safely.
 */
import path from 'node:path';

export type Category = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FraudSettings {
  scorer: { url: string; token: string; timeoutMs: number } | null;
  medium: number;
  high: number;
  featureMapFile: string;
}

const number = (name: string, fallback: number, ok: (n: number) => boolean, rule: string): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name}="${raw}" is invalid: ${rule}`);
  return n;
};

export function fraudSettings(): FraudSettings {
  const medium = number('FRAUD_THRESHOLD_MEDIUM', 0.5, (n) => n > 0 && n < 1, 'must be greater than 0 and less than 1');
  const high = number('FRAUD_THRESHOLD_HIGH', 0.8, (n) => n > 0 && n <= 1, 'must be greater than 0 and at most 1');
  if (medium >= high) throw new Error(`FRAUD_THRESHOLD_MEDIUM (${medium}) must be lower than FRAUD_THRESHOLD_HIGH (${high})`);

  const url = process.env.FRAUD_SCORER_URL;
  let scorer: FraudSettings['scorer'] = null;
  if (url) {
    const token = process.env.FRAUD_SCORER_TOKEN ?? '';
    if (token.length < 16) throw new Error('FRAUD_SCORER_TOKEN must be at least 16 characters when FRAUD_SCORER_URL is set');
    scorer = { url: url.replace(/\/+$/, ''), token, timeoutMs: number('FRAUD_SCORER_TIMEOUT_MS', 3000, (n) => n >= 100 && n <= 30000, 'must be 100 to 30000') };
  }
  return {
    scorer,
    medium,
    high,
    featureMapFile: process.env.FRAUD_FEATURE_MAP || path.resolve(__dirname, '../../config/fraud-feature-map.json'),
  };
}

export function classify(probability: number, s: Pick<FraudSettings, 'medium' | 'high'>): Category {
  return probability >= s.high ? 'HIGH' : probability >= s.medium ? 'MEDIUM' : 'LOW';
}
