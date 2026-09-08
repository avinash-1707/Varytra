import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { createComparisonBatch, SchedulingError } from '@varytra/infrastructure/scheduling';
import { runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '12121212-1212-4121-8121-121212121212';
const projectId = '13131313-1313-4131-8131-131313131313';
const baselineId = '14141414-1414-4141-8141-141414141414';
const candidateId = '15151515-1515-4151-8151-151515151515';
const scenarioId = '16161616-1616-4161-8161-161616161616';

describeDatabase('batch-scheduling', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['scheduler', 'Scheduler', 'scheduler@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Scheduling']);
      await client.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'editor')", [organizationId, 'scheduler']);
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Batch project']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('17171717-1717-4171-8171-171717171717', $1, $2, 'scenario')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '17171717-1717-4171-8171-171717171717', 1, '{}', 'fixture://support/42', '{}', '{}', $4, 'scheduler')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'scheduler'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'scheduler')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
  });
  afterAll(async () => database?.end());

  it('creates paired repetitions atomically and returns the original batch for a matching idempotency key', async () => {
    const input = { organizationId, projectId, userId: 'scheduler', baselineAgentVersionId: baselineId, candidateAgentVersionId: candidateId, scenarioVersionIds: [scenarioId], repetitionCount: 2, idempotencyKey: 'release-42' };
    const created = await createComparisonBatch(database!, input);
    const replayed = await createComparisonBatch(database!, input);

    expect(created).toEqual({ id: replayed.id, status: 'queued', runCount: 4 });
    await expect(createComparisonBatch(database!, { ...input, repetitionCount: 1 })).rejects.toEqual(expect.objectContaining({ code: 'idempotency_key_reused' } satisfies Partial<SchedulingError>));
    const counts = await withOrganizationTransaction(database!, organizationId, async (client) => client.query("SELECT status, count(*)::integer AS count FROM agent_runs WHERE batch_id = $1 GROUP BY status", [created.id]));
    expect(counts.rows).toEqual([{ status: 'queued', count: 4 }]);
  });
});
