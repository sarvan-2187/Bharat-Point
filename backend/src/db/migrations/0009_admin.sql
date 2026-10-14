-- ============================================================
-- 0009: admin controls (Phase 8).
--
-- Agent limits: a cap per transaction and per day, in whole rupees (paise
-- multiples of 100). Defaults: ₹10,000 per transaction, ₹50,000 per day.
--
-- Replenishment with maker-checker: one admin requests cash (or e-float) for
-- an agent, a different admin approves it, and only the approval posts the
-- ledger journal. The database itself refuses a self-approval, a second
-- decision, an approval without its journal, and any delete.
-- ============================================================

ALTER TABLE agents
  ADD COLUMN per_txn_limit_minor BIGINT NOT NULL DEFAULT 1000000
             CHECK (per_txn_limit_minor > 0 AND per_txn_limit_minor % 100 = 0),
  ADD COLUMN daily_limit_minor   BIGINT NOT NULL DEFAULT 5000000
             CHECK (daily_limit_minor > 0 AND daily_limit_minor % 100 = 0),
  ADD CONSTRAINT agent_limits_ordered CHECK (per_txn_limit_minor <= daily_limit_minor);

CREATE TABLE replenishments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID        NOT NULL REFERENCES agents(id),
  account_kind TEXT        NOT NULL CHECK (account_kind IN ('CASH_DRAWER', 'FLOAT')),
  amount_minor BIGINT      NOT NULL CHECK (amount_minor > 0 AND amount_minor % 100 = 0),
  note         TEXT        CHECK (length(note) <= 200),
  status       TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by UUID        NOT NULL REFERENCES users(id),
  decided_by   UUID        REFERENCES users(id),
  journal_id   UUID        UNIQUE REFERENCES ledger_journals(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  CHECK ((status = 'PENDING') = (decided_by IS NULL)),
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK ((status = 'APPROVED') = (journal_id IS NOT NULL)),
  CONSTRAINT maker_checker CHECK (decided_by <> requested_by)
);

CREATE INDEX idx_replenishments_pending ON replenishments (created_at) WHERE status = 'PENDING';

CREATE FUNCTION replenishments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'replenishments: % is already decided (%)', OLD.id, OLD.status;
  END IF;
  IF (NEW.id, NEW.agent_id, NEW.account_kind, NEW.amount_minor, NEW.note, NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.agent_id, OLD.account_kind, OLD.amount_minor, OLD.note, OLD.requested_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'replenishments: only the decision may change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER replenishments_decide_once
  BEFORE UPDATE ON replenishments
  FOR EACH ROW EXECUTE FUNCTION replenishments_guard();

CREATE TRIGGER replenishments_no_delete
  BEFORE DELETE ON replenishments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
