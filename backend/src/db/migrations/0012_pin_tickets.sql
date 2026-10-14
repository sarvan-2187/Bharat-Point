-- ============================================================
-- 0012: customer PIN, and tickets with callback calls.
--
-- PIN: a customer who signed up has a 4-digit PIN (stored only as a peppered
-- scrypt hash). The confirmation call asks for it, so an agent who holds the
-- customer's phone cannot approve for them. Three wrong PINs lock
-- confirmation for that customer for 30 minutes. Customers seeded by staff
-- have no PIN and confirm as before.
--
-- Tickets: things a person at the bank or the admin desk must look at. They
-- are opened automatically (a customer report, a transaction the system
-- could not settle, a wrong PIN) and closed by an admin with a note.
-- ticket_calls are callback calls to the customer ("did you make this?").
-- ============================================================

ALTER TABLE customers
  ADD COLUMN pin_hash         TEXT,
  ADD COLUMN pin_failures     INTEGER     NOT NULL DEFAULT 0 CHECK (pin_failures >= 0),
  ADD COLUMN pin_locked_until TIMESTAMPTZ;

CREATE TABLE tickets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT        NOT NULL CHECK (kind IN ('CUSTOMER_REPORT', 'BANK_EXCEPTION', 'WRONG_PIN')),
  transaction_id UUID        NOT NULL REFERENCES transactions(id),
  status         TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution     TEXT        CHECK (length(resolution) <= 300),
  resolved_by    UUID        REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  UNIQUE (kind, transaction_id),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK ((status = 'OPEN') = (resolved_by IS NULL))
);

CREATE INDEX idx_tickets_open ON tickets (created_at) WHERE status = 'OPEN';

CREATE TABLE ticket_calls (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID        NOT NULL REFERENCES tickets(id),
  call_id      TEXT        NOT NULL UNIQUE,   -- ticket:<ticketId>:<n>, idempotent at the IVR
  state        TEXT        NOT NULL DEFAULT 'SENDING' CHECK (state IN (
                 'SENDING', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'FAILED', 'UNKNOWN')),
  answer       TEXT        CHECK (answer IN ('YES', 'NO')),  -- "yes, I made this" / "no, I did not"
  requested_by UUID        NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ticket_calls_ticket ON ticket_calls (ticket_id, created_at DESC);
CREATE INDEX idx_ticket_calls_open ON ticket_calls (created_at) WHERE state IN ('SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN');
