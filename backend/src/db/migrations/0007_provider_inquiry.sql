-- ============================================================
-- 0007: status-inquiry tracking for provider requests.
--
-- When the bank's answer is lost (timeout, crash, dropped connection) the
-- transaction sits in UNKNOWN_OUTCOME and the backend asks the bank what
-- happened, with backoff. After too many unanswered inquiries a person must
-- reconcile it (RECONCILIATION_REQUIRED). A new debit is never sent.
-- ============================================================

ALTER TABLE provider_requests
  ADD COLUMN inquiry_count   INTEGER     NOT NULL DEFAULT 0 CHECK (inquiry_count >= 0),
  ADD COLUMN last_inquiry_at TIMESTAMPTZ;
