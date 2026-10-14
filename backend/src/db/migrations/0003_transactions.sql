-- ============================================================
-- 0003: transactions, customer confirmation, authorization chain,
-- settlement capability, provider requests, idempotency, events.
--
-- The database itself refuses the dangerous writes, so a bug in the app
-- cannot do them either:
--   * a transaction's locked fields (amount, type, parties, hash) never change;
--   * a customer authorization can be decided once, never re-decided, never
--     approved after it expires, and a blind-entry approval must carry the
--     exact amount the agent entered;
--   * chain steps and events are append-only;
--   * a settlement capability can be consumed exactly once.
-- Allowed state transitions are enforced in Phase 3.
-- ============================================================

CREATE TABLE transactions (
  id              UUID        PRIMARY KEY,      -- app-generated: it is inside intent_hash
  txn_type        TEXT        NOT NULL CHECK (txn_type IN ('CASH_IN', 'CASH_OUT')),
  agent_id        UUID        NOT NULL REFERENCES agents(id),
  customer_id     UUID        NOT NULL,
  account_link_id UUID        NOT NULL,
  bank_id         UUID        NOT NULL,
  -- Paise, whole rupees only: cash at an agent point has no paise.
  amount_minor    BIGINT      NOT NULL CHECK (amount_minor > 0 AND amount_minor % 100 = 0),
  currency        TEXT        NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  intent_hash     TEXT        NOT NULL UNIQUE,
  nonce           TEXT        NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  state           TEXT        NOT NULL DEFAULT 'CREATED' CHECK (state IN (
                    'CREATED', 'AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED',
                    'PROVIDER_PENDING', 'PROVIDER_APPROVED', 'COMPLETED',
                    'SUPERSEDED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PROVIDER_DECLINED',
                    'UNKNOWN_OUTCOME', 'RECONCILIATION_REQUIRED',
                    'CASH_NOT_DISBURSED', 'REVERSAL_PENDING', 'REVERSED',
                    'CASH_RETURN_REQUIRED', 'CASH_RETURNED')),
  -- Interbank settlement is a separate dimension from the customer-facing state.
  settlement_status TEXT      NOT NULL DEFAULT 'UNSETTLED'
                              CHECK (settlement_status IN ('UNSETTLED', 'SETTLED', 'DISPUTED')),
  failure_code    TEXT,
  superseded_by   UUID        REFERENCES transactions(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  -- The account must belong to this customer at this bank.
  FOREIGN KEY (account_link_id, customer_id, bank_id)
    REFERENCES customer_account_links (id, customer_id, bank_id)
);

CREATE INDEX idx_transactions_agent    ON transactions (agent_id, created_at DESC);
CREATE INDEX idx_transactions_bank     ON transactions (bank_id, state);
CREATE INDEX idx_transactions_customer ON transactions (customer_id, created_at DESC);
-- The recovery sweeper scans only non-terminal rows.
CREATE INDEX idx_transactions_open ON transactions (state, updated_at)
  WHERE state IN ('CREATED', 'AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED', 'PROVIDER_PENDING',
                  'PROVIDER_APPROVED', 'UNKNOWN_OUTCOME', 'CASH_NOT_DISBURSED',
                  'REVERSAL_PENDING', 'CASH_RETURN_REQUIRED');

CREATE FUNCTION transactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.txn_type, NEW.agent_id, NEW.customer_id, NEW.account_link_id, NEW.bank_id,
      NEW.amount_minor, NEW.currency, NEW.intent_hash, NEW.nonce, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.txn_type, OLD.agent_id, OLD.customer_id, OLD.account_link_id, OLD.bank_id,
      OLD.amount_minor, OLD.currency, OLD.intent_hash, OLD.nonce, OLD.created_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'transactions: locked fields cannot change; supersede the transaction instead';
  END IF;
  IF OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
    RAISE EXCEPTION 'transactions: superseded_by is set once';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_locked_fields
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_guard();

CREATE TRIGGER transactions_no_delete
  BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transactions_no_truncate
  BEFORE TRUNCATE ON transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ------------------------------------------------------------
-- Customer confirmation of one exact transaction.
-- ------------------------------------------------------------
CREATE TABLE transaction_authorizations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id       UUID        NOT NULL REFERENCES transactions(id),
  channel              TEXT        NOT NULL CHECK (channel IN ('SIMULATOR', 'IVR')),
  mode                 TEXT        NOT NULL CHECK (mode IN ('BLIND_ENTRY', 'READBACK')),
  binding_hash         TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                         'PENDING', 'APPROVED', 'REJECTED', 'MISMATCH',
                         'EXPIRED', 'NO_ANSWER', 'INVALID_INPUT')),
  customer_keyed_minor BIGINT      CHECK (customer_keyed_minor >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NOT NULL,
  decided_at           TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK (status NOT IN ('APPROVED', 'MISMATCH') OR mode = 'READBACK' OR customer_keyed_minor IS NOT NULL)
);

