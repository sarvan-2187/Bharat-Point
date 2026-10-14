# Bharat Point Phase 2 Build Prompt: Staff Sign-in and Roles

> **To the coding agent (Antigravity):** Phases 0 and 1 are done and pushed. This document is Phase 2. It contains every new or changed file in full in the [Code](#code) section: create each one at the path in its heading with exactly the content shown, overwriting the existing file where there is one. Do not redesign the flow while copying it. Save this document as `docs/prompts/PHASE_2_STAFF_SIGNIN_PROMPT.md`.
>
> **Do not commit or push until you reach the [Push prompt](#push-prompt-run-this-last) at the end.**

## How to work

1. Create or overwrite every file in [Code](#code), byte-for-byte.
2. Install the new dependencies (the package.json files below already list them):
   ```bash
   cd backend && npm install
   cd ../mobile && npm install
   ```
3. Verify the backend against a real Postgres (`docker compose up -d`, `.env` filled in):
   ```bash
   cd backend
   npm run typecheck
   npm run db:migrate          # applies 0005_auth.sql
   npm test
   ```
   **Expected:** `# tests 35`, `# pass 35`, `# fail 0`, and no `SKIP` lines.
4. Verify the mobile app:
   ```bash
   cd mobile
   npm run typecheck
   npx expo lint
   ```
5. Try it for real (optional but recommended): `npm run dev` in `backend/`, then
   `npm run staff:invite -- --role ADMIN --code AD-001 --name "Your name"` prints a QR. In Expo Go: **Enrol this phone** → scan → fingerprint/PIN → the home screen shows your name and role.
6. **Stop and report:** files created or changed, the commands above with their real output, and anything that failed. Fix only what is needed to pass, and say exactly what you changed.

### How staff sign-in works

1. **Invite.** An admin creates a staff member. The server returns a **single-use invite valid for 30 minutes**, shown as a QR (`bharatpoint-invite:<token>`). Only the token's hash is stored. Before the admin screens exist (Phase 8), the local CLI does this: `npm run staff:invite`.
2. **Enrol.** The phone generates an **Ed25519 key pair** (random seed from `expo-crypto`, maths from `@noble/curves`), asks for the phone's biometric / screen lock, and signs `bharatpoint/enrol/v1\n<token>`. The server checks the signature **before** touching the invite (so a bad attempt cannot burn it), marks the invite used, and stores the **public key only**. The private seed stays in `expo-secure-store` on that phone (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, not backed up).
3. **Sign in.** The phone asks for a challenge, the server returns a random nonce valid for **60 seconds, usable once**, and the phone signs `bharatpoint/login/v1\n<challengeId>\n<nonce>` after the biometric prompt. The server returns a random **session token** (only its hash is stored), kept in SecureStore and sent as `Authorization: Bearer`.
4. **Every request** looks the session up in Postgres and reads the user's **current** role and status. Suspending a user, resetting their devices or logging out takes effect on the very next request.
5. **Roles** are checked on the server with `requireRole(...)`. The app only hides doors that would not open anyway.

Every authentication failure returns the same `AUTH_FAILED`, so a caller cannot tell an unknown invite from a spent one, or a revoked key from a wrong signature.

### API added in Phase 2

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/v1/auth/enrol` | anyone with an invite | `{ inviteToken, publicKey, signature, label? }` → `{ deviceKeyId }` |
| `POST /api/v1/auth/challenge` | enrolled phone | `{ deviceKeyId }` → `{ challengeId, nonce, expiresAt }` |
| `POST /api/v1/auth/login` | enrolled phone | `{ challengeId, signature }` → `{ token, expiresAt }` |
| `POST /api/v1/auth/logout` | any signed-in staff | revokes the session |
| `GET /api/v1/me` | any signed-in staff | `{ userId, staffCode, displayName, role, bankId, agentId }` |
| `POST /api/v1/admin/staff` | ADMIN | create staff (+ agent row for agents) and return their first invite |
| `POST /api/v1/admin/staff/:id/invites` | ADMIN | new invite (e.g. after a device reset) |
| `POST /api/v1/admin/staff/:id/suspend` | ADMIN | block the user and end all their sessions (not yourself) |
| `POST /api/v1/admin/staff/:id/reset-devices` | ADMIN | lost phone: revoke all device keys and sessions |

---

## Stack

| Layer | Phase 2 change |
|---|---|
| Database | `0005_auth.sql`: single-use `auth_challenges`; invites created by the local CLI may have no creator |
| Backend | Ed25519 verification with Node's built-in crypto; session middleware that reads role/status from the DB on every request; `requireRole`; admin staff routes; `npm run staff:invite` CLI with a terminal QR (`qrcode`); audit rows written in the same DB transaction as each change; the Express app split into `app.ts` so tests can start it |
| Mobile | `expo-secure-store`, `expo-local-authentication`, `expo-crypto`, `expo-camera` (all bundled in Expo Go) and `@noble/curves` (pure JavaScript). New **Enrol this phone** screen (QR scan or typed code); home screen shows sign-in state, the user's role area and sign-out |
| Tests | `auth.test.ts` (14 HTTP tests: enrolment, expiry, proof of possession, sign-in, replay, logout, suspension, lost phone, role matrix, bad input, duplicates) and `crypto.test.ts` (the phone's signing library verifies on the server; signatures are purpose-bound) |

## Feasibility

| Requirement | How Phase 2 meets it |
|---|---|
| Works in Expo Go | Only Expo Go-bundled modules plus a pure-JS signing library; the Android bundle builds |
| Phone biometrics | `expo-local-authentication` gates every signature; fingerprint or device PIN (Face ID on iOS needs a development build) |
| Server breach cannot forge staff | The server holds public keys and token hashes only |
| Replay-proof sign-in | Challenges are single-use and expire in 60 seconds; signatures are bound to their purpose |
| Instant revocation | Sessions live in Postgres; suspension and device reset revoke them in the same transaction |
| Role-based access on the server | `requireRole` on every protected route; role read fresh per request; tested as a matrix |

## Viability

- **Cost:** ₹0. All libraries are open source; no paid identity service.
- **Effort:** one migration, a small auth module, a staff module with a CLI, one new screen.
- **Demo setup:** one CLI command per staff member, then each phone scans its QR once.
- **Risk:** the phone must have a screen lock; the app says so plainly if it does not.

## Impact

- Every later action (creating a transaction, approving a handover, reversing, reconciling) is now tied to a **named staff member on an enrolled phone**, which is what makes the audit trail meaningful.
- The agent's device key is what Phase 3 uses to **sign each transaction intent**, so an agent cannot later deny entering an amount.

## Benefits

- **For the demo:** students watch a phone enrol by QR and sign in with a fingerprint, and see that a suspended agent is locked out instantly.
- **For the team:** one `requireRole(...)` line per route; no passwords to store, reset or leak.
- **For security reviewers:** private keys never leave phones, tokens are stored hashed, and every authentication event is audited.

---

## Code

Create or overwrite each file below at the path in its heading, with exactly this content.

### `README.md`

````markdown
# BharatPoint

Rural agent-banking and micro-ATM **simulation**: an agent serves a customer's cash-in or
cash-out, and the customer independently confirms the exact amount before any money moves.

> Demo software. Every bank, customer, biometric and bank response is simulated.
> It is not an approved banking or AePS system.

- Architecture, threat model and plan: [docs/ARCHITECTURE_AUDIT.md](docs/ARCHITECTURE_AUDIT.md)
- Build prompt for coding agents: [docs/BUILD_SCAFFOLD_PROMPT.md](docs/BUILD_SCAFFOLD_PROMPT.md)

## Layout

```
backend/   Express 5 + TypeScript API, PostgreSQL (one backend, one database)
mobile/    Expo Go app (Expo Router): agent, customer simulator, admin, bank screens
docs/      audit and build prompt
docker-compose.yml   Postgres (loopback only)
```

## Run it (Windows, PowerShell or Git Bash)

Prerequisites: Node 22+, Docker Desktop, Expo Go on each phone, phones and laptop on the same Wi-Fi.

```bash
cp .env.example .env               # set POSTGRES_PASSWORD and the same password in DATABASE_URL
docker compose up -d               # Postgres on 127.0.0.1:5432

cd backend
npm install
npm run db:migrate
npm test
npm run dev                        # http://127.0.0.1:4000/health

# first staff member (prints a one-time enrolment QR in the terminal)
npm run staff:invite -- --role ADMIN --code AD-001 --name "Your name"
npm run staff:invite -- --role AGENT --code AG-001 --name "Agent name" --location "Village"

cd ../mobile
cp .env.example .env               # EXPO_PUBLIC_API_URL=http://<laptop LAN IP>:4000
npm install
npx expo start                     # scan the QR with Expo Go
```

For phones to reach the API, set `HOST=0.0.0.0` in the root `.env` and allow TCP 4000 through
Windows Firewall on **private** networks only. The home screen shows **SERVER: Connected** when it works.

On each staff phone: **Enrol this phone** → scan the invite QR → confirm with fingerprint / screen lock.
The phone keeps its own signing key; the server stores only the public half. A lost phone is cut off
with `POST /api/v1/admin/staff/:id/reset-devices` (admin screen in Phase 8), then re-invited.
````

### `backend/package.json`

````json
{
  "name": "bharatpoint-backend",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "dev": "tsx watch --env-file=../.env src/index.ts",
    "build": "tsc",
    "start": "node --env-file=../.env dist/index.js",
    "typecheck": "tsc --noEmit",
    "db:migrate": "tsx --env-file=../.env src/db/migrate.ts",
    "staff:invite": "tsx --env-file=../.env src/staff/cli.ts",
    "test": "node --env-file-if-exists=../.env --import tsx --test \"src/**/*.test.ts\""
  },
  "dependencies": {
    "express": "^5.3.0",
    "helmet": "^8.3.0",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "@noble/curves": "^2.4.0",
    "@types/express": "^5.0.6",
    "@types/node": "^22.20.5",
    "@types/pg": "^8.23.1",
    "@types/qrcode": "^1.5.6",
    "qrcode": "^1.5.4",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2"
  }
}
````

### `backend/src/config/env.ts`

````ts
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
````

### `backend/src/api/errors.ts`

````ts
/**
 * Failure catalogue + global error handler. Adapted from PRISM@680037b
 * (backend/src/api/errors.ts, middleware/errorHandler.ts).
 *
 * Every refusal has a code. The web app switches on these, the security test
 * harness asserts on them, and the audit log records them. Add codes here as
 * the routes that raise them are built.
 */
import type { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly failureCode: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const FAILURES = {
  VALIDATION_FAILED: [400, 'The request is missing or has an invalid field.'],
  AUTH_FAILED: [401, 'Authentication failed.'],
  FORBIDDEN: [403, 'You do not have access to this.'],
  NOT_FOUND: [404, 'Not found.'],
  ALREADY_EXISTS: [409, 'That already exists.'],
  INTERNAL_ERROR: [500, 'Internal server error.'],
} as const;

/** Postgres unique_violation, for turning a duplicate into a 409 instead of a 500. */
export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

export type FailureCode = keyof typeof FAILURES;

export function fail(code: FailureCode, details?: Record<string, unknown>): never {
  const [status, message] = FAILURES[code];
  throw new AppError(status, code, message, details);
}

/** One response shape, { failureCode, message, details? }, for every error. */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      failureCode: err.failureCode,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  // Unexpected: log in full, tell the caller nothing useful to an attacker.
  console.error('[api]', err.stack ?? err.message);
  res.status(500).json({ failureCode: 'INTERNAL_ERROR', message: FAILURES.INTERNAL_ERROR[1] });
}
````

### `backend/src/api/validate.ts`

````ts
/**
 * Input checks at the API boundary. Bad input is a 400 with the field name,
 * never a 500 from Postgres. Deliberately tiny: add a check here when a route
 * needs one, not before.
 */
import { fail } from './errors';

type Body = Record<string, unknown> | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function str(body: Body, field: string, opts: { max?: number; pattern?: RegExp } = {}): string {
  const raw = body?.[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > (opts.max ?? 200) || (opts.pattern && !opts.pattern.test(value))) {
    fail('VALIDATION_FAILED', { field });
  }
  return value;
}

export function optionalStr(body: Body, field: string, opts: { max?: number; pattern?: RegExp } = {}): string | null {
  return body?.[field] === undefined || body?.[field] === null || body?.[field] === '' ? null : str(body, field, opts);
}

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('VALIDATION_FAILED', { field });
  return value;
}
````

### `backend/src/db/pool.ts`

````ts
/**
 * PostgreSQL connection pool. Adapted from PRISM@680037b (backend/src/db/pool.ts).
 *
 * One shared pool for the whole backend; never create another Pool.
 * Use getClient() for any multi-statement transaction, and always release it.
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

// An idle-client error is usually transient; log it rather than crash.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => pool.query<T>(text, params);

export const getClient = (): Promise<PoolClient> => pool.connect();

/** Run fn inside BEGIN/COMMIT on one client; ROLLBACK and rethrow on any error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
````

### `backend/src/db/audit.ts`

````ts
/**
 * Audit writes go through the caller's DB client, so the audit row commits or
 * rolls back together with the change it records. PRISM logged best-effort,
 * after commit, and swallowed failures (audit F-04); here a failed audit write
 * fails the whole operation.
 */
import type { PoolClient } from 'pg';

export type AuditEvent =
  | 'STAFF_CREATED'
  | 'INVITE_CREATED'
  | 'DEVICE_ENROLLED'
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'SESSION_REVOKED'
  | 'STAFF_SUSPENDED'
  | 'DEVICES_RESET';

export async function audit(
  client: PoolClient,
  event: AuditEvent,
  opts: { actorUserId?: string | null; transactionId?: string | null; data?: Record<string, unknown> } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, transaction_id, event_type, event_data) VALUES ($1, $2, $3, $4)`,
    [opts.actorUserId ?? null, opts.transactionId ?? null, event, JSON.stringify(opts.data ?? {})]
  );
}
````

### `backend/src/db/migrations/0005_auth.sql`

````sql
-- ============================================================
-- 0005: staff sign-in.
--
-- Login is challenge-response: the server issues a random nonce, the phone
-- signs it with its device key (behind the phone's biometric prompt), and
-- the server verifies the signature against the enrolled public key. Each
-- challenge is single-use and short-lived, so a captured signature cannot
-- be replayed to open a second session.
-- ============================================================

-- Invites created by the trusted local CLI (npm run staff:invite, run on the
-- server machine) have no creating user. Invites created through the admin
-- API always record the admin.
ALTER TABLE enrolment_invites ALTER COLUMN created_by DROP NOT NULL;

CREATE TABLE auth_challenges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_key_id UUID        NOT NULL REFERENCES device_keys(id),
  nonce         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_auth_challenges_expiry ON auth_challenges (expires_at);
````

### `backend/src/auth/crypto.ts`

````ts
/**
 * Device-key cryptography for staff sign-in.
 *
 * The phone holds an Ed25519 private key (generated with @noble/curves, kept
 * in expo-secure-store, unlocked by the phone's biometric prompt). The server
 * only ever sees the 32-byte public key and verifies signatures with Node's
 * built-in Ed25519.
 *
 * Every signed message starts with a purpose string, so a signature made for
 * enrolment can never be replayed as a login, and vice versa. The phone builds
 * the exact same strings in mobile/src/lib/device-key.ts: keep them identical.
 */
import crypto from 'crypto';

// DER header that turns a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const enrolMessage = (inviteToken: string) => `bharatpoint/enrol/v1\n${inviteToken}`;
export const loginMessage = (challengeId: string, nonce: string) => `bharatpoint/login/v1\n${challengeId}\n${nonce}`;

/** QR payload for an enrolment invite; the phone's scanner expects this prefix. */
export const inviteQrPayload = (token: string) => `bharatpoint-invite:${token}`;

export function verifyEd25519(publicKey: Buffer, message: string, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, signature);
}

/** 32 random bytes, base64url. Used for invite tokens, session tokens and nonces. */
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** Tokens are stored only as hashes, so a database leak does not leak live tokens. */
export const sha256Hex = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/** Decode base64url, returning null on anything malformed. */
export function fromBase64url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
}
````

