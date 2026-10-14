-- The Asterisk IVR picks its own call id; remember which one answers our call id.
CREATE TABLE ivr_calls (
  call_id     TEXT        PRIMARY KEY,
  ivr_call_id TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
