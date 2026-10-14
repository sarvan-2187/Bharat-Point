-- ============================================================
-- 0014: fraud review (advisory risk assessment of each payment).
--
-- Each payment gets at most one assessment: a risk score from the fraud
-- model, or an explicit reason why there is none. An assessment is advisory:
-- it never changes the payment's state and never replaces customer
-- confirmation, the PIN, limits or the bank's own checks. An unavailable or
-- incomplete assessment is stored as such, never as "low risk".
--
-- Customers gain three optional attributes the model needs (date of birth,
-- gender, location). Without them the assessment is INCOMPLETE; nothing is
-- guessed.
-- ============================================================

ALTER TABLE customers
  ADD COLUMN date_of_birth DATE CHECK (date_of_birth > DATE '1900-01-01' AND date_of_birth <= CURRENT_DATE),
  ADD COLUMN gender        TEXT CHECK (length(gender) BETWEEN 1 AND 20),
  ADD COLUMN location      TEXT CHECK (length(location) BETWEEN 1 AND 80);

CREATE TABLE fraud_assessments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID        NOT NULL UNIQUE REFERENCES transactions(id),
  status         TEXT        NOT NULL CHECK (status IN ('SCORED', 'INCOMPLETE', 'UNAVAILABLE')),
  probability    NUMERIC(7,6) CHECK (probability >= 0 AND probability <= 1),
  category       TEXT        CHECK (category IN ('LOW', 'MEDIUM', 'HIGH')),
  missing        JSONB       NOT NULL DEFAULT '[]',   -- [{feature, reason}] when INCOMPLETE
  reason         TEXT,                                -- why there is no score, when UNAVAILABLE
  features       JSONB,                               -- exactly what the model was given (synthetic data only)
  model_sha256   TEXT,
  thresholds     JSONB       NOT NULL,                -- {medium, high} in force when scored
  assumptions    JSONB       NOT NULL DEFAULT '[]',
  review_status  TEXT        NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'CLEARED', 'ESCALATED')),
  review_note    TEXT        CHECK (length(review_note) <= 300),
  reviewed_by    UUID        REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A score and its category exist together, and only for SCORED. Anything else has no score.
  CHECK ((status = 'SCORED') = (probability IS NOT NULL)),
  CHECK ((status = 'SCORED') = (category IS NOT NULL)),
  CHECK ((review_status = 'PENDING') = (reviewed_by IS NULL)),
  CHECK ((review_status = 'PENDING') = (reviewed_at IS NULL))
);

CREATE INDEX idx_fraud_pending ON fraud_assessments (created_at DESC) WHERE review_status = 'PENDING';

ALTER TABLE tickets DROP CONSTRAINT tickets_kind_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_kind_check
  CHECK (kind IN ('CUSTOMER_REPORT', 'BANK_EXCEPTION', 'WRONG_PIN', 'FRAUD_REVIEW'));
