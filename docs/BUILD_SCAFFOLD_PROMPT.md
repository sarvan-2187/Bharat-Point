# Bharat Point Build Scaffold Prompt

> **To the coding agent (Antigravity):** you are starting the BharatPoint project. The repository does not contain the scaffold yet. **This document contains every scaffold file in full** in the [Code](#code) section: create each one at the path shown in its heading, with exactly the content shown, overwriting any file that already exists at that path. Do not redesign or "improve" the scaffold while copying it. The architecture is already approved by the whole team, and this document is its complete summary. If you were also given the architecture audit document, save it as `docs/ARCHITECTURE_AUDIT.md` and read it before Phase 1. Also save this document itself as `docs/BUILD_SCAFFOLD_PROMPT.md`.
>
> **Do not commit or push anything until you reach the [Push prompt](#push-prompt-run-this-last) at the end of this document.**

## How to work

1. **Phase 0 first: recreate the scaffold from this document.**
   1. Create every file listed in [Code](#code), byte-for-byte. The path is the heading; the content is the code block under it.
   2. Install and verify:
      ```bash
      cd backend && npm install && npm run typecheck && npm test
      cd ../mobile && npm install && npx expo lint && npm run typecheck
      ```
   3. Optional, if Docker Desktop is running: copy `.env.example` to `.env`, fill in the password, then `docker compose up -d` and `cd backend && npm run db:migrate && npm run dev`. Open `http://127.0.0.1:4000/health`.
   4. **Stop and report:** files created, the commands above with their real output, and anything that failed. Fix only what is needed to make the checks pass, and say exactly what you changed.
2. **Then one phase at a time.** Finish a phase, run its checks, stop and report, and wait for the team's approval before the next phase.
3. **Verify, don't assume.** Expo SDK 57 is newer than your training data. Before using any Expo API, read the versioned docs (`https://docs.expo.dev/versions/v57.0.0/`), as `mobile/AGENTS.md` says. Add packages with `npx expo install`, and **only use modules bundled in Expo Go**.
4. **Every phase leaves tests behind.** Backend: `npm test` and `npm run typecheck`. Mobile: `npm run typecheck` and `npx expo lint`. Never report a phase done with failing checks.
5. **Smallest change that works.** No speculative abstractions, no dashboards before the cash-out slice is secure, no new dependency when a few lines will do.

### Non-negotiable rules

- Money is **integer paise** (`BIGINT`). Never floats, never formatted strings.
- **One backend, one Postgres.** Redis, if added later, holds rate-limit counters only. Never approvals, nonces or balances.
- The **mock bank owns customer balances**. BharatPoint owns transactions, authorizations, agent float/cash ledger and audit.
- Transactions are **immutable**: hashed fields are never UPDATEd (enforce with a trigger). A changed amount = supersede in **one DB transaction** with `SELECT … FOR UPDATE`, then a new transaction and a new customer confirmation.
- **No route lets the agent's app set an approval.** Only the confirmation service (simulator or IVR worker) writes `transaction_authorizations.status`, through a guarded `UPDATE … WHERE status='PENDING' AND expires_at > now()`.
- Every state change is a guarded transition (`UPDATE … WHERE state = $expected`) in a DB transaction that also writes its `transaction_events` row and audit row. **Audit writes for financial events are inside that transaction**, never best-effort.
- Provider calls are **idempotent** (`debit:<txId>`, `reversal:<txId>`). A timeout becomes `UNKNOWN_OUTCOME` → status inquiry only. **Never re-send a debit.** The agent app never says "hand over cash" before `PROVIDER_APPROVED`.
- **Role checks happen on the server** for every route (`requireRole`), with the role read from the DB per request. Hiding a screen is not access control.
- **Everything simulated is labelled `SIMULATED`** in the DB, on receipts and in the UI. Use only synthetic data, with bank names prefixed "Demo …". No real phone numbers, no Aadhaar-like numbers.
- Demo-only features (customer simulator, fault injection, seed data) work **only when `DEMO_MODE=true`**.
- Postgres stays on loopback. `.env` is never committed. `EXPO_PUBLIC_*` values are public: never put secrets there.

### Transaction states

`CREATED → AWAITING_CUSTOMER → CUSTOMER_CONFIRMED → PROVIDER_PENDING → PROVIDER_APPROVED → COMPLETED`

Side exits: `SUPERSEDED` (agent edits before confirmation), `REJECTED` (customer presses 2 or the typed amount mismatches), `EXPIRED` (no answer or timeout), `PROVIDER_DECLINED`, `UNKNOWN_OUTCOME` (→ status inquiry → approved / declined / `RECONCILIATION_REQUIRED`), `CASH_NOT_DISBURSED → REVERSAL_PENDING → REVERSED`, and for cash-in `CASH_RETURN_REQUIRED → CASH_RETURNED`. Interbank settlement is a separate `settlement_status`, not a transaction state.

### Build phases

| Phase | Build | Done when |
|---|---|---|
| **0. Scaffold** | Create every file in [Code](#code); install; verify | Backend typecheck and test pass; mobile lint and typecheck pass; with Postgres up, `npm run db:migrate` works and a phone on Expo Go shows **SERVER: Connected** |
| **1. Schema (slice)** | Migrations `0002+` for: `users` (with `role`, `bank_id`), `enrolment_invites`, `device_keys`, `sessions`, `agents`, `customers` (`is_synthetic`, encrypted phone + HMAC lookup), `banks`, `customer_account_links` (token + masked label), `transactions`, `transaction_authorizations`, `authorization_steps`, `settlement_capabilities`, `provider_requests`, `idempotency_keys`, `transaction_events`, `ledger_accounts`, `ledger_journals`, `ledger_postings`. Immutability, append-only (reuse `forbid_mutation()`) and sum-zero triggers; separate DB roles | Migrations apply to an empty DB; tests prove forbidden UPDATE/DELETE raise and an unbalanced journal is rejected |
| **2. Staff sign-in + RBAC** | Admin creates a staff user → **single-use, expiring invite QR**. App scans it (`expo-camera`), generates an **Ed25519 key pair** (random seed from `expo-crypto`, signing with `@noble/curves`, pure JS), stores the private key in `expo-secure-store`, and gates every use with `expo-local-authentication` (fingerprint/device PIN). Server stores only the public key. Login = sign a server challenge → bearer session token (server-side `sessions` row, revocable), kept in SecureStore. `requireRole` middleware | Route × role matrix test passes; enrolling without an invite fails; a revoked session gets 401; a signature from another device's key fails |
| **3. Transaction core** | Canonical intent hash over `txId, txnType, amountMinor, customerId, accountRef, bankId, agentId, nonce, createdAt, expiresAt` (sorted keys, integers only, sha256 → base64url). Append-only, hash-linked, HMAC'd authorization chain with stages `INTENT_LOCKED, AGENT_SIGNED, CUSTOMER_CONFIRMED, LIMITS_CHECKED, RISK_APPROVED, PROVIDER_AUTHORIZED, CASH_HANDOVER_CONFIRMED`, and a single-use settlement capability consumed in the same DB transaction as the ledger write. State machine as above. The agent signs each intent hash with the device key (`AGENT_SIGNED`) | Unit tests for every legal and illegal transition; a capability for T1 cannot settle T2; editing a hashed column raises |
| **4. Mock bank** | `services/mock-bank/`: tiny Express service with synthetic accounts, `debit`/`credit`/`reverse`/`status`, idempotent request ids, fault injection (decline, timeout-after-commit, 500) switchable from the bank console in `DEMO_MODE` | Same request id twice → one debit; timeout-after-commit → backend ends in `UNKNOWN_OUTCOME`, resolves by inquiry, exactly one debit at the bank |
| **5. Cash-out slice + customer simulator** | Agent screens: customer lookup → bank/account → amount keypad (whole rupees) → sign → "Calling customer…" → result → cash handover → receipt. **Customer phone simulator** (second phone, `DEMO_MODE` only): pairs to one synthetic customer via a demo QR, polls for an incoming "call", reads the prompt aloud with `expo-speech` (English/Hindi/Telugu where the device has voices), asks the customer to **type the amount they asked for** (blind entry), then read-back + approve (1) / reject (2). Mismatch is terminal and raises an agent alert | Exact match approves; mismatch, reject, timeout and expiry never approve; duplicate decisions are no-ops; an amended amount needs a new confirmation; the agent app cannot approve through any route |
| **6. Ledger, handover, receipts** | Double-entry journals (each sums to zero): provider approval (Dr provider receivable / Cr agent float pending), cash handover (Dr float pending / Cr cash drawer), cash-in (Dr cash drawer / Cr agent float), reversal (mirror journal). `CASH_NOT_DISBURSED` → reversal. Receipt shared via `expo-print` / `expo-sharing` if bundled in Expo Go (verify), else on-screen | Property test: every journal sums to zero; handover is impossible before `PROVIDER_APPROVED` |
| **7. Real ringing phone (local SIP)** | Asterisk 22 LTS in Docker + ARI worker (Node, `ws` + `fetch`). Students install **Linphone** and register to Asterisk on the LAN; the worker dials the customer's SIP extension and collects DTMF. Simulator stays as the fallback, labelled `channel=SIMULATOR` | A call to a Linphone phone completes the slice; a duplicate DTMF event is a no-op; no answer → `EXPIRED` |
| **8. Admin** | Agents, invites, suspend, limits (data, not code), alerts, replenishment with maker-checker | Suspending an agent blocks their next request |
| **9. Bank console** | Scoped to the operator's `bank_id`: requests, authorization status, reversals, reconciliation, fault toggles | Operator of bank A gets 404 for bank B data (API test) |
| **10. Reconciliation** | Cash counts vs ledger; ledger vs mock-bank statement; variance alerts | A seeded discrepancy raises an alert |
| **11. Security harness** | Scripted attacks: amount inflation, replay, forged approval, IDOR, role escalation, duplicate DTMF, provider timeout | Every scenario ends BLOCKED |
| **12. Compose + LAN** | Dockerfiles, Caddy, private network, secrets | Clean clone → one command → working demo |

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Mobile client | **Expo SDK 57 + Expo Router**, TypeScript, run in **Expo Go** | One app with four role areas: Agent ATM, Customer phone (simulator), Admin, Bank operations. Retro-ATM theme in `mobile/src/lib/theme.ts`. No custom image assets, so the whole app is plain text |
| Staff sign-in | Phone biometrics (`expo-local-authentication`) gating a device-bound Ed25519 key (`expo-secure-store`, `expo-crypto`, `@noble/curves`), admin-issued invite QR (`expo-camera`) | Same approach the team already used in PRISM's Expo app, upgraded to an asymmetric key so the server never holds a signing secret |
| Backend | **Node 22, Express 5, TypeScript 7**, `pg`, `helmet` | One backend. Tests with `node:test` via `tsx`. Express 5 handles async errors, so there is no `wrap()` helper |
| Database | **PostgreSQL 17** (Docker, loopback only) | Source of truth. Append-only tables enforced by triggers |
| Customer confirmation | In-app **customer simulator** first; then **Asterisk 22 LTS + ARI** with **Linphone** softphones | All local and free. Real mobile-network calls need a paid, licensed provider (out of scope) |
| Mock bank | Small Express service (`services/mock-bank/`, phase 4) | Simulates approvals, declines, timeouts and unknown outcomes |
| Later, only when needed | Redis (rate limits), Caddy (TLS reverse proxy) | Not in the scaffold on purpose |

## Feasibility

| Capability | Feasible in Expo Go? | How |
|---|---|---|
| Agent, admin, bank screens on phones | ✅ | Expo Router screens |
| Staff sign-in with fingerprint / device PIN | ✅ | `expo-local-authentication` + `expo-secure-store` (Face ID on iOS needs a development build; fingerprint/PIN work in Expo Go) |
| QR enrolment and customer pairing | ✅ | `expo-camera` |
| Customer confirmation on a second phone | ✅ | Customer simulator screen; prompts read aloud with `expo-speech` |
| A real ringing call on a student's phone | ✅ (outside Expo Go) | Linphone app + local Asterisk over Wi-Fi |
| Call to a real mobile number | ❌ free / ✅ paid | Needs a licensed telephony provider; for regulated banks, 1600-series numbers |
| Real bank, AePS biometric, DigiLocker | ❌ | Simulated and labelled; needs sponsor bank / UIDAI-chain access |
| Shared live state across all phones | ✅ | Every phone talks to the same backend over the LAN |

**Practical constraint:** campus and public Wi-Fi often block device-to-device traffic (client isolation). Run demos on a **phone hotspot or a travel router** that the laptop and all phones join.

## Viability

- **Cost:** ₹0 for the prototype. Everything is open source; hardware is one laptop plus the team's and students' phones.
- **Setup for an audience:** install Expo Go, scan one QR. No app-store release, no accounts for students.
- **Team fit:** the team has already shipped an Expo Go app with biometric sign-in (PRISM), and the transaction-binding design is proven there.
- **Main risks and mitigations:**
  - Wi-Fi isolation → hotspot or travel router.
  - Expo Go only runs the latest SDK → keep the project on SDK 57 and pin it until the demo is over.
  - Docker networking for SIP audio on Windows (phase 7) → the simulator is always available as the fallback.
  - Scope creep → strict phase gates; the cash-out slice comes first.

## Impact

- **Targets a concrete fraud pattern:** an agent enters a higher amount than the customer asked for. The customer types the amount they asked for on their own phone, so a mismatch is caught even if they aren't listening carefully.
- **Teaches real fintech engineering:** transaction binding, out-of-band confirmation, idempotency, uncertain outcomes, double-entry ledgers, and why "press 1" is not two-factor authentication. All of it is visible on screens students hold.
- **Honest by design:** every simulated step is labelled, so the demo never pretends to be an approved banking or AePS system.

## Benefits

- **For the demo:** two phones tell the whole story. The agent enters ₹500, the customer types ₹200, and the transaction is refused. Then the same flow succeeds when both match.
- **For students:** hands-on, on their own phones, with no installs beyond Expo Go. They can be the customer.
- **For the team:** one backend and one database, phase gates with tests, and a clear path from simulator → local SIP → licensed provider.
- **For the future:** the same backend works for a web console later; only the client changes.

---

## Code

Create each file below at the path in its heading, with exactly this content. These files are the complete scaffold: no generator command is needed, and lockfiles are produced by `npm install`.

### `.gitignore`

````text
node_modules/
dist/
.next/
out/
*.tsbuildinfo

# Secrets: only the example is committed.
.env
.env.*
!.env.example

# mkcert output contains private keys.
certs/

*.log
.DS_Store
Thumbs.db
````

### `.env.example`

````bash
# Copy to .env and fill in. Never commit .env.
#   cp .env.example .env

NODE_ENV=development

# ── Backend ───────────────────────────────────────────────────────────
PORT=4000
# 127.0.0.1 = this laptop only. For a phone demo on the LAN set HOST=0.0.0.0
# (phones must reach the API) and allow port 4000 through Windows Firewall on
# private networks only. Once Caddy fronts the API, go back to 127.0.0.1
# (audit F-10).
HOST=127.0.0.1

# ── Postgres (docker-compose reads POSTGRES_PASSWORD from this file) ──
# Generate: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
POSTGRES_PASSWORD=
# Same password as above.
DATABASE_URL=postgresql://bharatpoint:CHANGE_ME@127.0.0.1:5432/bharatpoint
````

### `docker-compose.yml`

````yaml
# Data store only, for now.
#
# The api and web apps run on the host (`npm run dev`) until the Compose/LAN
# phase: WebAuthn is bound to a hostname, so that is settled before they are
# containerised. Redis, Asterisk and the mock bank are added in the phases
# that need them (see docs/ARCHITECTURE_AUDIT.md §14).
#
#   docker compose up -d

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: bharatpoint
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: bharatpoint
    ports:
      # Loopback only: never reachable from the LAN (audit F-11).
      - '127.0.0.1:5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U bharatpoint -d bharatpoint']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
````

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

cd ../mobile
cp .env.example .env               # EXPO_PUBLIC_API_URL=http://<laptop LAN IP>:4000
npm install
npx expo start                     # scan the QR with Expo Go
```

For phones to reach the API, set `HOST=0.0.0.0` in the root `.env` and allow TCP 4000 through
Windows Firewall on **private** networks only. The home screen shows **SERVER: Connected** when it works.
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
    "test": "tsx --test \"src/**/*.test.ts\""
  },
  "dependencies": {
    "express": "^5.3.0",
    "helmet": "^8.3.0",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/node": "^22.20.5",
    "@types/pg": "^8.23.1",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2"
  }
}
````

### `backend/tsconfig.json`

````json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
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
} as const;
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

export default pool;
````

### `backend/src/db/migrate.ts`

````ts
/**
 * Migration runner. Adapted from PRISM@680037b (backend/src/db/migrate.ts).
 * Usage: npm run db:migrate
 *
 * Applies every NNNN_name.sql in migrations/ in order, each inside its own
 * transaction, and records it in schema_migrations so re-running is safe.
 * Migrations are append-only: never edit one that has been applied.
 * migrations.test.ts enforces unique, zero-padded numbers (audit F-18).
 */
import fs from 'fs';
import path from 'path';
import pool, { query } from './pool';

const DIR = path.join(__dirname, 'migrations');

async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const applied = new Set(
    (await query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename
    )
  );

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[db] migrations complete (${ran} applied, ${files.length - ran} already applied)`);
  await pool.end();
}

migrate().catch((err) => {
  console.error('[db]', (err as Error).message);
  process.exit(1);
});
````

### `backend/src/db/migrations/0001_audit_log.sql`

````sql
-- ============================================================
-- 0001: audit log, append-only by database rule (audit F-05).
--
-- PRISM kept its audit table append-only by convention only. Here the
-- database refuses UPDATE, DELETE and TRUNCATE outright. Later tables
-- that must be immutable (transaction_events, ledger postings) reuse
-- forbid_mutation().
--
-- Foreign keys to users/transactions are added by the migrations that
-- create those tables.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TABLE audit_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID,
  transaction_id UUID,
  event_type     TEXT        NOT NULL,
  event_data     JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_transaction ON audit_logs (transaction_id, created_at);
CREATE INDEX idx_audit_event_type  ON audit_logs (event_type, created_at DESC);

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
````

### `backend/src/db/migrations.test.ts`

````ts
/**
 * Guards the migration filenames. PRISM shipped two 002_ and two 003_ files
 * (audit F-18): the order still happened to be deterministic, but only by
 * accident of alphabetical sorting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('migrations are NNNN_snake_case.sql with unique numbers', () => {
  const files = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'no migrations found');

  for (const f of files) {
    assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, `bad migration filename: ${f}`);
  }
  const numbers = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, `duplicate migration number in: ${files.join(', ')}`);
});
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
  AUTH_FAILED: [401, 'Authentication failed.'],
  FORBIDDEN: [403, 'You do not have access to this.'],
  NOT_FOUND: [404, 'Not found.'],
  INTERNAL_ERROR: [500, 'Internal server error.'],
} as const;

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

### `backend/src/index.ts`

````ts
/**
 * BharatPoint API.
 *
 * Express 5 forwards rejected promises from async handlers to the error
 * handler on its own, so PRISM's wrap() helper is not needed here.
 */
import express from 'express';
import helmet from 'helmet';
import { config } from './config/env';
import pool from './db/pool';
import { errorHandler } from './api/errors';

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

// Feature routers mount under /api/v1, each behind a role guard (audit §10).

app.use(errorHandler);

async function start() {
  // Fail loudly at boot rather than on the first transaction.
  await pool.query('SELECT 1');

  const server = app.listen(config.port, config.host, () => {
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

### `mobile/package.json`

````json
{
  "name": "bharatpoint-mobile",
  "main": "expo-router/entry",
  "version": "1.0.0",
  "dependencies": {
    "@expo/ui": "~57.0.23",
    "expo": "~57.0.28",
    "expo-constants": "~57.0.21",
    "expo-device": "~57.0.2",
    "expo-font": "~57.0.4",
    "expo-glass-effect": "~57.0.4",
    "expo-image": "~57.0.5",
    "expo-linking": "~57.0.12",
    "expo-router": "~57.0.26",
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
      "expo-router"
    ],
    "experiments": {
      "typedRoutes": true,
      "reactCompiler": true
    }
  }
}
````

### `mobile/tsconfig.json`

````json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "paths": {
      "@/*": [
        "./src/*"
      ]
    }
  },
  "include": [
    "**/*.ts",
    "**/*.tsx",
    ".expo/types/**/*.ts",
    "expo-env.d.ts"
  ]
}
````

### `mobile/.gitignore`

````text
# Learn more https://docs.github.com/en/get-started/getting-started-with-git/ignoring-files

# dependencies
node_modules/

# Expo
.expo/
dist/
web-build/
expo-env.d.ts

# Native
.kotlin/
*.orig.*
*.jks
*.p8
*.p12
*.key
*.mobileprovision

# Metro
.metro-health-check*

# debug
npm-debug.*
yarn-debug.*
yarn-error.*

# macOS
.DS_Store
*.pem

# local env files
.env*.local

# typescript
*.tsbuildinfo

example

# generated native folders
/ios
/android
````

### `mobile/eslint.config.js`

````js
// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  }
]);
````

