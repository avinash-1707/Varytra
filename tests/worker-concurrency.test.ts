import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { claimRun, createComparisonBatch } from '@varytra/infrastructure/scheduling';
import { runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '31313131-3131-4131-8131-313131313131';
const projectId = '32323232-3232-4232-8232-323232323232';
const baselineId = '33333333-3333-4333-8333-333333333333';
const candidateId = '34343434-3434-4343-8434-343434343434';
const scenarioId = '35353535-3535-4353-8353-353535353535';

describeDatabase('worker-concurrency', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['concurrency', 'Concurrency', 'concurrency@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Concurrency']);
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Concurrency project']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('36363636-3636-4363-8363-363636363636', $1, $2, 'scenario')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '36363636-3636-4363-8363-363636363636', 1, '{}', 'fixture://support/42', '{}', '{}', $4, 'concurrency')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'concurrency'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'concurrency')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
  });
  afterAll(async () => database?.end());

  it('keeps excess work queued when the organization concurrency cap is full', async () => {
    const batch = await createComparisonBatch(database!, { organizationId, projectId, userId: 'concurrency', baselineAgentVersionId: baselineId, candidateAgentVersionId: candidateId, scenarioVersionIds: [scenarioId], repetitionCount: 1, idempotencyKey: 'concurrency-1' });
    const dispatches = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<{ readonly id: string; readonly runId: string }>('SELECT id, run_id AS "runId" FROM agent_run_dispatches WHERE run_id IN (SELECT id FROM agent_runs WHERE batch_id = $1) ORDER BY id', [batch.id])).rows);
    const first = dispatches[0];
    const second = dispatches[1];
    if (first === undefined || second === undefined) throw new Error('Missing dispatches');
    expect(await claimRun(database!, { dispatchId: first.id, runId: first.runId, organizationId, organizationLimit: 1, endpointLimit: 1 })).toBeDefined();
    expect(await claimRun(database!, { dispatchId: second.id, runId: second.runId, organizationId, organizationLimit: 1, endpointLimit: 1 })).toBeUndefined();
    const queued = await withOrganizationTransaction(database!, organizationId, async (client) => client.query("SELECT status FROM agent_runs WHERE id = $1", [second.runId]));
    expect(queued.rows[0]).toEqual({ status: 'queued' });
  });
});
