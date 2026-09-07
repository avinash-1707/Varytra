import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { authenticateApiKey, authenticateCiPrincipal, AuthorizationError, issueApiKey, rotateApiKey } from '../apps/api/src/authorization.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '44444444-4444-4444-8444-444444444444';
const projectId = '55555555-5555-4555-8555-555555555555';

describeDatabase('api-keys', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['key-owner', 'Key owner', 'key-owner@example.test']);
    await database!.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Keys']);
    await withOrganizationTransaction(database!, organizationId, async (client) => client.query('INSERT INTO projects (id, organization_id) VALUES ($1, $2)', [projectId, organizationId]));
  });

  afterAll(async () => database?.end());

  it('authenticates a scoped CI principal and rejects missing scopes, rotation, and revocation', async () => {
    const issued = await issueApiKey(database!, { organizationId, projectId, createdByUserId: 'key-owner', name: 'CI', scopes: ['ci:read'], expiresAt: new Date(Date.now() + 60_000) });
    await expect(authenticateCiPrincipal(database!, issued.token, 'ci:read')).resolves.toMatchObject({ kind: 'api_key', organizationId, projectId });
    await expect(authenticateCiPrincipal(database!, issued.token, 'ci:write')).rejects.toMatchObject({ code: 'forbidden' });
    const rotated = await rotateApiKey(database!, { actorId: 'key-owner', keyId: issued.id, organizationId, projectId });
    await expect(authenticateApiKey(database!, issued.token)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(authenticateApiKey(database!, rotated.token)).resolves.toMatchObject({ id: rotated.id });
    await withOrganizationTransaction(database!, organizationId, async (client) => client.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [rotated.id]));
    await expect(authenticateApiKey(database!, rotated.token)).rejects.toBeInstanceOf(AuthorizationError);
    const audit = await withOrganizationTransaction(database!, organizationId, async (client) => client.query<{ readonly action: string }>('SELECT action FROM audit_events WHERE organization_id = $1 ORDER BY occurred_at', [organizationId]));
    expect(audit.rows.map((event) => event.action)).toEqual(['api_key.created', 'api_key.rotated']);
  });
});