-- At most one live request and at most one approval per transaction.
CREATE UNIQUE INDEX uq_authorization_pending  ON transaction_authorizations (transaction_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX uq_authorization_approved ON transaction_authorizations (transaction_id) WHERE status = 'APPROVED';

CREATE FUNCTION transaction_authorizations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  agent_amount BIGINT;
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'transaction_authorizations: % is already decided (%)', OLD.id, OLD.status;
  END IF;
  IF (NEW.id, NEW.transaction_id, NEW.channel, NEW.mode, NEW.binding_hash, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.transaction_id, OLD.channel, OLD.mode, OLD.binding_hash, OLD.created_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'transaction_authorizations: only status, keyed amount and decided_at may change';
  END IF;
  IF NEW.status = 'APPROVED' THEN
    IF NOW() >= OLD.expires_at THEN
      RAISE EXCEPTION 'transaction_authorizations: % expired; it cannot be approved', OLD.id;
    END IF;
    IF NEW.mode = 'BLIND_ENTRY' THEN
      SELECT amount_minor INTO agent_amount FROM transactions WHERE id = NEW.transaction_id;
      IF NEW.customer_keyed_minor IS DISTINCT FROM agent_amount THEN
        RAISE EXCEPTION 'transaction_authorizations: keyed amount does not match the transaction';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_authorizations_decide_once
  BEFORE UPDATE ON transaction_authorizations
  FOR EACH ROW EXECUTE FUNCTION transaction_authorizations_guard();

CREATE TRIGGER transaction_authorizations_no_delete
  BEFORE DELETE ON transaction_authorizations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------------------------------------
-- Authorization chain (from PRISM): one append-only, hash-linked,
-- MAC'd row per completed stage. Verified before money moves.
-- ------------------------------------------------------------
CREATE TABLE authorization_steps (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL REFERENCES transactions(id),
  attempt        INTEGER     NOT NULL CHECK (attempt >= 1),
  seq            INTEGER     NOT NULL CHECK (seq >= 0),
  stage          TEXT        NOT NULL CHECK (stage IN (
                   'INTENT_LOCKED', 'AGENT_SIGNED', 'CUSTOMER_CONFIRMED', 'LIMITS_CHECKED',
                   'RISK_APPROVED', 'PROVIDER_AUTHORIZED', 'CASH_HANDOVER_CONFIRMED')),
  payload        JSONB       NOT NULL,
  prev_hash      TEXT        NOT NULL,
  row_hash       TEXT        NOT NULL UNIQUE,
  mac            TEXT        NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_id, attempt, seq),
  UNIQUE (transaction_id, attempt, stage)
);

CREATE TRIGGER authorization_steps_append_only
  BEFORE UPDATE OR DELETE ON authorization_steps
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER authorization_steps_no_truncate
  BEFORE TRUNCATE ON authorization_steps
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ------------------------------------------------------------
-- Settlement capability (from PRISM): minted from a complete chain,
-- consumed in the same DB transaction as the ledger write, exactly once.
-- ------------------------------------------------------------
CREATE TABLE settlement_capabilities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID        NOT NULL REFERENCES transactions(id),
  attempt         INTEGER     NOT NULL,
  intent_hash     TEXT        NOT NULL,
  chain_tip_hash  TEXT        NOT NULL,
  required_stages TEXT[]      NOT NULL,
  mac             TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  CHECK (expires_at > issued_at)
);

