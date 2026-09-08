import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { claimRun, createComparisonBatch, finishRun, recoverExpiredRuns } from '@varytra/infrastructure/scheduling';
import { runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '21212121-2121-4121-8121-212121212121';
const projectId = '23232323-2323-4232-8232-232323232323';
const baselineId = '24242424-2424-4242-8242-242424242424';
const candidateId = '25252525-2525-4252-8252-252525252525';
const scenarioId = '26262626-2626-4262-8262-262626262626';

describeDatabase('worker-recovery', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['recovery', 'Recovery', 'recovery@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Recovery']);
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Recovery project']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('27272727-2727-4272-8272-272727272727', $1, $2, 'scenario')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '27272727-2727-4272-8272-272727272727', 1, '{}', 'fixture://support/42', '{}', '{}', $4, 'recovery')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'recovery'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'recovery')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
  });
  afterAll(async () => database?.end());

  it('handles duplicate delivery once and reclaims an expired retry-safe lease without accepting stale completion', async () => {
    const batch = await createComparisonBatch(database!, { organizationId, projectId, userId: 'recovery', baselineAgentVersionId: baselineId, candidateAgentVersionId: candidateId, scenarioVersionIds: [scenarioId], repetitionCount: 1, idempotencyKey: 'recovery-1' });
    const dispatch = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<{ readonly id: string; readonly runId: string }>('SELECT id, run_id AS "runId" FROM agent_run_dispatches WHERE run_id IN (SELECT id FROM agent_runs WHERE batch_id = $1) ORDER BY id LIMIT 1', [batch.id])).rows[0]);
    if (dispatch === undefined) throw new Error('Missing dispatch');
    const claimInput = { dispatchId: dispatch.id, runId: dispatch.runId, organizationId, organizationLimit: 2, endpointLimit: 2 };
    const first = await claimRun(database!, claimInput);
    expect(first).toBeDefined();
    await expect(claimRun(database!, claimInput)).resolves.toBeUndefined();
    await withOrganizationTransaction(database!, organizationId, async (client) => client.query("UPDATE agent_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [dispatch.runId]));
    expect(await recoverExpiredRuns(database!, organizationId)).toBe(1);
    const replacement = await claimRun(database!, claimInput);
    expect(replacement).toBeDefined();
    expect(await finishRun(database!, organizationId, dispatch.runId, first!.leaseToken, 'succeeded')).toBe(false);
    expect(await finishRun(database!, organizationId, dispatch.runId, replacement!.leaseToken, 'succeeded')).toBe(true);
  });
});
