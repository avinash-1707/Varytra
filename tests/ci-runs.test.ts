import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';
import { issueApiKey } from '../apps/api/src/authorization.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = 'a1111111-1111-4111-8111-111111111111';
const projectId = 'a2222222-2222-4222-8222-222222222222';
const baselineId = 'a3333333-3333-4333-8333-333333333333';
const candidateId = 'a4444444-4444-4444-8444-444444444444';
const scenarioId = 'a5555555-5555-4555-8555-555555555555';

describeDatabase('ci-runs', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  const app = buildApp({ database: database! });
  let readWriteToken = '';
  let expiredToken = '';
  let writeOnlyToken = '';

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['ci-owner', 'CI owner', 'ci-owner@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'CI']);
      await client.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, 'ci-owner', 'editor')", [organizationId]);
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'CI project']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('a6666666-6666-4666-8666-666666666666', $1, $2, 'ci')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'a6666666-6666-4666-8666-666666666666', 1, '{}', 'fixture://ci', '{}', '{}', $4, 'ci-owner')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'ci-owner'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'ci-owner')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
    const expiresAt = new Date(Date.now() + 60_000);
    readWriteToken = (await issueApiKey(database!, { organizationId, projectId, createdByUserId: 'ci-owner', name: 'CI read write', scopes: ['ci:read', 'ci:write'], expiresAt })).token;
    writeOnlyToken = (await issueApiKey(database!, { organizationId, projectId, createdByUserId: 'ci-owner', name: 'CI write only', scopes: ['ci:write'], expiresAt })).token;
    expiredToken = (await issueApiKey(database!, { organizationId, projectId, createdByUserId: 'ci-owner', name: 'Expired CI', scopes: ['ci:read'], expiresAt: new Date(Date.now() - 60_000) })).token;
  });

  afterAll(async () => { await app.close(); await database?.end(); });

  it('creates one scoped CI run per idempotency key and returns an opaque pending projection', async () => {
    const payload = { baseline_agent_version_id: baselineId, candidate_agent_version_id: candidateId, scenario_version_ids: [scenarioId], repetition_count: 1, idempotency_key: 'ci-release-1' };
    const headers = { authorization: `Bearer ${readWriteToken}` };
    const first = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/ci-runs`, headers, payload });
    const second = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/ci-runs`, headers: { authorization: `Bearer ${writeOnlyToken}` }, payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect((await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/ci-runs`, headers, payload: { ...payload, repetition_count: 2 } })).statusCode).toBe(409);
    const concurrentPayload = { ...payload, idempotency_key: 'ci-release-concurrent' };
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/projects/${projectId}/ci-runs`, headers, payload: concurrentPayload }),
      app.inject({ method: 'POST', url: `/v1/projects/${projectId}/ci-runs`, headers: { authorization: `Bearer ${writeOnlyToken}` }, payload: concurrentPayload }),
    ]);
    expect(concurrentFirst.json()).toEqual(concurrentSecond.json());
    const ciRun = first.json<{ readonly ci_run: { readonly id: string; readonly batch_id: string; readonly status: string } }>().ci_run;
    expect(ciRun.status).toBe('pending');
    expect(first.body).not.toMatch(/secret:|trace|artifact|payload/i);

    const status = await app.inject({ method: 'GET', url: `/v1/ci-runs/${ciRun.id}`, headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ ci_run: { id: ciRun.id, batch_id: ciRun.batch_id, status: 'pending', report_url: null } });
    expect(status.body).not.toMatch(/secret:|trace|artifact|payload/i);
    expect((await app.inject({ method: 'GET', url: `/v1/ci-runs/${ciRun.id}`, headers: { authorization: `Bearer ${writeOnlyToken}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/v1/ci-runs/${ciRun.id}`, headers: { authorization: `Bearer ${expiredToken}` } })).statusCode).toBe(401);
  });
});