CREATE INDEX idx_capabilities_tx ON settlement_capabilities (transaction_id, attempt);

CREATE FUNCTION settlement_capabilities_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_capabilities: % already consumed', OLD.id;
  END IF;
  IF NEW.consumed_at IS NULL
     OR (NEW.id, NEW.transaction_id, NEW.attempt, NEW.intent_hash, NEW.chain_tip_hash,
         NEW.required_stages, NEW.mac, NEW.issued_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.transaction_id, OLD.attempt, OLD.intent_hash, OLD.chain_tip_hash,
         OLD.required_stages, OLD.mac, OLD.issued_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'settlement_capabilities: the only allowed change is consuming it';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_capabilities_consume_once
  BEFORE UPDATE ON settlement_capabilities
  FOR EACH ROW EXECUTE FUNCTION settlement_capabilities_guard();

CREATE TRIGGER settlement_capabilities_no_delete
  BEFORE DELETE ON settlement_capabilities
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------------------------------------
-- Outbound requests to the bank/provider. request_id is deterministic
-- (debit:<txId>, reversal:<txId>) so a retry can never become a second debit.
-- A row in SENDING after a crash means "maybe sent": inquire, never resend.
-- ------------------------------------------------------------
CREATE TABLE provider_requests (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL REFERENCES transactions(id),
  kind           TEXT        NOT NULL CHECK (kind IN ('DEBIT', 'CREDIT', 'REVERSAL')),
  request_id     TEXT        NOT NULL UNIQUE,
  state          TEXT        NOT NULL DEFAULT 'SENDING'
                             CHECK (state IN ('SENDING', 'APPROVED', 'DECLINED', 'UNKNOWN')),
  response       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_id, kind)
);

CREATE FUNCTION provider_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.transaction_id, NEW.kind, NEW.request_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.transaction_id, OLD.kind, OLD.request_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'provider_requests: identity fields cannot change';
  END IF;
  IF OLD.state IN ('APPROVED', 'DECLINED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'provider_requests: % is final (%)', OLD.request_id, OLD.state;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_requests_final_states
  BEFORE UPDATE ON provider_requests
  FOR EACH ROW EXECUTE FUNCTION provider_requests_guard();

CREATE TRIGGER provider_requests_no_delete
  BEFORE DELETE ON provider_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------------------------------------
-- Inbound idempotency: a retried request from the app returns the
-- stored response instead of acting twice.
-- ------------------------------------------------------------
CREATE TABLE idempotency_keys (
  actor_user_id   UUID        NOT NULL REFERENCES users(id),
  key             TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_user_id, key)
);

-- ------------------------------------------------------------
-- Every state transition, written in the same DB transaction as the
-- transition itself. The business history of a transaction.
-- ------------------------------------------------------------
CREATE TABLE transaction_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL REFERENCES transactions(id),
  from_state     TEXT,
  to_state       TEXT        NOT NULL,
  actor_kind     TEXT        NOT NULL CHECK (actor_kind IN (
                   'AGENT', 'CUSTOMER', 'ADMIN', 'BANK_OPERATOR', 'PROVIDER', 'SYSTEM')),
  actor_user_id  UUID        REFERENCES users(id),
  detail         JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transaction_events_tx ON transaction_events (transaction_id, created_at);

CREATE TRIGGER transaction_events_append_only
  BEFORE UPDATE OR DELETE ON transaction_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transaction_events_no_truncate
  BEFORE TRUNCATE ON transaction_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_transaction_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id);