### `mobile/.env.example`

````bash
# Copy to mobile/.env. Expo inlines EXPO_PUBLIC_* values into the app bundle,
# so never put a secret here.
#
# The laptop's LAN IP (ipconfig on Windows), not localhost: on the phone,
# localhost is the phone. The backend must listen on the LAN (HOST=0.0.0.0
# in the root .env) and Windows Firewall must allow port 4000 on private networks.
EXPO_PUBLIC_API_URL=http://192.168.1.20:4000
````

### `mobile/AGENTS.md`

````markdown
This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
````

### `mobile/README.md`

````markdown
# BharatPoint mobile (Expo Go)

One app, four role areas: Agent ATM, Customer phone (simulator), Admin, Bank operations.
Setup and the LAN demo steps are in the [root README](../README.md).

```bash
cp .env.example .env      # set EXPO_PUBLIC_API_URL to the laptop's LAN IP
npm install
npx expo start            # scan the QR with Expo Go on a phone on the same Wi-Fi
npm run typecheck && npx expo lint
```

Add packages with `npx expo install <pkg>` (keeps them SDK-compatible). Only modules
bundled in Expo Go may be used. See AGENTS.md.
````

### `mobile/src/lib/theme.ts`

````ts
/**
 * Retro-ATM palette: high contrast, large type, readable in sunlight on a
 * cheap phone. Every screen takes colours from here, never inline hex.
 */
