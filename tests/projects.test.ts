import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '77777777-7777-4777-8777-777777777777';
const foreignOrganizationId = '88888888-8888-4888-8888-888888888888';

describeDatabase('projects', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  const app = buildApp({
    database: database!,
    auth: {
      handler: async () => new Response(),
      getSessionUserId: async (headers) => headers.get('x-test-user') ?? undefined,
      isRecentSession: async () => true,
    },
  });
  const ownerHeaders = { 'x-test-user': 'project-owner', 'x-varytra-organization': organizationId };
  const editorHeaders = { 'x-test-user': 'project-editor', 'x-varytra-organization': organizationId };
  const viewerHeaders = { 'x-test-user': 'project-viewer', 'x-varytra-organization': organizationId };

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
      ['project-owner', 'Project owner', 'owner@projects.test', 'project-editor', 'Project editor', 'editor@projects.test', 'project-viewer', 'Project viewer', 'viewer@projects.test'],
    );
    await database!.query('INSERT INTO organizations (id, name, data_classification, retention_days) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)', [organizationId, 'Projects', 'sensitive', 180, foreignOrganizationId, 'Foreign', 'standard', 90]);
    await database!.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'viewer')",
      [organizationId, 'project-owner', 'project-editor', 'project-viewer'],
    );
  });

  afterAll(async () => {
    await app.close();
    await database?.end();
  });

  it('creates, reads, updates, audits, and deletes organization-scoped projects', async () => {
    const create = await app.inject({ method: 'POST', url: '/v1/projects', headers: editorHeaders, payload: { name: 'Refund safeguard', description: 'Can the candidate issue an unsafe refund?' } });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ readonly project: { readonly id: string; readonly dataClassification: string; readonly retentionDays: number } }>().project;
    expect(created.dataClassification).toBe('sensitive');
    expect(created.retentionDays).toBe(180);

    const list = await app.inject({ method: 'GET', url: '/v1/projects', headers: viewerHeaders });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ readonly projects: readonly { readonly id: string; readonly name: string }[] }>().projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id, name: 'Refund safeguard' }),
    ]));

    const update = await app.inject({ method: 'PATCH', url: `/v1/projects/${created.id}`, headers: editorHeaders, payload: { name: 'Refund controls' } });
    expect(update.statusCode).toBe(200);
    expect(update.json<{ readonly project: { readonly name: string; readonly retentionDays: number } }>().project).toEqual(expect.objectContaining({ name: 'Refund controls', retentionDays: 180 }));

    const audit = await app.inject({ method: 'GET', url: `/v1/projects/${created.id}/audit-events`, headers: ownerHeaders });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{ readonly events: readonly { readonly action: string }[] }>().events.map((event) => event.action)).toEqual(['project.updated', 'project.created']);

    const deletion = await app.inject({ method: 'DELETE', url: `/v1/projects/${created.id}`, headers: ownerHeaders });
    expect(deletion.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/projects/${created.id}`, headers: ownerHeaders })).statusCode).toBe(404);
  });

  it('denies viewer mutations and foreign project reads without disclosing content', async () => {
    const foreignProject = await withOrganizationTransaction(database!, foreignOrganizationId, async (client) => client.query<{ readonly id: string }>(
      'INSERT INTO projects (organization_id, name) VALUES ($1, $2) RETURNING id',
      [foreignOrganizationId, 'Foreign project'],
    ));
    const foreignId = foreignProject.rows[0]?.id;
    if (foreignId === undefined) throw new Error('Foreign project insert did not return an ID');

    expect((await app.inject({ method: 'POST', url: '/v1/projects', headers: viewerHeaders, payload: { name: 'Denied' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/v1/projects/${foreignId}`, headers: ownerHeaders })).statusCode).toBe(404);
  });
});
