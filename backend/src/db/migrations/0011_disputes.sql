-- ============================================================
-- 0011: "This wasn't me" reports.
--
-- No software can stop an agent who holds the customer's phone and answers
-- the confirmation call himself. What it can do is make the customer's
-- objection cheap, permanent and visible to the admin: the customer reports a
-- transaction from their own app, the report is append-only, and the admin
-- alert board shows it against the agent.
-- ============================================================

CREATE TABLE transaction_disputes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL UNIQUE REFERENCES transactions(id),
  customer_id    UUID        NOT NULL REFERENCES customers(id),
  note           TEXT        CHECK (length(note) <= 300),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_disputes_customer ON transaction_disputes (customer_id);

CREATE TRIGGER disputes_no_update
  BEFORE UPDATE ON transaction_disputes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER disputes_no_delete
  BEFORE DELETE ON transaction_disputes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
