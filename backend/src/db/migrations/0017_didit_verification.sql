-- ============================================================
-- 0010: Didit face verification sessions and webhook events.
--
-- Hosted face/liveness verification flow for rural agent banking.
-- Binds the Didit session to the customer and transaction.
-- Strictly avoids storing raw biometric templates or face images.
-- ============================================================

CREATE TABLE IF NOT EXISTS didit_verification_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          TEXT        NOT NULL UNIQUE,
  workflow_id         TEXT        NOT NULL,
  customer_id         UUID        NOT NULL REFERENCES customers(id),
  transaction_id      UUID        REFERENCES transactions(id),
  amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
  status              TEXT        NOT NULL DEFAULT 'Not Started'
                                  CHECK (status IN ('Not Started', 'Pending', 'Approved', 'Declined', 'Expired', 'Abandoned')),
  verification_url    TEXT        NOT NULL,
  vendor_data         TEXT,
  webhook_received_at TIMESTAMPTZ,
  webhook_payload     JSONB,      -- decision metadata only; no raw biometric media
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_didit_sessions_customer ON didit_verification_sessions (customer_id);
CREATE INDEX IF NOT EXISTS idx_didit_sessions_transaction ON didit_verification_sessions (transaction_id);
CREATE INDEX IF NOT EXISTS idx_didit_sessions_status ON didit_verification_sessions (status);

-- Idempotency tracking for Didit webhooks
CREATE TABLE IF NOT EXISTS didit_webhook_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       TEXT        NOT NULL UNIQUE,
  session_id     TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,
  status         TEXT,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_didit_webhook_session ON didit_webhook_events (session_id);
