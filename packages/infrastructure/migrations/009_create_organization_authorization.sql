CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_memberships_user_id_idx ON organization_memberships (user_id, organization_id);

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_memberships TO varytra_app;
CREATE POLICY organization_memberships_tenant_isolation ON organization_memberships
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO varytra_app;
CREATE POLICY projects_tenant_isolation ON projects
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by_user_id text NOT NULL REFERENCES "user"(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['ci:read', 'ci:write']::text[] AND cardinality(scopes) > 0),
  secret_hash bytea NOT NULL,
  secret_salt bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES api_keys(id),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
);

CREATE INDEX api_keys_lookup_idx ON api_keys (id, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON api_keys TO varytra_app;
CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_organization_id_idx ON audit_events (organization_id, occurred_at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON audit_events TO varytra_app;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE FUNCTION resolve_organization_membership(requested_user_id text, requested_organization_id uuid)
RETURNS TABLE (organization_id uuid, user_id text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT organization_id, user_id, role
  FROM organization_memberships
  WHERE user_id = requested_user_id AND organization_id = requested_organization_id
$$;

REVOKE ALL ON FUNCTION resolve_organization_membership(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_organization_membership(text, uuid) TO varytra_app;
