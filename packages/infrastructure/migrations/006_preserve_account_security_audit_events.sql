ALTER TABLE account_security_events
  DROP CONSTRAINT account_security_events_user_id_fkey;

REVOKE ALL ON account_security_events FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON account_security_events FROM varytra_app;
GRANT INSERT ON account_security_events TO varytra_app;
