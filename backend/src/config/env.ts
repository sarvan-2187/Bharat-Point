/**
 * Environment. Loaded by Node's --env-file from the repo-root .env (see the
 * package.json scripts), so there is no dotenv dependency.
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  // Loopback by default: the API is reached through the web proxy, never
  // directly from the LAN (audit F-10).
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: requireEnv('DATABASE_URL'),
  // Staff sessions are server-side and revocable; this only bounds a forgotten one.
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  // Root secret for the authorization-chain and settlement-capability MACs.
  // Must stay the same across restarts, or existing chains stop verifying.
  attestationSecret: (() => {
    const value = requireEnv('ATTESTATION_SECRET');
    if (value.length < 32) throw new Error('ATTESTATION_SECRET must be at least 32 characters');
    return value;
  })(),
  // How long an agent has to get a transaction confirmed and sent to the bank.
  transactionTtlMinutes: Number(process.env.TRANSACTION_TTL_MINUTES ?? 10),
  // The bank / provider the backend calls: the mock bank in this prototype.
  providerUrl: process.env.MOCK_BANK_URL ?? 'http://127.0.0.1:4100',
  providerToken: requireEnv('MOCK_BANK_TOKEN'),
  // A provider answer slower than this is treated as UNKNOWN, never as failed.
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? 5000),
  // Unanswered status inquiries before a person must reconcile the transaction.
  providerMaxInquiries: Number(process.env.PROVIDER_MAX_INQUIRIES ?? 5),
  // Customer confirmation call: how long the customer has to answer and decide.
  confirmationTtlSeconds: Number(process.env.CONFIRMATION_TTL_SECONDS ?? 180),
  // Dials per confirmation (the first call plus one redial on no answer).
  ivrMaxDials: Number(process.env.IVR_MAX_DIALS ?? 2),
  // An IVR answer slower than this is treated as UNKNOWN and asked again later.
  ivrTimeoutMs: Number(process.env.IVR_TIMEOUT_MS ?? 5000),
} as const;

/**
 * The IVR that places customer confirmation calls, or null when none is
 * configured (confirmation then fails closed: nothing can be confirmed).
 * Read on every call, like isDemoMode.
 */
export function ivrSettings(): { url: string; secret: string } | null {
  const url = process.env.IVR_URL;
  if (!url) return null;
  const secret = process.env.IVR_SHARED_SECRET ?? '';
  if (secret.length < 32) throw new Error('IVR_SHARED_SECRET must be at least 32 characters when IVR_URL is set');
  return { url: url.replace(/\/+$/, ''), secret };
}

/**
 * Demo-only features (customer simulator, fault injection, seed data) work only
 * when DEMO_MODE=true. Read on every call so it can never be cached on by accident.
 */
export const isDemoMode = () => process.env.DEMO_MODE === 'true';
