CREATE TABLE account_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'auth.account_linked',
    'auth.account_unlink_requested',
    'auth.email_verified',
    'auth.password_reset'
  )),
  provider_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_security_events_user_id_idx ON account_security_events (user_id, occurred_at DESC);

GRANT INSERT ON account_security_events TO varytra_app;