export const colors = {
  bg: '#0B0F0C',
  panel: '#141A16',
  text: '#E8F5E9',
  muted: '#9DB5A3',
  accent: '#FFC94D', // amber, the "screen glow"
  ok: '#4ADE80',
  danger: '#F87171',
  border: '#2A3A2F',
} as const;

export const size = {
  body: 18,
  title: 28,
  button: 22,
  pad: 16,
} as const;
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
 * so screens switch on failureCode rather than parsing strings. The session
 * bearer token (stored in expo-secure-store) is added here once staff
 * sign-in exists.
 */
const BASE = process.env.EXPO_PUBLIC_API_URL;

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
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
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

### `mobile/src/components/placeholder-screen.tsx`

````tsx
import { StyleSheet, Text, View } from 'react-native';
import { colors, size } from '@/lib/theme';

/** Stand-in for a role area until its phase is built. Delete when the last one is gone. */
export function PlaceholderScreen({ phase, what }: { phase: string; what: string }) {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Not built yet</Text>
      <Text style={styles.body}>{what}</Text>
      <Text style={styles.phase}>{phase}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: size.pad, gap: 8, justifyContent: 'center' },
  title: { color: colors.accent, fontSize: size.title, fontWeight: '700' },
  body: { color: colors.text, fontSize: size.body },
  phase: { color: colors.muted, fontSize: 14 },
});
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
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, type Href } from 'expo-router';
import { api, ApiError } from '@/lib/api';
import { colors, size } from '@/lib/theme';

