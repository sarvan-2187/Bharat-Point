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
} as const;
