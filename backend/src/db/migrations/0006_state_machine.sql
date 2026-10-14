-- ============================================================
-- 0006: the transaction state machine, enforced by the database.
--
-- The allowed transitions are rows in transaction_transitions (append-only:
-- the rules change only through a new migration). A trigger refuses any
-- state change that is not listed, so no code path, however buggy, can move
-- a transaction from, say, REJECTED to COMPLETED.
--
-- Also enforced here:
--   * a new transaction always starts in CREATED;
--   * once a transaction has expired it cannot move forward to
--     AWAITING_CUSTOMER, CUSTOMER_CONFIRMED or PROVIDER_PENDING;
--   * SUPERSEDED requires superseded_by to point at the replacement.
-- ============================================================

CREATE TABLE transaction_transitions (
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  txn_type   TEXT CHECK (txn_type IN ('CASH_IN', 'CASH_OUT')),   -- NULL = both types
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO transaction_transitions (from_state, to_state, txn_type) VALUES
  ('CREATED',             'AWAITING_CUSTOMER',       NULL),
  ('CREATED',             'SUPERSEDED',              NULL),
  ('CREATED',             'CANCELLED',               NULL),
  ('CREATED',             'EXPIRED',                 NULL),
  ('AWAITING_CUSTOMER',   'CUSTOMER_CONFIRMED',      NULL),
  ('AWAITING_CUSTOMER',   'REJECTED',                NULL),
  ('AWAITING_CUSTOMER',   'EXPIRED',                 NULL),
  ('AWAITING_CUSTOMER',   'SUPERSEDED',              NULL),
  ('AWAITING_CUSTOMER',   'CANCELLED',               NULL),
  ('CUSTOMER_CONFIRMED',  'PROVIDER_PENDING',        NULL),
  ('CUSTOMER_CONFIRMED',  'REJECTED',                NULL),   -- limits or risk refused it
  ('CUSTOMER_CONFIRMED',  'CANCELLED',               NULL),
  ('CUSTOMER_CONFIRMED',  'EXPIRED',                 NULL),
  ('PROVIDER_PENDING',    'PROVIDER_APPROVED',       NULL),
  ('PROVIDER_PENDING',    'PROVIDER_DECLINED',       NULL),
  ('PROVIDER_PENDING',    'UNKNOWN_OUTCOME',         NULL),
  ('UNKNOWN_OUTCOME',     'PROVIDER_APPROVED',       NULL),   -- resolved by status inquiry
  ('UNKNOWN_OUTCOME',     'PROVIDER_DECLINED',       NULL),
  ('UNKNOWN_OUTCOME',     'RECONCILIATION_REQUIRED', NULL),
  ('PROVIDER_APPROVED',   'COMPLETED',               NULL),
  ('PROVIDER_APPROVED',   'CASH_NOT_DISBURSED',      'CASH_OUT'),
  ('CASH_NOT_DISBURSED',  'REVERSAL_PENDING',        'CASH_OUT'),
  ('REVERSAL_PENDING',    'REVERSED',                'CASH_OUT'),
  ('REVERSAL_PENDING',    'RECONCILIATION_REQUIRED', 'CASH_OUT'),
  ('PROVIDER_DECLINED',   'CASH_RETURN_REQUIRED',    'CASH_IN'),  -- cash already taken from the customer
  ('CASH_RETURN_REQUIRED','CASH_RETURNED',           'CASH_IN');

-- Created after the rows above, so the rule set is frozen: no inserts, edits
-- or deletes at runtime. A new rule means a new migration.
CREATE TRIGGER transaction_transitions_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON transaction_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transaction_transitions_no_truncate
  BEFORE TRUNCATE ON transaction_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION transaction_transition_allowed(p_from TEXT, p_to TEXT, p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM transaction_transitions
     WHERE from_state = p_from AND to_state = p_to AND (txn_type IS NULL OR txn_type = p_type)
  );
$$;

CREATE FUNCTION transactions_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT transaction_transition_allowed(OLD.state, NEW.state, OLD.txn_type) THEN
    RAISE EXCEPTION 'transactions: illegal transition % -> % for %', OLD.state, NEW.state, OLD.txn_type;
  END IF;
  IF NEW.state IN ('AWAITING_CUSTOMER', 'CUSTOMER_CONFIRMED', 'PROVIDER_PENDING') AND NOW() >= OLD.expires_at THEN
    RAISE EXCEPTION 'transactions: % has expired and cannot move to %', OLD.id, NEW.state;
  END IF;
  IF NEW.state = 'SUPERSEDED' AND NEW.superseded_by IS NULL THEN
    RAISE EXCEPTION 'transactions: SUPERSEDED requires superseded_by';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_state_machine
  BEFORE UPDATE OF state ON transactions
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION transactions_state_guard();

CREATE FUNCTION transactions_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'CREATED' THEN
    RAISE EXCEPTION 'transactions: a new transaction starts in CREATED, not %', NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_start_created
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_insert_guard();