### `backend/src/auth/middleware.ts`

````ts
/**
 * Who is calling, and may they do this?
 *
 * authenticate() turns a Bearer token into req.auth by looking the session up
 * in Postgres on every request. Role, suspension and revocation are therefore
 * read fresh each time: suspending an agent or revoking a lost phone takes
 * effect on their very next request, not when a token expires.
 *
 * requireRole() is the access check every protected route declares. Hiding a
 * screen in the app is not access control; this is.
 */
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/pool';
import { fail } from '../api/errors';
import { sha256Hex } from './crypto';

export type Role = 'AGENT' | 'ADMIN' | 'BANK_OPERATOR';

export interface Auth {
  sessionId: string;
  userId: string;
  staffCode: string;
  displayName: string;
  role: Role;
  bankId: string | null; // BANK_OPERATOR only
  agentId: string | null; // AGENT only
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const { rows } = await query<Auth>(
      `SELECT s.id AS "sessionId", u.id AS "userId", u.staff_code AS "staffCode",
              u.display_name AS "displayName", u.role, u.bank_id AS "bankId", a.id AS "agentId"
         FROM sessions s
         JOIN users u       ON u.id = s.user_id
         JOIN device_keys d ON d.id = s.device_key_id
         LEFT JOIN agents a ON a.user_id = u.id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL AND s.expires_at > NOW()
          AND d.revoked_at IS NULL
          AND u.status = 'ACTIVE'`,
      [sha256Hex(header.slice(7).trim())]
    );
    if (rows[0]) req.auth = rows[0];
  }
  next();
}

