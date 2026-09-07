CREATE FUNCTION list_user_organizations(requested_user_id text)
RETURNS TABLE (organization_id uuid, name text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT organizations.id, organizations.name, organization_memberships.role
  FROM organization_memberships
  JOIN organizations ON organizations.id = organization_memberships.organization_id
  WHERE organization_memberships.user_id = requested_user_id
  ORDER BY organizations.created_at, organizations.id
$$;

REVOKE ALL ON FUNCTION list_user_organizations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_user_organizations(text) TO varytra_app;

CREATE FUNCTION resolve_api_key(requested_key_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  project_id uuid,
  scopes text[],
  secret_hash bytea,
  secret_salt bytea
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, organization_id, project_id, scopes, secret_hash, secret_salt
  FROM api_keys
  WHERE id = requested_key_id AND revoked_at IS NULL AND expires_at > now()
$$;

REVOKE ALL ON FUNCTION resolve_api_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(uuid) TO varytra_app;
