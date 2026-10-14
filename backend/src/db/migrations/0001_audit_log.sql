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