/** Any signed-in staff member when called with no roles; otherwise only those roles. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) fail('AUTH_FAILED');
    if (roles.length > 0 && !roles.includes(req.auth.role)) fail('FORBIDDEN');
    next();
  };
````

### `backend/src/auth/routes.ts`

````ts
/**
 * Staff enrolment and sign-in.
 *
 *   enrol:   invite token + new device public key + signature over the token
 *   login:   POST /auth/challenge -> sign the nonce on the phone -> POST /auth/login
 *   logout:  revokes the session server-side
 *
 * Every failure is the same AUTH_FAILED, so a caller cannot tell an unknown
 * invite from a spent or expired one, or a revoked key from a wrong signature.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail, isUniqueViolation } from '../api/errors';
import { optionalStr, str, uuid } from '../api/validate';
import { config } from '../config/env';
import { enrolMessage, fromBase64url, loginMessage, randomToken, sha256Hex, verifyEd25519 } from './crypto';
import { requireRole, type Auth } from './middleware';

const CHALLENGE_TTL_SECONDS = 60;

const router = Router();

router.post('/auth/enrol', async (req, res) => {
  const inviteToken = str(req.body, 'inviteToken', { max: 100 });
  const label = optionalStr(req.body, 'label', { max: 60 });
  const publicKey = fromBase64url(req.body?.publicKey);
  const signature = fromBase64url(req.body?.signature);
  if (!publicKey || publicKey.length !== 32) fail('VALIDATION_FAILED', { field: 'publicKey' });
  if (!signature) fail('VALIDATION_FAILED', { field: 'signature' });

  // Proof the caller holds the private key, checked before the invite is
  // touched: a bad signature must not burn someone's invite.
  if (!verifyEd25519(publicKey, enrolMessage(inviteToken), signature)) fail('AUTH_FAILED');

  try {
    const result = await withTransaction(async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string }>(
        `SELECT i.id, i.user_id
           FROM enrolment_invites i JOIN users u ON u.id = i.user_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW() AND u.status = 'ACTIVE'
          FOR UPDATE OF i`,
        [sha256Hex(inviteToken)]
      );
      const invite = rows[0];
      if (!invite) fail('AUTH_FAILED');

      await c.query(`UPDATE enrolment_invites SET used_at = NOW() WHERE id = $1`, [invite.id]);
      const key = (
        await c.query<{ id: string }>(
          `INSERT INTO device_keys (user_id, public_key, label) VALUES ($1, $2, $3) RETURNING id`,
          [invite.user_id, publicKey, label]
        )
      ).rows[0]!;
      await audit(c, 'DEVICE_ENROLLED', { actorUserId: invite.user_id, data: { deviceKeyId: key.id, label } });
      return { deviceKeyId: key.id };
    });
    res.status(201).json(result);
  } catch (err) {
    if (isUniqueViolation(err)) fail('ALREADY_EXISTS', { field: 'publicKey' });
    throw err;
  }
});

router.post('/auth/challenge', async (req, res) => {
  const deviceKeyId = uuid(req.body?.deviceKeyId, 'deviceKeyId');
  const { rows } = await query(
    `SELECT 1 FROM device_keys d JOIN users u ON u.id = d.user_id
      WHERE d.id = $1 AND d.revoked_at IS NULL AND u.status = 'ACTIVE'`,
    [deviceKeyId]
  );
  if (!rows[0]) fail('AUTH_FAILED');

  const nonce = randomToken();
  const challenge = (
    await query<{ id: string; expires_at: Date }>(
      `INSERT INTO auth_challenges (device_key_id, nonce, expires_at)
       VALUES ($1, $2, NOW() + make_interval(secs => $3)) RETURNING id, expires_at`,
      [deviceKeyId, nonce, CHALLENGE_TTL_SECONDS]
    )
  ).rows[0]!;
  res.json({ challengeId: challenge.id, nonce, expiresAt: challenge.expires_at });
});

router.post('/auth/login', async (req, res) => {
  const challengeId = uuid(req.body?.challengeId, 'challengeId');
  const signature = fromBase64url(req.body?.signature);
  if (!signature) fail('VALIDATION_FAILED', { field: 'signature' });

  // Consume the challenge first, in its own statement: one attempt per
  // challenge whatever the outcome, so a signature can never be replayed.
  const { rows } = await query<{ nonce: string; device_key_id: string; public_key: Buffer; user_id: string }>(
    `UPDATE auth_challenges c SET used_at = NOW()
       FROM device_keys d JOIN users u ON u.id = d.user_id
      WHERE c.id = $1 AND c.used_at IS NULL AND c.expires_at > NOW()
        AND d.id = c.device_key_id AND d.revoked_at IS NULL AND u.status = 'ACTIVE'
      RETURNING c.nonce, d.id AS device_key_id, d.public_key, u.id AS user_id`,
    [challengeId]
  );
  const challenge = rows[0];
  if (!challenge) fail('AUTH_FAILED');

  const verified = verifyEd25519(challenge.public_key, loginMessage(challengeId, challenge.nonce), signature);
  const token = randomToken();

  const session = await withTransaction(async (c) => {
    if (!verified) {
      await audit(c, 'LOGIN_FAILED', { actorUserId: challenge.user_id, data: { deviceKeyId: challenge.device_key_id } });
      return null;
    }
    const s = (
      await c.query<{ id: string; expires_at: Date }>(
        `INSERT INTO sessions (token_hash, user_id, device_key_id, expires_at)
         VALUES ($1, $2, $3, NOW() + make_interval(hours => $4)) RETURNING id, expires_at`,
        [sha256Hex(token), challenge.user_id, challenge.device_key_id, config.sessionTtlHours]
      )
    ).rows[0]!;
    await c.query(`UPDATE device_keys SET last_used_at = NOW() WHERE id = $1`, [challenge.device_key_id]);
    await audit(c, 'LOGIN_SUCCEEDED', {
      actorUserId: challenge.user_id,
      data: { deviceKeyId: challenge.device_key_id, sessionId: s.id },
    });
    return s;
  });
  if (!session) fail('AUTH_FAILED');

  res.json({ token, expiresAt: session.expires_at });
});

router.post('/auth/logout', requireRole(), async (req, res) => {
  const auth = req.auth!;
  await withTransaction(async (c) => {
    await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [auth.sessionId]);
    await audit(c, 'SESSION_REVOKED', { actorUserId: auth.userId, data: { sessionId: auth.sessionId, reason: 'logout' } });
  });
  res.status(204).end();
});

router.get('/me', requireRole(), (req, res) => {
  const { sessionId: _sessionId, ...me } = req.auth as Auth;
  res.json(me);
});

export default router;
````

### `backend/src/staff/staff.ts`

````ts
/**
 * Staff lifecycle, shared by the admin API (src/staff/routes.ts) and the local
 * CLI (src/staff/cli.ts). Every function runs on the caller's DB client so the
 * change and its audit row commit together.
 *
 * createdBy / actor is null only for the trusted local CLI.
 */
