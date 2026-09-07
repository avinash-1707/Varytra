CREATE TABLE artifact_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  object_key text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  retention_deadline timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, object_key)
);

ALTER TABLE artifact_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_tombstones FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON artifact_tombstones TO varytra_app;

CREATE POLICY artifact_tombstones_tenant_isolation ON artifact_tombstones
  FOR ALL
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);
