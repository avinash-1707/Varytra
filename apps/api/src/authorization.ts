import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { withOrganizationTransaction } from '@varytra/infrastructure';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const roles = ['owner', 'admin', 'editor', 'viewer'] as const;
const capabilities = ['members:read', 'members:write', 'projects:read', 'projects:create', 'projects:update', 'projects:delete', 'versions:read', 'versions:create', 'api_keys:create', 'api_keys:manage_any', 'api_keys:manage_own', 'audit:read'] as const;
const apiKeyScopes = ['ci:read', 'ci:write'] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OrganizationRole = (typeof roles)[number];
export type Capability = (typeof capabilities)[number];
export type ApiKeyScope = (typeof apiKeyScopes)[number];

const roleCapabilities: Readonly<Record<OrganizationRole, readonly Capability[]>> = {
  owner: capabilities,
  admin: capabilities,
  editor: ['projects:read', 'projects:create', 'projects:update', 'versions:read', 'versions:create', 'api_keys:create', 'api_keys:manage_own'],
  viewer: ['projects:read', 'versions:read'],
};

export class AuthorizationError extends Error {
  public constructor(public readonly code: 'active_organization_required' | 'forbidden' | 'invalid_credentials' | 'invalid_request' | 'not_found') {
    super(code);
    this.name = 'AuthorizationError';
  }
}

export function requireCapability(role: OrganizationRole, capability: Capability): void {
  if (!roleCapabilities[role].includes(capability)) {
    throw new AuthorizationError('forbidden');
  }
}

export interface Membership {
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly userId: string;
}

export async function resolveMembership(pool: Pool, userId: string, organizationId: string | undefined): Promise<Membership> {
  if (organizationId === undefined) {
    throw new AuthorizationError('active_organization_required');
  }
  if (!uuidPattern.test(organizationId)) {
    throw new AuthorizationError('invalid_request');
  }
  const result = await pool.query<Membership>(
    'SELECT organization_id AS "organizationId", user_id AS "userId", role FROM resolve_organization_membership($1, $2)',
    [userId, organizationId],
  );
  const membership = result.rows[0];

  if (membership === undefined || !roles.includes(membership.role)) {
    throw new AuthorizationError('not_found');
  }

  return membership;
}

export interface IssuedApiKey {
  readonly id: string;
  readonly token: string;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scopes: readonly ApiKeyScope[];
}

export interface CiPrincipal {
  readonly kind: 'api_key';
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scopes: readonly ApiKeyScope[];
}

export interface AuditEvent {
  readonly action: string;
  readonly actorId: string;
  readonly actorType: 'api_key' | 'system' | 'user';
  readonly metadata?: Readonly<Record<string, string>>;
  readonly organizationId: string;
  readonly targetId: string;
  readonly targetType: string;
}

export async function writeAuditEvent(
  client: PoolClient,
  event: AuditEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (organization_id, actor_type, actor_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.organizationId, event.actorType, event.actorId, event.action, event.targetType, event.targetId, event.metadata ?? {}],
  );
}

export async function createOrganization(pool: Pool, input: Readonly<{
  name: string;
  ownerId: string;
}>): Promise<{ readonly id: string; readonly name: string }> {
  const id = randomUUID();
  return withOrganizationTransaction(pool, id, async (client) => {
    await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, input.name]);
    await client.query(
      'INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)',
      [id, input.ownerId, 'owner'],
    );
    await writeAuditEvent(client, {
      organizationId: id,
      actorType: 'user',
      actorId: input.ownerId,
      action: 'organization.created',
      targetType: 'organization',
      targetId: id,
    });
    return { id, name: input.name };
  });
}

export async function listOrganizations(pool: Pool, userId: string): Promise<readonly { readonly id: string; readonly name: string; readonly role: OrganizationRole }[]> {
  const result = await pool.query<Readonly<{ organizationId: string; name: string; role: OrganizationRole }>>(
    'SELECT organization_id AS "organizationId", name, role FROM list_user_organizations($1)',
    [userId],
  );
  return result.rows.filter((row) => roles.includes(row.role)).map((row) => ({ id: row.organizationId, name: row.name, role: row.role }));
}

export async function changeMembership(pool: Pool, input: Readonly<{
  actor: Membership;
  role?: OrganizationRole;
  targetUserId: string;
}>): Promise<void> {
  const { actor, role, targetUserId } = input;
  if (role === 'owner' && actor.role !== 'owner') {
    throw new AuthorizationError('forbidden');
  }
  await withOrganizationTransaction(pool, actor.organizationId, async (client) => {
    const target = await client.query<Readonly<{ role: OrganizationRole }>>(
      'SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE',
      [actor.organizationId, targetUserId],
    );
    const existing = target.rows[0];
    if (existing?.role === 'owner' && actor.role !== 'owner') {
      throw new AuthorizationError('forbidden');
    }
    if (existing?.role === 'owner' && role !== 'owner') {
      const owners = await client.query(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND role = 'owner' FOR UPDATE",
        [actor.organizationId],
      );
      if (owners.rowCount === 1) {
        throw new AuthorizationError('forbidden');
      }
    }
    if (role === undefined) {
      if (existing === undefined) {
        throw new AuthorizationError('not_found');
      }
      await client.query('DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2', [actor.organizationId, targetUserId]);
      await writeAuditEvent(client, { organizationId: actor.organizationId, actorType: 'user', actorId: actor.userId, action: 'membership.removed', targetType: 'membership', targetId: targetUserId });
      return;
    }
    if (existing === undefined) {
      const user = await client.query('SELECT 1 FROM "user" WHERE id = $1', [targetUserId]);
      if (user.rowCount !== 1) {
        throw new AuthorizationError('not_found');
      }
    }
    await client.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
      [actor.organizationId, targetUserId, role],
    );
    await writeAuditEvent(client, { organizationId: actor.organizationId, actorType: 'user', actorId: actor.userId, action: existing === undefined ? 'membership.created' : 'membership.role_changed', targetType: 'membership', targetId: targetUserId, metadata: { role } });
  });
}