import type { PoolClient } from 'pg';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { optionalStr, str } from '../api/validate';
import type { Role } from '../auth/middleware';
import { inviteQrPayload, randomToken, sha256Hex } from '../auth/crypto';

export const INVITE_TTL_MINUTES = 30;

export interface NewStaff {
  role: Role;
  staffCode: string;
  displayName: string;
  bankCode: string | null; // BANK_OPERATOR only
  locationName: string | null; // AGENT only
  district: string | null;
  state: string | null;
}

export interface Invite {
  token: string; // shown once, never stored
  qrPayload: string;
  expiresAt: Date;
}

const ROLES: Role[] = ['AGENT', 'ADMIN', 'BANK_OPERATOR'];

/** Validate an untrusted body (API) or argument set (CLI) into a NewStaff. */
export function parseNewStaff(body: Record<string, unknown> | undefined): NewStaff {
  const role = str(body, 'role') as Role;
  if (!ROLES.includes(role)) fail('VALIDATION_FAILED', { field: 'role' });
  return {
    role,
    staffCode: str(body, 'staffCode', { max: 12, pattern: /^[A-Z]{2}-\d{3,6}$/ }),
    displayName: str(body, 'displayName', { max: 80 }),
    bankCode: role === 'BANK_OPERATOR' ? str(body, 'bankCode', { max: 20, pattern: /^[A-Z0-9-]+$/ }) : null,
    locationName: role === 'AGENT' ? str(body, 'locationName', { max: 80 }) : null,
    district: role === 'AGENT' ? optionalStr(body, 'district', { max: 80 }) : null,
    state: role === 'AGENT' ? optionalStr(body, 'state', { max: 80 }) : null,
  };
}

export async function createInvite(
  c: PoolClient,
  userId: string,
  createdBy: string | null,
  ttlMinutes = INVITE_TTL_MINUTES
): Promise<Invite> {
  const token = randomToken();
  const { rows } = await c.query<{ id: string; expires_at: Date }>(
    `INSERT INTO enrolment_invites (user_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(mins => $4)) RETURNING id, expires_at`,
    [userId, sha256Hex(token), createdBy, ttlMinutes]
  );
  const invite = rows[0]!;
  await audit(c, 'INVITE_CREATED', { actorUserId: createdBy, data: { userId, inviteId: invite.id } }); // never the token
  return { token, qrPayload: inviteQrPayload(token), expiresAt: invite.expires_at };
}

