-- ============================================================
-- 0002: staff identity, agents, customers, banks.
--
-- Staff (agents, admins, bank operators) sign in with a device-bound
-- Ed25519 key, enrolled through a single-use admin invite. Customers never
-- sign in: they are people the agent serves, and in this prototype every
-- one of them is synthetic.
-- ============================================================

CREATE TABLE banks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        NOT NULL UNIQUE,
  display_name TEXT        NOT NULL,            -- "Demo …" names only in the prototype
  is_synthetic BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_code   TEXT        NOT NULL UNIQUE,     -- e.g. AG-001, shown on receipts and in admin
  display_name TEXT        NOT NULL,
  role         TEXT        NOT NULL CHECK (role IN ('AGENT', 'ADMIN', 'BANK_OPERATOR')),
  -- A bank operator sees exactly one bank's data; nobody else is tied to a bank.
  bank_id      UUID        REFERENCES banks(id),
  status       TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bank_operator_has_one_bank CHECK ((role = 'BANK_OPERATOR') = (bank_id IS NOT NULL)),
  UNIQUE (id, role)                             -- target of agents' (user_id, role) FK
);

-- Single-use, expiring enrolment invite, shown to the new staff member as a QR.
-- Only the hash of the token is stored.
CREATE TABLE enrolment_invites (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id),
  token_hash TEXT        NOT NULL UNIQUE,
  created_by UUID        NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_invites_user ON enrolment_invites (user_id);

-- Public half of a staff member's device key. The private key never leaves the phone.
CREATE TABLE device_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id),
  public_key   BYTEA       NOT NULL UNIQUE CHECK (octet_length(public_key) = 32), -- raw Ed25519
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  UNIQUE (id, user_id)                          -- target of sessions' (device_key_id, user_id) FK
);

CREATE INDEX idx_device_keys_user ON device_keys (user_id) WHERE revoked_at IS NULL;

-- Server-side sessions, so a fired agent or a lost phone can be cut off immediately
-- (audit F-06). The bearer token is random; only its hash is stored.
CREATE TABLE sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT        NOT NULL UNIQUE,
  user_id       UUID        NOT NULL,
  device_key_id UUID        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  -- A session's key must belong to the session's user.
  FOREIGN KEY (device_key_id, user_id) REFERENCES device_keys (id, user_id)
);

CREATE INDEX idx_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE agents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL UNIQUE,
  -- Pinned to 'AGENT' so only a user whose role is AGENT can be an agent, and
  -- that user's role cannot later be changed out from under the agent row.
  role          TEXT        NOT NULL DEFAULT 'AGENT' CHECK (role = 'AGENT'),
  agent_code    TEXT        NOT NULL UNIQUE,
  location_name TEXT        NOT NULL,           -- village / point name, printed on receipts
  district      TEXT,
  state         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id, role) REFERENCES users (id, role)
);

CREATE TABLE customers (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       TEXT        NOT NULL,
  -- Phone number encrypted by the app; phone_lookup is an HMAC of it for search.
  -- Not UNIQUE: families share phones.
  phone_enc          BYTEA       NOT NULL,
  phone_lookup       TEXT        NOT NULL CHECK (phone_lookup ~ '^[0-9a-f]{64}$'),
  preferred_language TEXT        NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'hi', 'te')),
  confirmation_mode  TEXT        NOT NULL DEFAULT 'BLIND_ENTRY'
                                 CHECK (confirmation_mode IN ('BLIND_ENTRY', 'READBACK')),
  is_synthetic       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_phone_lookup ON customers (phone_lookup);

-- A customer's account at a bank, as the provider identifies it: an opaque token
-- plus a masked label ("Demo SBI ••••4321"). Never a full account number, never a balance.
CREATE TABLE customer_account_links (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID        NOT NULL REFERENCES customers(id),
  bank_id        UUID        NOT NULL REFERENCES banks(id),
  provider_token TEXT        NOT NULL,
  masked_label   TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bank_id, provider_token),
  UNIQUE (id, customer_id, bank_id)             -- target of transactions' composite FK
);

CREATE INDEX idx_account_links_customer ON customer_account_links (customer_id);

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id);
