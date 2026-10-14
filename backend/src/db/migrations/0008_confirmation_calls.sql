-- ============================================================
-- 0008: customer confirmation calls (IVR).
--
-- After the agent signs a transaction, BharatPoint asks the IVR to call the
-- customer. Each dial is one call_attempts row, keyed by a caller-chosen,
-- idempotent call_id (confirm:<authorizationId>:<dial>). The IVR's signed
-- replies are stored as evidence; the decision itself lands on the existing
-- transaction_authorizations row, whose Phase 1 triggers already guarantee
-- decide-once, no approval after expiry, and keyed amount = agent amount.
-- ============================================================

-- Demo: the customer's "phone" is a SIP extension on the IVR (e.g. 6001).
ALTER TABLE customers
  ADD COLUMN sip_extension TEXT CHECK (sip_extension ~ '^[0-9]{3,6}$');

CREATE TABLE call_attempts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id UUID        NOT NULL REFERENCES transaction_authorizations(id),
  dial             INTEGER     NOT NULL CHECK (dial >= 1),
  call_id          TEXT        NOT NULL UNIQUE,
  state            TEXT        NOT NULL DEFAULT 'SENDING' CHECK (state IN (
                     'SENDING', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'FAILED', 'UNKNOWN')),
  decision         TEXT        CHECK (decision IN ('ACCEPTED', 'DECLINED', 'MISMATCH', 'INVALID_INPUT', 'NONE')),
  keyed_minor      BIGINT      CHECK (keyed_minor >= 0),
  reply            JSONB,      -- the IVR's signed reply, kept as evidence
  poll_count       INTEGER     NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (authorization_id, dial)
);

CREATE INDEX idx_call_attempts_open ON call_attempts (created_at)
  WHERE state IN ('SENDING', 'QUEUED', 'IN_PROGRESS', 'UNKNOWN');

CREATE FUNCTION call_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.authorization_id, NEW.dial, NEW.call_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.authorization_id, OLD.dial, OLD.call_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'call_attempts: identity fields cannot change';
  END IF;
  IF OLD.state IN ('COMPLETED', 'NO_ANSWER', 'FAILED')
     AND (NEW.state, NEW.decision, NEW.keyed_minor, NEW.reply)
         IS DISTINCT FROM (OLD.state, OLD.decision, OLD.keyed_minor, OLD.reply)
  THEN
    RAISE EXCEPTION 'call_attempts: % is final (%)', OLD.call_id, OLD.state;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER call_attempts_final_states
  BEFORE UPDATE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION call_attempts_guard();

CREATE TRIGGER call_attempts_no_delete
  BEFORE DELETE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