export async function createStaff(c: PoolClient, input: NewStaff, createdBy: string | null) {
  let bankId: string | null = null;
  if (input.bankCode) {
    const bank = await c.query<{ id: string }>(`SELECT id FROM banks WHERE code = $1`, [input.bankCode]);
    if (!bank.rows[0]) fail('VALIDATION_FAILED', { field: 'bankCode', reason: 'unknown bank' });
    bankId = bank.rows[0].id;
  }

  const user = (
    await c.query<{ id: string; staff_code: string; display_name: string; role: Role; bank_id: string | null }>(
      `INSERT INTO users (staff_code, display_name, role, bank_id) VALUES ($1, $2, $3, $4)
       RETURNING id, staff_code, display_name, role, bank_id`,
      [input.staffCode, input.displayName, input.role, bankId]
    )
  ).rows[0]!;

  let agentId: string | null = null;
  if (input.role === 'AGENT') {
    agentId = (
      await c.query<{ id: string }>(
        `INSERT INTO agents (user_id, agent_code, location_name, district, state)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user.id, input.staffCode, input.locationName, input.district, input.state]
      )
    ).rows[0]!.id;
  }

  await audit(c, 'STAFF_CREATED', {
    actorUserId: createdBy,
    data: { userId: user.id, staffCode: user.staff_code, role: user.role },
  });

  return {
    user: {
      id: user.id,
      staffCode: user.staff_code,
      displayName: user.display_name,
      role: user.role,
      bankId: user.bank_id,
      agentId,
    },
    invite: await createInvite(c, user.id, createdBy),
  };
}

/** Block the user and end every live session immediately. */
export async function suspendStaff(c: PoolClient, userId: string, actor: string | null): Promise<void> {
  const { rowCount } = await c.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);
  if (!rowCount) fail('NOT_FOUND');
  await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await audit(c, 'STAFF_SUSPENDED', { actorUserId: actor, data: { userId } });
}

/** Lost or replaced phone: revoke every device key and session. A new invite re-enrols. */
export async function resetDevices(c: PoolClient, userId: string, actor: string | null): Promise<void> {
  const exists = await c.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  if (!exists.rows[0]) fail('NOT_FOUND');
  await c.query(`UPDATE device_keys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await audit(c, 'DEVICES_RESET', { actorUserId: actor, data: { userId } });
}
````

### `backend/src/staff/routes.ts`

````ts
/**
 * Admin-only staff management. The admin screens arrive in Phase 8; these
 * routes are what they will call, and what the role-matrix test exercises.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/pool';
import { fail, isUniqueViolation } from '../api/errors';
import { uuid } from '../api/validate';
import { requireRole } from '../auth/middleware';
import { createInvite, createStaff, parseNewStaff, resetDevices, suspendStaff } from './staff';

const router = Router();
router.use('/admin', requireRole('ADMIN'));

router.post('/admin/staff', async (req, res) => {
  const input = parseNewStaff(req.body);
  try {
    res.status(201).json(await withTransaction((c) => createStaff(c, input, req.auth!.userId)));
  } catch (err) {
    if (isUniqueViolation(err)) fail('ALREADY_EXISTS', { field: 'staffCode' });
    throw err;
  }
});

router.post('/admin/staff/:id/invites', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'`, [userId]);
  if (!rows[0]) fail('NOT_FOUND');
  res.status(201).json(await withTransaction((c) => createInvite(c, userId, req.auth!.userId)));
});

router.post('/admin/staff/:id/suspend', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  // An admin suspending themselves would lock the last admin out.
  if (userId === req.auth!.userId) fail('VALIDATION_FAILED', { field: 'id', reason: 'cannot suspend yourself' });
  await withTransaction((c) => suspendStaff(c, userId, req.auth!.userId));
  res.status(204).end();
});

router.post('/admin/staff/:id/reset-devices', async (req, res) => {
  const userId = uuid(req.params.id, 'id');
  await withTransaction((c) => resetDevices(c, userId, req.auth!.userId));
  res.status(204).end();
});

export default router;
````

### `backend/src/staff/cli.ts`

````ts
/**
 * Local staff bootstrap, run on the server machine (trusted operator).
 * Creates a staff member and prints their one-time enrolment QR in the
 * terminal; the phone scans it on the "Enrol this phone" screen.
 *
 *   npm run staff:invite -- --role ADMIN --code AD-001 --name "Meena"
 *   npm run staff:invite -- --role AGENT --code AG-001 --name "Ravi" --location "Kothapalli" [--district X] [--state Y]
 *   npm run staff:invite -- --role BANK_OPERATOR --code BO-001 --name "Arjun" --bank DEMO-SBI
 *   npm run staff:invite -- --reinvite AG-001        (new invite for existing staff)
 */
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import pool, { withTransaction } from '../db/pool';
import { AppError } from '../api/errors';
import { createInvite, createStaff, parseNewStaff, type Invite } from './staff';

async function main() {
  const { values } = parseArgs({
    options: {
      role: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      location: { type: 'string' },
      district: { type: 'string' },
      state: { type: 'string' },
      bank: { type: 'string' },
      reinvite: { type: 'string' },
    },
  });

  let invite: Invite;
  let who: string;
  if (values.reinvite) {
    const user = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM users WHERE staff_code = $1 AND status = 'ACTIVE'`,
      [values.reinvite]
    );
    if (!user.rows[0]) throw new Error(`no active staff member with code ${values.reinvite}`);
    invite = await withTransaction((c) => createInvite(c, user.rows[0]!.id, null));
    who = `${user.rows[0].display_name} (${values.reinvite})`;
  } else {
    const input = parseNewStaff({
      role: values.role,
      staffCode: values.code,
      displayName: values.name,
      locationName: values.location,
      district: values.district,
      state: values.state,
      bankCode: values.bank,
    });
    const created = await withTransaction((c) => createStaff(c, input, null));
    invite = created.invite;
    who = `${created.user.displayName} (${created.user.staffCode}, ${created.user.role})`;
  }

  console.log(`\nEnrolment invite for ${who}`);
  console.log(`Scan this on the phone (Enrol this phone). Valid until ${invite.expiresAt.toLocaleString()}, once.\n`);
  console.log(await QRCode.toString(invite.qrPayload, { type: 'terminal', small: true }));
  console.log(`Or type this code: ${invite.token}\n`);
}

main()
  .catch((err) => {
    const detail = err instanceof AppError ? `${err.failureCode} ${JSON.stringify(err.details ?? {})}` : err.message;
    console.error(`[staff:invite] ${detail}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
````

### `backend/src/app.ts`

````ts
/**
 * The Express app, without listening, so tests can start it on a random port.
 *
 * Express 5 forwards rejected promises from async handlers to the error
 * handler on its own, so PRISM's wrap() helper is not needed here.
 */
import express from 'express';
import helmet from 'helmet';
import pool from './db/pool';
import { errorHandler } from './api/errors';
import { authenticate } from './auth/middleware';
import authRoutes from './auth/routes';
import staffRoutes from './staff/routes';

export function createApp() {
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

  // Every /api/v1 route sees req.auth (or not); each declares its own requireRole.
  app.use('/api/v1', authenticate, authRoutes, staffRoutes);

  app.use(errorHandler);
  return app;
}
````

### `backend/src/index.ts`

````ts
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
````

### `backend/src/auth/crypto.test.ts`

````ts
/**
 * The phone signs with @noble/curves; the server verifies with Node's crypto.
 * This pins that the two agree, and that signatures are bound to their purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { enrolMessage, loginMessage, verifyEd25519 } from './crypto';

test('a signature made by @noble/curves (the phone) verifies on the server', async () => {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const secret = crypto.randomBytes(32);
  const publicKey = Buffer.from(ed25519.getPublicKey(secret));
  const message = loginMessage(crypto.randomUUID(), 'nonce-123');
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret));

  assert.equal(verifyEd25519(publicKey, message, signature), true);

  // Bound to its purpose: the same signature is not a valid enrolment.
  assert.equal(verifyEd25519(publicKey, enrolMessage('nonce-123'), signature), false);

  const tampered = Buffer.from(signature);
  tampered[0] = tampered[0]! ^ 1;
  assert.equal(verifyEd25519(publicKey, message, tampered), false);
});

test('wrong-length keys and signatures are rejected without throwing', () => {
  assert.equal(verifyEd25519(Buffer.alloc(31), 'x', Buffer.alloc(64)), false);
  assert.equal(verifyEd25519(crypto.randomBytes(32), 'x', Buffer.alloc(10)), false);
});
````

### `backend/src/auth/auth.test.ts`

````ts
/**
 * Phase 2: staff enrolment, sign-in and role checks, exercised over real HTTP
 * against a throwaway database (created from DATABASE_URL, dropped after).
 * Reported as SKIPPED when DATABASE_URL is not set.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Server } from 'http';
import { Pool } from 'pg';
import { migrate } from '../db/migrate';
import { enrolMessage, loginMessage } from './crypto';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set; start Postgres to run the auth tests';

/** A simulated phone: an Ed25519 key pair, as the app would hold. */
function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x!, // raw 32 bytes, base64url
    sign: (message: string) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
}
type Device = ReturnType<typeof newDevice>;

describe('staff sign-in and roles', { skip }, () => {
  const dbName = `bp_test_${crypto.randomBytes(4).toString('hex')}`;
  let admin: Pool;
  let server: Server;
  let base: string;
  let app: {
    pool: Pool;
    withTransaction: typeof import('../db/pool').withTransaction;
    staff: typeof import('../staff/staff');
  };

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  let seq = 0;
  /** Create a staff member directly (as the CLI would) and return their invite token. */
  const newStaff = async (role: 'AGENT' | 'ADMIN' | 'BANK_OPERATOR') => {
    const code = `${role.slice(0, 2)}-${String(++seq).padStart(3, '0')}`;
    const input = app.staff.parseNewStaff({
      role,
      staffCode: code,
      displayName: `Test ${code}`,
      locationName: 'Kothapalli',
      bankCode: 'DEMO-SBI',
    });
    const created = await app.withTransaction((c) => app.staff.createStaff(c, input, null));
    return { userId: created.user.id, inviteToken: created.invite.token };
  };

  const enrol = (device: Device, inviteToken: string, signer: Device = device) =>
    call('POST', '/auth/enrol', {
      inviteToken,
      publicKey: device.publicKey,
      signature: signer.sign(enrolMessage(inviteToken)),
    });

  const login = async (deviceKeyId: string, signer: Device) => {
    const ch = await call('POST', '/auth/challenge', { deviceKeyId });
    if (ch.status !== 200) return { ...ch, challenge: null };
    const signature = signer.sign(loginMessage(ch.body.challengeId, ch.body.nonce));
    const res = await call('POST', '/auth/login', { challengeId: ch.body.challengeId, signature });
    return { ...res, challenge: { challengeId: ch.body.challengeId, signature } };
  };

  /** Staff member who has enrolled a phone and signed in. */
  const signedIn = async (role: 'AGENT' | 'ADMIN' | 'BANK_OPERATOR') => {
    const s = await newStaff(role);
    const device = newDevice();
    const enrolled = await enrol(device, s.inviteToken);
    assert.equal(enrolled.status, 201);
    const res = await login(enrolled.body.deviceKeyId, device);
    assert.equal(res.status, 200);
    return { ...s, device, deviceKeyId: enrolled.body.deviceKeyId as string, token: res.body.token as string };
  };

  before(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const testUrl = new URL(url!);
    testUrl.pathname = `/${dbName}`;
    process.env.DATABASE_URL = testUrl.toString(); // the app's pool reads this on import

    // Loaded only now, after DATABASE_URL points at the throwaway database.
    const poolModule: typeof import('../db/pool') = require('../db/pool');
    app = { pool: poolModule.default, withTransaction: poolModule.withTransaction, staff: require('../staff/staff') };
    await migrate(app.pool, () => {});
    await app.pool.query(`INSERT INTO banks (code, display_name) VALUES ('DEMO-SBI', 'Demo State Bank')`);

    const { createApp }: typeof import('../app') = require('../app');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await app?.pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  test('an invite enrols exactly one device', async () => {
    const s = await newStaff('AGENT');
    assert.equal((await enrol(newDevice(), s.inviteToken)).status, 201);
    assert.equal((await enrol(newDevice(), s.inviteToken)).status, 401);
  });

  test('an expired invite is refused', async () => {
    const s = await newStaff('AGENT');
    await app.pool.query(
      `UPDATE enrolment_invites SET created_at = NOW() - interval '2 hours', expires_at = NOW() - interval '1 hour'
        WHERE user_id = $1`,
      [s.userId]
    );
    assert.equal((await enrol(newDevice(), s.inviteToken)).status, 401);
  });

  test('enrolment needs a signature from the key being enrolled, and a bad one does not burn the invite', async () => {
    const s = await newStaff('AGENT');
    const device = newDevice();
    assert.equal((await enrol(device, s.inviteToken, newDevice())).status, 401);
    assert.equal((await enrol(device, s.inviteToken)).status, 201);
  });

  test('sign-in returns a session that reports the role', async () => {
    const agent = await signedIn('AGENT');
    const me = await call('GET', '/me', undefined, agent.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'AGENT');
    assert.ok(me.body.agentId);
    assert.equal(me.body.sessionId, undefined);
  });

  test('a signature from another device key cannot sign in', async () => {
    const agent = await signedIn('AGENT');
    assert.equal((await login(agent.deviceKeyId, newDevice())).status, 401);
  });

  test('a login challenge works once', async () => {
    const agent = await signedIn('AGENT');
    const first = await login(agent.deviceKeyId, agent.device);
    assert.equal(first.status, 200);
    assert.equal((await call('POST', '/auth/login', first.challenge)).status, 401);
  });

  test('logout revokes the session on the server', async () => {
    const agent = await signedIn('AGENT');
    assert.equal((await call('POST', '/auth/logout', {}, agent.token)).status, 204);
    assert.equal((await call('GET', '/me', undefined, agent.token)).status, 401);
  });

  test('suspending a user ends their live sessions and blocks new sign-ins', async () => {
    const boss = await signedIn('ADMIN');
    const agent = await signedIn('AGENT');
    assert.equal((await call('POST', `/admin/staff/${agent.userId}/suspend`, {}, boss.token)).status, 204);
    assert.equal((await call('GET', '/me', undefined, agent.token)).status, 401);
    assert.equal((await login(agent.deviceKeyId, agent.device)).status, 401);
  });

  test('an admin cannot suspend themselves', async () => {
    const boss = await signedIn('ADMIN');
    assert.equal((await call('POST', `/admin/staff/${boss.userId}/suspend`, {}, boss.token)).status, 400);
  });

  test('a lost phone is reset; a new invite enrols the replacement', async () => {
    const boss = await signedIn('ADMIN');
    const agent = await signedIn('AGENT');
    assert.equal((await call('POST', `/admin/staff/${agent.userId}/reset-devices`, {}, boss.token)).status, 204);
    assert.equal((await call('GET', '/me', undefined, agent.token)).status, 401);
    assert.equal((await login(agent.deviceKeyId, agent.device)).status, 401);

    const invite = await call('POST', `/admin/staff/${agent.userId}/invites`, {}, boss.token);
    assert.equal(invite.status, 201);
    const phone = newDevice();
    const enrolled = await enrol(phone, invite.body.token);
    assert.equal(enrolled.status, 201);
    assert.equal((await login(enrolled.body.deviceKeyId, phone)).status, 200);
  });

  test('role matrix: only ADMIN may manage staff; everyone signed in may read /me', async () => {
    const tokens = {
      none: undefined,
      AGENT: (await signedIn('AGENT')).token,
      BANK_OPERATOR: (await signedIn('BANK_OPERATOR')).token,
      ADMIN: (await signedIn('ADMIN')).token,
    };
    const expectations: { who: keyof typeof tokens; me: number; createStaff: number }[] = [
      { who: 'none', me: 401, createStaff: 401 },
      { who: 'AGENT', me: 200, createStaff: 403 },
      { who: 'BANK_OPERATOR', me: 200, createStaff: 403 },
      { who: 'ADMIN', me: 200, createStaff: 201 },
    ];
    for (const e of expectations) {
      const token = tokens[e.who];
      assert.equal((await call('GET', '/me', undefined, token)).status, e.me, `${e.who} GET /me`);
      const body = { role: 'ADMIN', staffCode: `AD-9${String(++seq).padStart(3, '0')}`, displayName: 'New admin' };
      assert.equal((await call('POST', '/admin/staff', body, token)).status, e.createStaff, `${e.who} POST /admin/staff`);
    }
  });

  test('a garbage bearer token is just unauthenticated', async () => {
    assert.equal((await call('GET', '/me', undefined, 'not-a-real-token')).status, 401);
  });

  test('bad input is a 400, never a 500', async () => {
    const boss = await signedIn('ADMIN');
    assert.equal((await call('POST', '/auth/challenge', { deviceKeyId: 'not-a-uuid' })).status, 400);
    assert.equal((await call('POST', '/auth/enrol', {})).status, 400);
    assert.equal((await call('POST', '/auth/login', { challengeId: crypto.randomUUID() })).status, 400);
    assert.equal((await call('POST', '/admin/staff', { role: 'ROOT' }, boss.token)).status, 400);
    assert.equal((await call('POST', '/admin/staff/not-a-uuid/suspend', {}, boss.token)).status, 400);
    const unknownBank = { role: 'BANK_OPERATOR', staffCode: 'BO-777', displayName: 'X', bankCode: 'NOPE' };
    assert.equal((await call('POST', '/admin/staff', unknownBank, boss.token)).status, 400);
  });

  test('a duplicate staff code is a 409', async () => {
    const boss = await signedIn('ADMIN');
    const body = { role: 'ADMIN', staffCode: 'AD-555', displayName: 'Dup' };
    assert.equal((await call('POST', '/admin/staff', body, boss.token)).status, 201);
    assert.equal((await call('POST', '/admin/staff', body, boss.token)).status, 409);
  });
});
````

### `mobile/package.json`

````json
{
  "name": "bharatpoint-mobile",
  "main": "expo-router/entry",
  "version": "1.0.0",
  "dependencies": {
    "@expo/ui": "~57.0.23",
    "@noble/curves": "^2.4.0",
    "expo": "~57.0.28",
    "expo-camera": "~57.0.6",
    "expo-constants": "~57.0.21",
    "expo-crypto": "~57.0.4",
    "expo-device": "~57.0.2",
    "expo-font": "~57.0.4",
    "expo-glass-effect": "~57.0.4",
    "expo-image": "~57.0.5",
    "expo-linking": "~57.0.12",
    "expo-local-authentication": "~57.0.3",
    "expo-router": "~57.0.26",
    "expo-secure-store": "~57.0.4",
    "expo-splash-screen": "~57.0.10",
    "expo-status-bar": "~57.0.1",
    "expo-symbols": "~57.0.3",
    "expo-system-ui": "~57.0.4",
    "expo-web-browser": "~57.0.3",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "react-native": "0.86.3",
    "react-native-gesture-handler": "~2.32.0",
    "react-native-reanimated": "4.5.1",
    "react-native-safe-area-context": "~5.7.0",
    "react-native-screens": "~4.26.0",
    "react-native-web": "~0.21.0",
    "react-native-worklets": "0.10.1"
  },
  "devDependencies": {
    "@types/react": "~19.2.2",
    "eslint": "^9.0.0",
    "eslint-config-expo": "~57.0.2",
    "typescript": "~6.0.3"
  },
  "scripts": {
    "start": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web",
    "lint": "expo lint",
    "typecheck": "tsc --noEmit"
  },
  "private": true
}
````

### `mobile/app.json`

````json
{
  "expo": {
    "name": "BharatPoint",
    "slug": "bharatpoint",
    "version": "1.0.0",
    "orientation": "portrait",
    "scheme": "bharatpoint",
    "userInterfaceStyle": "automatic",
    "android": {
      "predictiveBackGestureEnabled": false
    },
    "plugins": [
      "expo-router",
      "expo-secure-store"
    ],
    "experiments": {
      "typedRoutes": true,
      "reactCompiler": true
    }
  }
}
````

### `mobile/src/lib/api.ts`

````ts
/**
 * The one way the app talks to the backend.
 *
 * Phones reach the backend over the LAN, so EXPO_PUBLIC_API_URL must be the
 * laptop's LAN address (e.g. http://192.168.1.20:4000), never localhost: on
 * the phone, localhost is the phone itself.
 *
 * Errors come back in the backend's single shape { failureCode, message },
 * so screens switch on failureCode rather than parsing strings. The staff
 * session token lives in expo-secure-store and is sent as a Bearer token.
 */
import * as SecureStore from 'expo-secure-store';

const BASE = process.env.EXPO_PUBLIC_API_URL;
const TOKEN = 'bp.session.token';
const STORE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const getSessionToken = () => SecureStore.getItemAsync(TOKEN, STORE);
export const setSessionToken = (token: string) => SecureStore.setItemAsync(TOKEN, token, STORE);
export const clearSessionToken = () => SecureStore.deleteItemAsync(TOKEN, STORE);

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly failureCode: string,
    message: string
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!BASE) {
    throw new ApiError(0, 'CONFIG', 'EXPO_PUBLIC_API_URL is not set. See mobile/.env.example.');
  }
  const token = await getSessionToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', `Cannot reach ${BASE}. Same Wi-Fi as the laptop?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.failureCode ?? 'HTTP_ERROR', body.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}
````

### `mobile/src/lib/device-key.ts`

````ts
/**
 * This phone's staff signing key.
 *
 * An Ed25519 key generated on the phone, stored in expo-secure-store (this
 * device only, never backed up), and used only after the phone's own
 * biometric / screen-lock prompt succeeds. The server stores only the public
 * key, so a server breach cannot forge a staff signature.
 *
 * The message strings below must match backend/src/auth/crypto.ts exactly.
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { getRandomBytes } from 'expo-crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

export const enrolMessage = (inviteToken: string) => `bharatpoint/enrol/v1\n${inviteToken}`;
export const loginMessage = (challengeId: string, nonce: string) => `bharatpoint/login/v1\n${challengeId}\n${nonce}`;

const SEED = 'bp.deviceKey.seed';
const KEY_ID = 'bp.deviceKey.id';
const STORE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Ask the phone's owner to prove presence. Throws with a readable reason if they cannot. */
async function confirmPresence(reason: string): Promise<void> {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
  if (result.success) return;
  if (result.error === 'not_enrolled' || result.error === 'passcode_not_set') {
    throw new Error('Set a screen lock (fingerprint or PIN) on this phone to use BharatPoint.');
  }
  throw new Error('Verification was cancelled.');
}

/** A fresh key pair. Nothing is stored until the server has accepted it (see saveDeviceKey). */
export function newDeviceKey() {
  const seed = getRandomBytes(32);
  return { seed, publicKey: toBase64url(ed25519.getPublicKey(seed)) };
}

export async function saveDeviceKey(seed: Uint8Array, deviceKeyId: string): Promise<void> {
  await SecureStore.setItemAsync(SEED, toBase64url(seed), STORE);
  await SecureStore.setItemAsync(KEY_ID, deviceKeyId, STORE);
}

export const getDeviceKeyId = () => SecureStore.getItemAsync(KEY_ID, STORE);

/** Sign with a key held in memory (enrolment, before it is saved). */
export async function signWithSeed(seed: Uint8Array, message: string, reason: string): Promise<string> {
  await confirmPresence(reason);
  return toBase64url(ed25519.sign(new TextEncoder().encode(message), seed));
}

/** Sign with this phone's saved key. */
export async function signWithDeviceKey(message: string, reason: string): Promise<string> {
  const stored = await SecureStore.getItemAsync(SEED, STORE);
  if (!stored) throw new Error('This phone is not enrolled.');
  return signWithSeed(fromBase64url(stored), message, reason);
}
````

### `mobile/src/lib/session.ts`

````ts
/**
 * Staff enrolment and sign-in from the phone. See backend/src/auth/routes.ts.
 */
import * as Device from 'expo-device';
import { api, ApiError, clearSessionToken, getSessionToken, setSessionToken } from './api';
import { enrolMessage, getDeviceKeyId, loginMessage, newDeviceKey, saveDeviceKey, signWithDeviceKey, signWithSeed } from './device-key';

export type Role = 'AGENT' | 'ADMIN' | 'BANK_OPERATOR';

export interface Me {
  userId: string;
  staffCode: string;
  displayName: string;
  role: Role;
  bankId: string | null;
  agentId: string | null;
}

export const INVITE_PREFIX = 'bharatpoint-invite:';

const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Turn an invite into this phone's enrolled key, then sign in. */
export async function enrolThisPhone(inviteToken: string): Promise<void> {
  const key = newDeviceKey();
  const signature = await signWithSeed(key.seed, enrolMessage(inviteToken), 'Enrol this phone for BharatPoint');
  const { deviceKeyId } = await post<{ deviceKeyId: string }>('/api/v1/auth/enrol', {
    inviteToken,
    publicKey: key.publicKey,
    signature,
    label: Device.modelName ?? 'Phone',
  });
  await saveDeviceKey(key.seed, deviceKeyId);
  await signIn();
}

export async function signIn(): Promise<void> {
  const deviceKeyId = await getDeviceKeyId();
  if (!deviceKeyId) throw new Error('This phone is not enrolled.');
  const challenge = await post<{ challengeId: string; nonce: string }>('/api/v1/auth/challenge', { deviceKeyId });
  const signature = await signWithDeviceKey(
    loginMessage(challenge.challengeId, challenge.nonce),
    'Sign in to BharatPoint'
  );
  const { token } = await post<{ token: string }>('/api/v1/auth/login', {
    challengeId: challenge.challengeId,
    signature,
  });
  await setSessionToken(token);
}

export async function signOut(): Promise<void> {
  try {
    await post('/api/v1/auth/logout', {});
  } finally {
    await clearSessionToken();
  }
}

/** The signed-in staff member, or null (and the stale token dropped) if the session is gone. */
export async function loadMe(): Promise<Me | null> {
  if (!(await getSessionToken())) return null;
  try {
    return await api<Me>('/api/v1/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await clearSessionToken();
      return null;
    }
    throw e;
  }
}

export const isEnrolled = async () => (await getDeviceKeyId()) !== null;
````

### `mobile/src/app/_layout.tsx`

````tsx
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '@/lib/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.panel },
          headerTintColor: colors.accent,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'BharatPoint' }} />
        <Stack.Screen name="enrol" options={{ title: 'Enrol this phone' }} />
        <Stack.Screen name="agent/index" options={{ title: 'Agent ATM' }} />
        <Stack.Screen name="admin/index" options={{ title: 'Admin' }} />
        <Stack.Screen name="bank/index" options={{ title: 'Bank operations' }} />
        <Stack.Screen name="customer/index" options={{ title: 'Customer phone (simulator)' }} />
      </Stack>
    </>
  );
}
````

