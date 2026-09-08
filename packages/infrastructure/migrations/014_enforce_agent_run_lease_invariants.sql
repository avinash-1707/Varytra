ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_lease_state_check CHECK (
  (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND finished_at IS NULL)
  OR (status = 'queued' AND lease_token IS NULL AND lease_expires_at IS NULL AND finished_at IS NULL)
  OR (status IN ('succeeded', 'agent_failed', 'infrastructure_failed', 'timed_out') AND lease_token IS NULL AND lease_expires_at IS NULL AND finished_at IS NOT NULL)
);
