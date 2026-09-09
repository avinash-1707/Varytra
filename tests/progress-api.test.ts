import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { claimRun, createComparisonBatch, setRunProgress } from '@varytra/infrastructure/scheduling';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '61616161-6161-4161-8161-616161616161';
const foreignOrganizationId = '62626262-6262-4262-8262-626262626262';
const projectId = '63636363-6363-4363-8363-636363636363';
const baselineId = '64646464-6464-4464-8464-646464646464';
const candidateId = '65656565-6565-4565-8565-656565656565';
const scenarioId = '66666666-6666-4666-8666-666666666666';

describeDatabase('progress-api', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  const app = buildApp({ database: database!, auth: { handler: async () => new Response(), getSessionUserId: async (headers) => headers.get('x-test-user') ?? undefined, isRecentSession: async () => true } });
  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6)', ['progress', 'Progress', 'progress@example.test', 'foreign', 'Foreign', 'foreign@example.test']);
    await database!.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)', [organizationId, 'Progress', foreignOrganizationId, 'Foreign']);
    await database!.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'viewer'), ($3, $4, 'viewer')", [organizationId, 'progress', foreignOrganizationId, 'foreign']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Progress']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('67676767-6767-4767-8767-676767676767', $1, $2, 'scenario')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '67676767-6767-4767-8767-676767676767', 1, '{}', 'fixture://support/42', '{}', '{}', $4, 'progress')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'progress'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'progress')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
  });
  afterAll(async () => { await app.close(); await database?.end(); });

  it('returns authorized safe polling progress without artifact or payload fields', async () => {
    const batch = await createComparisonBatch(database!, { organizationId, projectId, userId: 'progress', baselineAgentVersionId: baselineId, candidateAgentVersionId: candidateId, scenarioVersionIds: [scenarioId], repetitionCount: 1, idempotencyKey: 'progress-1' });
    const dispatch = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<{ readonly dispatchId: string; readonly runId: string }>('SELECT id AS "dispatchId", run_id AS "runId" FROM agent_run_dispatches WHERE run_id IN (SELECT id FROM agent_runs WHERE batch_id = $1) ORDER BY created_at LIMIT 1', [batch.id])).rows[0]);
    if (dispatch === undefined) throw new Error('Missing dispatch');
    const claimed = await claimRun(database!, { ...dispatch, organizationId, organizationLimit: 2, endpointLimit: 2 });
    if (claimed === undefined) throw new Error('Run was not claimed');
    await setRunProgress(database!, organizationId, claimed.runId, claimed.leaseToken, 'preparing_fixture');
    const response = await app.inject({ method: 'GET', url: `/v1/comparison-batches/${batch.id}/progress`, headers: { 'x-test-user': 'progress', 'x-varytra-organization': organizationId } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ progress: { batch_id: batch.id, status: 'running', stage: 'preparing_fixture', runs: { total: 2, queued: 1, running: 1, succeeded: 0, failed: 0 } } });
    expect(response.body).not.toMatch(/artifact|trace|secret|payload|storage_ref/i);
    expect((await app.inject({ method: 'GET', url: `/v1/comparison-batches/${batch.id}/progress`, headers: { 'x-test-user': 'foreign', 'x-varytra-organization': foreignOrganizationId } })).statusCode).toBe(404);
  });
});