### `mobile/src/app/index.tsx`

````tsx
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router, useFocusEffect, type Href } from 'expo-router';
import { api, ApiError } from '@/lib/api';
import { isEnrolled, loadMe, signIn, signOut, type Me, type Role } from '@/lib/session';
import { colors, size } from '@/lib/theme';

/**
 * Entry screen: is the server reachable, who is signed in on this phone, and
 * the one role area they may use. The server enforces roles regardless of
 * what this screen shows; this only avoids offering doors that will not open.
 */
const ROLE_AREA: Record<Role, { href: Href; label: string; hint: string }> = {
  AGENT: { href: '/agent', label: 'Agent ATM', hint: 'Cash-in / cash-out for a customer' },
  ADMIN: { href: '/admin', label: 'Admin', hint: 'Agents, limits, cash and float' },
  BANK_OPERATOR: { href: '/bank', label: 'Bank operations', hint: 'Requests, reversals, reconciliation' },
};

type Health = { state: 'checking' } | { state: 'up' } | { state: 'down'; reason: string };
type Staff =
  | { state: 'loading' }
  | { state: 'not-enrolled' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; me: Me }
  | { state: 'error'; message: string };

export default function Home() {
  const [health, setHealth] = useState<Health>({ state: 'checking' });
  const [staff, setStaff] = useState<Staff>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    api<{ ok: boolean }>('/health')
      .then(() => setHealth({ state: 'up' }))
      .catch((e: ApiError) => setHealth({ state: 'down', reason: e.message }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      if (!(await isEnrolled())) return setStaff({ state: 'not-enrolled' });
      const me = await loadMe();
      setStaff(me ? { state: 'signed-in', me } : { state: 'signed-out' });
    } catch (e) {
      setStaff({ state: 'error', message: (e as Error).message });
    }
  }, []);

  // Re-check whenever this screen comes back into view (e.g. after enrolling).
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.panel}>
        <Text style={styles.label}>SERVER</Text>
        <Text
          style={[
            styles.value,
            { color: health.state === 'up' ? colors.ok : health.state === 'down' ? colors.danger : colors.muted },
          ]}
        >
          {health.state === 'up' ? 'Connected' : health.state === 'down' ? 'Unreachable' : 'Checking…'}
        </Text>
        {health.state === 'down' && <Text style={styles.muted}>{health.reason}</Text>}
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>STAFF</Text>
        {staff.state === 'loading' && <ActivityIndicator color={colors.accent} />}
        {staff.state === 'error' && <Text style={styles.error}>{staff.message}</Text>}
        {staff.state === 'not-enrolled' && (
          <>
            <Text style={styles.body}>This phone is not enrolled yet.</Text>
            <Pressable style={styles.primary} onPress={() => router.push('/enrol')}>
              <Text style={styles.primaryLabel}>Enrol this phone</Text>
            </Pressable>
          </>
        )}
        {staff.state === 'signed-out' && (
          <Pressable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => run(signIn)}>
            <Text style={styles.primaryLabel}>Sign in</Text>
          </Pressable>
        )}
        {staff.state === 'signed-in' && (
          <>
            <Text style={styles.value}>{staff.me.displayName}</Text>
            <Text style={styles.muted}>
              {staff.me.staffCode} · {staff.me.role.replace('_', ' ')}
            </Text>
          </>
        )}
        {actionError && <Text style={styles.error}>{actionError}</Text>}
      </View>

      {staff.state === 'signed-in' && (
        <>
          <Link href={ROLE_AREA[staff.me.role].href} asChild>
            <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              <Text style={styles.buttonLabel}>{ROLE_AREA[staff.me.role].label}</Text>
              <Text style={styles.buttonHint}>{ROLE_AREA[staff.me.role].hint}</Text>
            </Pressable>
          </Link>
          <Pressable style={styles.secondary} disabled={busy} onPress={() => run(signOut)}>
            <Text style={styles.secondaryLabel}>Sign out</Text>
          </Pressable>
        </>
      )}

      <Text style={styles.label}>DEMO</Text>
      <Link href="/customer" asChild>
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonLabel}>Customer phone</Text>
          <Text style={styles.buttonHint}>Simulated confirmation call</Text>
        </Pressable>
      </Link>

      <Text style={styles.footer}>Demo build. All banks, customers and verifications are simulated.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: size.pad },
  panel: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad, gap: 8 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  value: { color: colors.text, fontSize: size.title, fontWeight: '700' },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
  primary: { backgroundColor: colors.accent, borderRadius: 8, padding: size.pad, alignItems: 'center' },
  primaryLabel: { color: colors.bg, fontSize: size.button, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  button: {
    backgroundColor: colors.panel,
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: 8,
    padding: size.pad,
    minHeight: 72,
  },
  pressed: { opacity: 0.7 },
  buttonLabel: { color: colors.accent, fontSize: size.button, fontWeight: '700' },
  buttonHint: { color: colors.muted, fontSize: 16, marginTop: 2 },
  secondary: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, alignItems: 'center' },
  secondaryLabel: { color: colors.text, fontSize: size.body },
  footer: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: size.pad },
});
````

