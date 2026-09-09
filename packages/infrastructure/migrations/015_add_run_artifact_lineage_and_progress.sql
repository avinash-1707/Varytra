ALTER TABLE comparison_batches
  ADD COLUMN progress_stage text NOT NULL DEFAULT 'queued' CHECK (progress_stage IN ('queued', 'preparing_fixture', 'running_baseline', 'running_candidate', 'complete', 'failed'));

ALTER TABLE agent_runs
  ADD COLUMN progress_stage text NOT NULL DEFAULT 'queued' CHECK (progress_stage IN ('queued', 'preparing_fixture', 'running_baseline', 'running_candidate', 'complete', 'failed')),
  ADD COLUMN event_count integer CHECK (event_count >= 0),
  ADD COLUMN tool_call_count integer CHECK (tool_call_count >= 0),
  ADD COLUMN duration_ms integer CHECK (duration_ms >= 0),
  ADD COLUMN token_usage integer CHECK (token_usage >= 0),
  ADD COLUMN cost_usd numeric(14, 6) CHECK (cost_usd >= 0);

CREATE TABLE agent_run_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES comparison_batches(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('raw-trace', 'redacted-trace', 'normalized-trace')),
  storage_ref text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 32),
  classification text NOT NULL CHECK (classification IN ('restricted', 'sensitive', 'internal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, kind),
  UNIQUE (organization_id, storage_ref),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE comparison_batch_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES comparison_batches(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('queued', 'preparing_fixture', 'running_baseline', 'running_candidate', 'complete', 'failed')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_run_artifacts_run_idx ON agent_run_artifacts (organization_id, run_id, created_at);
CREATE INDEX comparison_batch_progress_batch_idx ON comparison_batch_progress (organization_id, batch_id, occurred_at DESC);

ALTER TABLE agent_run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparison_batch_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE comparison_batch_progress FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON agent_run_artifacts, comparison_batch_progress TO varytra_app;
CREATE POLICY agent_run_artifacts_tenant_isolation ON agent_run_artifacts USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY comparison_batch_progress_tenant_isolation ON comparison_batch_progress USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, stage)
SELECT organization_id, project_id, id, 'queued' FROM comparison_batches;
