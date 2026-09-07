DROP POLICY artifact_tombstones_tenant_isolation ON artifact_tombstones;

CREATE POLICY artifact_tombstones_tenant_isolation ON artifact_tombstones
  FOR ALL
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
