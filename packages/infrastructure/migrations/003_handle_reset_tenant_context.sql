DROP POLICY organizations_tenant_isolation ON organizations;

CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
