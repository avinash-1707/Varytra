ALTER TABLE agent_run_artifacts
  ADD COLUMN retention_deadline timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  ADD COLUMN retention_claim_token uuid,
  ADD COLUMN retention_claim_expires_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

CREATE INDEX agent_run_artifacts_retention_cleanup_idx
  ON agent_run_artifacts (organization_id, retention_deadline, created_at)
  WHERE deleted_at IS NULL;

GRANT UPDATE (retention_claim_token, retention_claim_expires_at, deleted_at) ON agent_run_artifacts TO varytra_app;