/**
 * Entry screen. For now it proves the phone can reach the backend (the first
 * thing that breaks at a demo) and links to the four role areas. Staff
 * sign-in replaces the open links in the auth phase; the server enforces
 * roles regardless of what this screen shows.
 */
const ROLES: { href: Href; label: string; hint: string }[] = [
  { href: '/agent', label: 'Agent ATM', hint: 'Cash-in / cash-out for a customer' },
  { href: '/customer', label: 'Customer phone', hint: 'Simulated confirmation call' },
  { href: '/admin', label: 'Admin', hint: 'Agents, limits, cash and float' },
  { href: '/bank', label: 'Bank operations', hint: 'Requests, reversals, reconciliation' },
];

type Health = { state: 'checking' } | { state: 'up' } | { state: 'down'; reason: string };

export default function Home() {
  const [health, setHealth] = useState<Health>({ state: 'checking' });

  useEffect(() => {
    api<{ ok: boolean }>('/health')
      .then(() => setHealth({ state: 'up' }))
      .catch((e: ApiError) => setHealth({ state: 'down', reason: e.message }));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.status}>
        <Text style={styles.statusLabel}>SERVER</Text>
        <Text
          style={[
            styles.statusValue,
            { color: health.state === 'up' ? colors.ok : health.state === 'down' ? colors.danger : colors.muted },
          ]}
        >
          {health.state === 'up' ? 'Connected' : health.state === 'down' ? 'Unreachable' : 'Checking…'}
        </Text>
        {health.state === 'down' && <Text style={styles.reason}>{health.reason}</Text>}
      </View>

      {ROLES.map((r) => (
        <Link key={r.label} href={r.href} asChild>
          <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Text style={styles.buttonLabel}>{r.label}</Text>
            <Text style={styles.buttonHint}>{r.hint}</Text>
          </Pressable>
        </Link>
      ))}

      <Text style={styles.footer}>Demo build. All banks, customers and verifications are simulated.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: size.pad },
  status: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad },
  statusLabel: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  statusValue: { fontSize: size.title, fontWeight: '700' },
  reason: { color: colors.muted, fontSize: 14, marginTop: 4 },
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
  footer: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: size.pad },
});
````

