-- ============================================================
-- 0005: staff sign-in.
--
-- Login is challenge-response: the server issues a random nonce, the phone
-- signs it with its device key (behind the phone's biometric prompt), and
-- the server verifies the signature against the enrolled public key. Each
-- challenge is single-use and short-lived, so a captured signature cannot
-- be replayed to open a second session.
-- ============================================================

-- Invites created by the trusted local CLI (npm run staff:invite, run on the
-- server machine) have no creating user. Invites created through the admin
-- API always record the admin.
ALTER TABLE enrolment_invites ALTER COLUMN created_by DROP NOT NULL;

CREATE TABLE auth_challenges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_key_id UUID        NOT NULL REFERENCES device_keys(id),
  nonce         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_auth_challenges_expiry ON auth_challenges (expires_at);