### `mobile/src/app/enrol.tsx`

````tsx
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { enrolThisPhone, INVITE_PREFIX } from '@/lib/session';
import { colors, size } from '@/lib/theme';

/**
 * Enrol this phone with the one-time invite an admin created
 * (npm run staff:invite on the server, or the admin screen in Phase 8).
 * Scan the QR, or type the code printed under it.
 */
export default function Enrol() {
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // the scanner fires many times per second

  async function enrol(token: string) {
    if (inFlight.current || !token) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await enrolThisPhone(token.trim());
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={styles.body}>Scan the invite QR your admin gave you.</Text>

      {permission?.granted ? (
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (data.startsWith(INVITE_PREFIX)) enrol(data.slice(INVITE_PREFIX.length));
          }}
        />
      ) : (
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonLabel}>Allow camera</Text>
        </Pressable>
      )}

      <Text style={styles.muted}>Or type the code</Text>
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Invite code"
        placeholderTextColor={colors.muted}
      />
      <Pressable style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => enrol(code)}>
        <Text style={styles.buttonLabel}>Enrol this phone</Text>
      </Pressable>

      {busy && <ActivityIndicator color={colors.accent} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: size.pad, gap: 12 },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  camera: { height: 260, borderRadius: 8, overflow: 'hidden' },
  input: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    fontSize: size.body,
    padding: 12,
  },
  button: { backgroundColor: colors.accent, borderRadius: 8, padding: size.pad, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonLabel: { color: colors.bg, fontSize: size.button, fontWeight: '700' },
  error: { color: colors.danger, fontSize: size.body },
});
````

---

## Push prompt (run this last)

Give this to Antigravity once Phase 2 has been reported and approved.

````text
Phase 2 is approved. Commit and push it.

1. Re-run the checks and confirm they pass:
   backend:  npm run typecheck && npm test   (Postgres running; no "SKIP" in the output)
   mobile:   npx expo lint && npm run typecheck
2. Run git status and confirm that no node_modules/, .env, .expo/ or dist/
   files would be committed. Only .env.example files may be committed.
3. Stage and commit:
   git add .
   git commit -m "feat(auth): phase 2 staff sign-in with device keys and server-side roles"
4. Push to the repository's existing origin on the main branch:
   git push origin main
   If no origin remote is configured, stop and ask me for the repository URL.
   Do not create a new repository and do not guess a URL.
5. Report the commit hash and the full push output.
````
