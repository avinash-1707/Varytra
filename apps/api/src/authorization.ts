import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const roles = ['owner', 'admin', 'editor', 'viewer'] as const;
const capabilities = ['members:read', 'members:write', 'api_keys:create', 'api_keys:manage_any', 'api_keys:manage_own', 'audit:read'] as const;
const apiKeyScopes = ['ci:read', 'ci:write'] as const;

export type OrganizationRole = (typeof roles)[number];
export type Capability = (typeof capabilities)[number];
export type ApiKeyScope = (typeof apiKeyScopes)[number];

const roleCapabilities: Readonly<Record<OrganizationRole, readonly Capability[]>> = {
  owner: capabilities,
  admin: capabilities,
  editor: ['api_keys:create', 'api_keys:manage_own'],
  viewer: [],
};

export class AuthorizationError extends Error {
  public constructor(public readonly code: 'active_organization_required' | 'forbidden' | 'invalid_credentials' | 'not_found') {
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
  await pool.query(
    `INSERT INTO api_keys (id, organization_id, project_id, created_by_user_id, name, scopes, secret_hash, secret_salt, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, input.organizationId, input.projectId, input.createdByUserId, input.name, input.scopes, hash, salt, input.expiresAt],
  );

  return { id, token: `vtr_${id}_${secret}` };
}

export async function authenticateApiKey(pool: Pool, token: string): Promise<ApiKeyRecord> {
  const parts = token.split('_');
  if (parts.length !== 3 || parts[0] !== 'vtr' || parts[1] === undefined || parts[2] === undefined) {
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
     FROM api_keys WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [parts[1]],
  );
  const key = result.rows[0];
  if (key === undefined) {
    throw new AuthorizationError('invalid_credentials');
  }
  const hash = Buffer.from(await scrypt(parts[2], key.secretSalt, 64));
  if (hash.length !== key.secretHash.length || !timingSafeEqual(hash, key.secretHash) || key.scopes.some((scope) => !apiKeyScopes.includes(scope as ApiKeyScope))) {
    throw new AuthorizationError('invalid_credentials');
  }
  await pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]);
  return { id: key.id, organizationId: key.organizationId, projectId: key.projectId, scopes: key.scopes as ApiKeyScope[] };
}