### `mobile/src/app/agent/index.tsx`

````tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function Agent() {
  return <PlaceholderScreen what="Customer lookup, amount entry, confirmation call, cash handover, receipt." phase="Phase 3-6" />;
}
````

### `mobile/src/app/customer/index.tsx`

````tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function Customer() {
  return <PlaceholderScreen what="Incoming confirmation 'call': type the amount you asked for, then approve or reject." phase="Phase 6" />;
}
````

### `mobile/src/app/admin/index.tsx`

````tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function Admin() {
  return <PlaceholderScreen what="Agents, enrolment invites, limits, cash and float, alerts." phase="Phase 8" />;
}
````

### `mobile/src/app/bank/index.tsx`

````tsx
import { PlaceholderScreen } from '@/components/placeholder-screen';

export default function Bank() {
  return <PlaceholderScreen what="Incoming requests, authorization status, reversals, reconciliation." phase="Phase 9" />;
}
````

---

## Push prompt (run this last)

Give this to Antigravity once Phase 0 has been reported and approved. Reuse it after every later approved phase, changing only the commit message.

````text
Phase 0 is approved. Commit and push the scaffold.

1. Re-run the checks and confirm they pass:
   backend:  npm run typecheck && npm test
   mobile:   npx expo lint && npm run typecheck
2. Run git status and confirm that no node_modules/, .env, .expo/ or dist/
   files would be committed. Only the .env.example files may be committed.
3. Stage and commit:
   git add .
   git commit -m "chore: scaffold BharatPoint (Express backend, Expo Go app, build prompt)"
4. Push to the repository's existing origin on the main branch:
   git push -u origin main
   If no origin remote is configured, stop and ask me for the repository URL.
   Do not create a new repository and do not guess a URL.
5. Report the commit hash and the full push output.
````
