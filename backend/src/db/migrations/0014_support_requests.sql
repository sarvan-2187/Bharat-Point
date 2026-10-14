-- Customer-raised tickets not tied to a transaction ("I need help"). Admins read and close them.
CREATE TABLE support_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID        NOT NULL REFERENCES customers(id),
  message     TEXT        NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  status      TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_support_open ON support_requests (created_at) WHERE status = 'OPEN';