export async function issueApiKey(pool: Pool, input: Readonly<{
  organizationId: string;
  projectId: string;
  createdByUserId: string;
  expiresAt: Date;
  name: string;
  scopes: readonly ApiKeyScope[];
}>): Promise<IssuedApiKey> {
  if (input.scopes.length === 0 || input.scopes.some((scope) => !apiKeyScopes.includes(scope))) {
    throw new AuthorizationError('forbidden');
  }
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16);
  const hash = Buffer.from(await scrypt(secret, salt, 64));
  await withOrganizationTransaction(pool, input.organizationId, async (client) => {
    await client.query(
      `INSERT INTO api_keys (id, organization_id, project_id, created_by_user_id, name, scopes, secret_hash, secret_salt, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.organizationId, input.projectId, input.createdByUserId, input.name, input.scopes, hash, salt, input.expiresAt],
    );
    await writeAuditEvent(client, {
      organizationId: input.organizationId,
      actorType: 'user',
      actorId: input.createdByUserId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: id,
      metadata: { project_id: input.projectId },
    });
  });

  return { id, token: `vtr_${id}_${secret}` };
}

export async function authenticateApiKey(pool: Pool, token: string): Promise<ApiKeyRecord> {
  const tokenMatch = /^vtr_([0-9a-f-]{36})_([A-Za-z0-9_-]+)$/i.exec(token);
  const keyId = tokenMatch?.[1];
  const secret = tokenMatch?.[2];
  if (keyId === undefined || !uuidPattern.test(keyId) || secret === undefined) {
    throw new AuthorizationError('invalid_credentials');
  }
  const result = await pool.query<Readonly<{
    id: string;
    organizationId: string;
    projectId: string;
    scopes: string[];
    secretHash: Buffer;
    secretSalt: Buffer;
  }>>(
    `SELECT id, organization_id AS "organizationId", project_id AS "projectId", scopes,
       secret_hash AS "secretHash", secret_salt AS "secretSalt"
     FROM resolve_api_key($1)`,
    [keyId],
  );
  const key = result.rows[0];
  if (key === undefined) {
    throw new AuthorizationError('invalid_credentials');
  }
  const hash = Buffer.from(await scrypt(secret, key.secretSalt, 64));
  if (hash.length !== key.secretHash.length || !timingSafeEqual(hash, key.secretHash) || key.scopes.some((scope) => !apiKeyScopes.includes(scope as ApiKeyScope))) {
    throw new AuthorizationError('invalid_credentials');
  }
  await withOrganizationTransaction(pool, key.organizationId, async (client) => {
    await client.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]);
  });
  return { id: key.id, organizationId: key.organizationId, projectId: key.projectId, scopes: key.scopes as ApiKeyScope[] };
}

export async function rotateApiKey(pool: Pool, input: Readonly<{
  actorId: string;
  keyId: string;
  organizationId: string;
  projectId: string;
}>): Promise<IssuedApiKey> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16);
  const hash = Buffer.from(await scrypt(secret, salt, 64));
  await withOrganizationTransaction(pool, input.organizationId, async (client) => {
    const existing = await client.query<Readonly<{ expiresAt: Date; name: string; scopes: string[] }>>(
      `SELECT expires_at AS "expiresAt", name, scopes FROM api_keys
       WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [input.keyId, input.projectId],
    );
    const key = existing.rows[0];
    if (key === undefined || key.expiresAt <= new Date() || key.scopes.some((scope) => !apiKeyScopes.includes(scope as ApiKeyScope))) {
      throw new AuthorizationError('not_found');
    }
    await client.query(
      `INSERT INTO api_keys (id, organization_id, project_id, created_by_user_id, name, scopes, secret_hash, secret_salt, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.organizationId, input.projectId, input.actorId, key.name, key.scopes, hash, salt, key.expiresAt],
    );
    await client.query('UPDATE api_keys SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [input.keyId, id]);
    await writeAuditEvent(client, {
      organizationId: input.organizationId,
      actorType: 'user',
      actorId: input.actorId,
      action: 'api_key.rotated',
      targetType: 'api_key',
      targetId: input.keyId,
      metadata: { replacement_id: id },
    });
  });
  return { id, token: `vtr_${id}_${secret}` };
}

export async function authenticateCiPrincipal(pool: Pool, token: string, scope: ApiKeyScope): Promise<CiPrincipal> {
  const key = await authenticateApiKey(pool, token);
  if (!key.scopes.includes(scope)) {
    throw new AuthorizationError('forbidden');
  }
  return { kind: 'api_key', apiKeyId: key.id, organizationId: key.organizationId, projectId: key.projectId, scopes: key.scopes };
}
