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
  display_name TEXT        NOT NULL,
  is_synthetic BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_code   TEXT        NOT NULL UNIQUE,
  display_name TEXT        NOT NULL,
  role         TEXT        NOT NULL CHECK (role IN ('AGENT', 'ADMIN', 'BANK_OPERATOR')),
  bank_id      UUID        REFERENCES banks(id),
  status       TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bank_operator_has_one_bank CHECK ((role = 'BANK_OPERATOR') = (bank_id IS NOT NULL)),
  UNIQUE (id, role)
);

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

CREATE TABLE device_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id),
  public_key   BYTEA       NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  UNIQUE (id, user_id)
);

CREATE INDEX idx_device_keys_user ON device_keys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT        NOT NULL UNIQUE,
  user_id       UUID        NOT NULL,
  device_key_id UUID        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  FOREIGN KEY (device_key_id, user_id) REFERENCES device_keys (id, user_id)
);

CREATE INDEX idx_sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE agents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL UNIQUE,
  role          TEXT        NOT NULL DEFAULT 'AGENT' CHECK (role = 'AGENT'),
  agent_code    TEXT        NOT NULL UNIQUE,
  location_name TEXT        NOT NULL,
  district      TEXT,
  state         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (user_id, role) REFERENCES users (id, role)
);

CREATE TABLE customers (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       TEXT        NOT NULL,
  phone_enc          BYTEA       NOT NULL,
  phone_lookup       TEXT        NOT NULL CHECK (phone_lookup ~ '^[0-9a-f]{64}$'),
  preferred_language TEXT        NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'hi', 'te')),
  confirmation_mode  TEXT        NOT NULL DEFAULT 'BLIND_ENTRY'
                                 CHECK (confirmation_mode IN ('BLIND_ENTRY', 'READBACK')),
  is_synthetic       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_phone_lookup ON customers (phone_lookup);

CREATE TABLE customer_account_links (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID        NOT NULL REFERENCES customers(id),
  bank_id        UUID        NOT NULL REFERENCES banks(id),
  provider_token TEXT        NOT NULL,
  masked_label   TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bank_id, provider_token),
  UNIQUE (id, customer_id, bank_id)
);

CREATE INDEX idx_account_links_customer ON customer_account_links (customer_id);

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id);