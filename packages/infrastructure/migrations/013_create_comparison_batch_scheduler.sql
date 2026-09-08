CREATE TABLE comparison_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  baseline_agent_version_id uuid NOT NULL REFERENCES agent_versions(id),
  candidate_agent_version_id uuid NOT NULL REFERENCES agent_versions(id),
  scenario_set_hash text NOT NULL CHECK (scenario_set_hash ~ '^[a-f0-9]{64}$'),
  config_snapshot jsonb NOT NULL,
  repetition_count integer NOT NULL CHECK (repetition_count BETWEEN 1 AND 20),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed')),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (organization_id, project_id, idempotency_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES comparison_batches(id) ON DELETE CASCADE,
  scenario_version_id uuid NOT NULL REFERENCES scenario_versions(id),
  agent_version_id uuid NOT NULL REFERENCES agent_versions(id),
  side text NOT NULL CHECK (side IN ('baseline', 'candidate')),
  repetition integer NOT NULL CHECK (repetition > 0),
  endpoint_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'agent_failed', 'infrastructure_failed', 'timed_out')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 10),
  retry_safe boolean NOT NULL,
  failure_code text,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, scenario_version_id, side, repetition),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE agent_run_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ready', 'published', 'handled')),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  handled_at timestamptz,
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX comparison_batches_project_status_idx ON comparison_batches (organization_id, project_id, status, created_at DESC);
CREATE INDEX agent_runs_claim_idx ON agent_runs (organization_id, available_at) WHERE status = 'queued';
CREATE INDEX agent_runs_limit_idx ON agent_runs (organization_id, endpoint_key, lease_expires_at) WHERE status = 'running';
CREATE INDEX agent_run_dispatches_ready_idx ON agent_run_dispatches (available_at) WHERE status = 'ready';

ALTER TABLE comparison_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparison_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_run_dispatches FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON comparison_batches, agent_runs, agent_run_dispatches TO varytra_app;
CREATE POLICY comparison_batches_tenant_isolation ON comparison_batches USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY agent_runs_tenant_isolation ON agent_runs USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY agent_run_dispatches_tenant_isolation ON agent_run_dispatches USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
