import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction, type ArtifactStorage } from '@varytra/infrastructure';
import { claimRun, createComparisonBatch } from '@varytra/infrastructure/scheduling';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { executeClaimedRun } from '../apps/worker/src/scheduler.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '51515151-5151-4151-8151-515151515151';
const projectId = '52525252-5252-4252-8252-525252525252';
const baselineId = '53535353-5353-4353-8353-535353535353';
const candidateId = '54545454-5454-4454-8454-545454545454';
const scenarioId = '55555555-5555-4555-8555-555555555555';

describeDatabase('upload-failure', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['upload', 'Upload', 'upload@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Upload']); await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Upload']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('56565656-5656-4656-8656-565656565656', $1, $2, 'scenario')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '56565656-5656-4656-8656-565656565656', 1, '{}', 'fixture://support/42', '{}', '{}', $4, 'upload')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'upload'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'upload')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
  });
  afterAll(async () => database?.end());

  it('marks a run infrastructure_failed when an artifact upload fails', async () => {
    const batch = await createComparisonBatch(database!, { organizationId, projectId, userId: 'upload', baselineAgentVersionId: baselineId, candidateAgentVersionId: candidateId, scenarioVersionIds: [scenarioId], repetitionCount: 1, idempotencyKey: 'upload-1' });
    const dispatch = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<{ readonly dispatchId: string; readonly runId: string }>('SELECT id AS "dispatchId", run_id AS "runId" FROM agent_run_dispatches WHERE run_id IN (SELECT id FROM agent_runs WHERE batch_id = $1) ORDER BY created_at LIMIT 1', [batch.id])).rows[0]);
    if (dispatch === undefined) throw new Error('Missing dispatch');
    const claimed = await claimRun(database!, { ...dispatch, organizationId, organizationLimit: 2, endpointLimit: 2 });
    if (claimed === undefined) throw new Error('Run was not claimed');
    const failingStorage: ArtifactStorage = { write: async () => { throw new Error('upload failed'); }, getSignedReadUrl: async () => 'https://artifact.test', deleteExpired: async () => {} };
    await executeClaimedRun(database!, failingStorage, organizationId, claimed);
    const run = await withOrganizationTransaction(database!, organizationId, async (client) => client.query('SELECT status, progress_stage FROM agent_runs WHERE id = $1', [claimed.runId]));
    const artifacts = await withOrganizationTransaction(database!, organizationId, async (client) => client.query('SELECT 1 FROM agent_run_artifacts WHERE run_id = $1', [claimed.runId]));
    expect(run.rows[0]).toEqual({ status: 'infrastructure_failed', progress_stage: 'failed' });
    expect(artifacts.rows).toEqual([]);
  });
});
