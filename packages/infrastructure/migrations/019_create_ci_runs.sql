CREATE TABLE ci_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  batch_id uuid NOT NULL UNIQUE REFERENCES comparison_batches(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, project_id, idempotency_key)
);

CREATE INDEX ci_runs_project_created_idx ON ci_runs (organization_id, project_id, created_at DESC);
ALTER TABLE ci_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_runs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON ci_runs TO varytra_app;
CREATE POLICY ci_runs_tenant_isolation ON ci_runs
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
