CREATE TABLE scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  stable_key text NOT NULL CHECK (stable_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, stable_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  stable_key text NOT NULL CHECK (stable_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_id, stable_key),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_id uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  rules jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE scenario_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  task_spec jsonb NOT NULL,
  fixture_ref text NOT NULL CHECK (char_length(fixture_ref) BETWEEN 1 AND 500),
  assertion_spec jsonb NOT NULL,
  efficiency_budget jsonb NOT NULL,
  policy_version_id uuid REFERENCES policy_versions(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, version),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  stable_key text NOT NULL CHECK (stable_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
  version integer NOT NULL CHECK (version > 0),
  adapter_type text NOT NULL CHECK (adapter_type IN ('reference', 'registered-http')),
  config_ref text NOT NULL CHECK (config_ref ~ '^(secret|vault)://[A-Za-z0-9._/-]+$'),
  model_metadata jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, stable_key, version),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX scenario_versions_project_idx ON scenario_versions (organization_id, project_id, created_at DESC);
CREATE INDEX agent_versions_project_idx ON agent_versions (organization_id, project_id, created_at DESC);

CREATE FUNCTION reject_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'version rows are immutable'; END; $$;
CREATE TRIGGER policy_versions_immutable BEFORE UPDATE OR DELETE ON policy_versions FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE TRIGGER scenario_versions_immutable BEFORE UPDATE OR DELETE ON scenario_versions FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
CREATE TRIGGER agent_versions_immutable BEFORE UPDATE OR DELETE ON agent_versions FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();

ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE scenario_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON scenarios, policies, policy_versions, scenario_versions, agent_versions TO varytra_app;
CREATE POLICY scenarios_tenant_isolation ON scenarios USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY policies_tenant_isolation ON policies USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY policy_versions_tenant_isolation ON policy_versions USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY scenario_versions_tenant_isolation ON scenario_versions USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY agent_versions_tenant_isolation ON agent_versions USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
