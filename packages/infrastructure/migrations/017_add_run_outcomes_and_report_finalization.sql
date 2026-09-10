CREATE TABLE agent_run_outcomes (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  final_state jsonb NOT NULL,
  policy_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_run_outcomes_batch_idx ON agent_run_outcomes (organization_id, project_id, run_id);
ALTER TABLE agent_run_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_outcomes FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON agent_run_outcomes TO varytra_app;
CREATE POLICY agent_run_outcomes_tenant_isolation ON agent_run_outcomes USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
