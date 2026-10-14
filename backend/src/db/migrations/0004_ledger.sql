-- ============================================================
-- 0004: double-entry ledger for agent cash and electronic float.
--
-- Customer balances live at the (mock) bank, not here. This ledger tracks
-- what BharatPoint must reconcile: the agent's physical cash drawer, the
-- agent's e-float, amounts owed by the provider, and commissions.
--
-- Sign convention: debit = positive, credit = negative. Every journal must
-- have at least two postings summing to zero, checked at COMMIT, and every
-- posting must be written in the same DB transaction as its journal.
-- Journals and postings are append-only: corrections are new journals
-- (purpose REVERSAL), never edits.
-- ============================================================

CREATE TABLE ledger_accounts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type TEXT        NOT NULL CHECK (owner_type IN ('AGENT', 'PROVIDER', 'PLATFORM')),
  owner_id   UUID,
  kind       TEXT        NOT NULL CHECK (kind IN (
               'CASH_DRAWER', 'FLOAT', 'FLOAT_PENDING', 'PROVIDER_RECEIVABLE',
               'COMMISSION', 'OPENING_EQUITY')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((owner_type = 'PLATFORM') = (owner_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, kind)
);

CREATE TABLE ledger_journals (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      UUID        REFERENCES transactions(id),
  purpose             TEXT        NOT NULL CHECK (purpose IN (
                        'PROVIDER_APPROVAL', 'CASH_HANDOVER', 'CASH_IN', 'REVERSAL',
                        'SETTLEMENT', 'REPLENISHMENT', 'OPENING')),
  reverses_journal_id UUID        REFERENCES ledger_journals(id),
  memo                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (transaction_id, purpose),
  CHECK ((purpose = 'REVERSAL') = (reverses_journal_id IS NOT NULL))
);

CREATE TABLE ledger_postings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id        UUID        NOT NULL REFERENCES ledger_journals(id),
  ledger_account_id UUID        NOT NULL REFERENCES ledger_accounts(id),
  amount_minor      BIGINT      NOT NULL CHECK (amount_minor <> 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_postings_journal ON ledger_postings (journal_id);
CREATE INDEX idx_postings_account ON ledger_postings (ledger_account_id, created_at);

CREATE FUNCTION ledger_posting_same_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_journals
     WHERE id = NEW.journal_id AND xmin = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'ledger_postings: journal % was not created in this transaction', NEW.journal_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_postings_same_transaction
  BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_posting_same_transaction();

CREATE FUNCTION ledger_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  jid   UUID;
  total NUMERIC;
  n     INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN
    jid := NEW.id;
  ELSE
    jid := NEW.journal_id;
  END IF;
  SELECT COALESCE(SUM(amount_minor), 0), COUNT(*) INTO total, n
    FROM ledger_postings WHERE journal_id = jid;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger journal % is unbalanced (% postings, sum %)', jid, n, total;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_journals_balanced
  AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();

CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();

CREATE TRIGGER ledger_journals_append_only
  BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ledger_journals_no_truncate
  BEFORE TRUNCATE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ledger_postings_no_truncate
  BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();