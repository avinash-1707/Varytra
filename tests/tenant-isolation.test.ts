import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const firstOrganizationId = '11111111-1111-4111-8111-111111111111';
const secondOrganizationId = '22222222-2222-4222-8222-222222222222';

describeDatabase('tenant-isolation', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6)', ['member-a', 'Member A', 'a@example.test', 'member-b', 'Member B', 'b@example.test']);
    await database!.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)', [firstOrganizationId, 'First', secondOrganizationId, 'Second']);
    await database!.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'viewer'), ($3, $4, 'viewer')", [firstOrganizationId, 'member-a', secondOrganizationId, 'member-b']);
  });

  afterAll(async () => database?.end());

  it('does not disclose another organization through selected context or guessed project IDs', async () => {
    await withOrganizationTransaction(database!, secondOrganizationId, async (client) => {
      await client.query('INSERT INTO projects (id, organization_id) VALUES ($1, $2)', ['33333333-3333-4333-8333-333333333333', secondOrganizationId]);
    });
    const app = buildApp({
      database: database!,
      auth: {
        handler: async () => new Response(),
        getSessionUserId: async (headers) => headers.get('x-test-user') ?? undefined,
        isRecentSession: async () => true,
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/organization/members', headers: { 'x-test-user': 'member-a', 'x-varytra-organization': secondOrganizationId } });
    const foreignProject = await withOrganizationTransaction(database!, firstOrganizationId, async (client) => client.query('SELECT id FROM projects WHERE id = $1', ['33333333-3333-4333-8333-333333333333']));

    expect(response.statusCode).toBe(404);
    expect(foreignProject.rows).toEqual([]);
    await app.close();
  });
});
