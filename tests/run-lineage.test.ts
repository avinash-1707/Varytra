import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArtifactStorage, createDatabasePool, withOrganizationTransaction, type ArtifactStorageTransport, type ArtifactTombstoneStore } from '@varytra/infrastructure';
import { claimRun, createComparisonBatch } from '@varytra/infrastructure/scheduling';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { executeClaimedRun } from '../apps/worker/src/scheduler.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '41414141-4141-4141-8141-414141414141';
const projectId = '42424242-4242-4242-8242-424242424242';
const baselineId = '43434343-4343-4343-8343-434343434343';
const candidateId = '44444444-4444-4444-8444-444444444444';
const scenarioId = '45454545-4545-4545-8545-454545454545';

describeDatabase('run-lineage', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['lineage', 'Lineage', 'lineage@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Lineage']);
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Lineage']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('46464646-4646-4646-8646-464646464646', $1, $2, 'scenario')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '46464646-4646-4646-8646-464646464646', 1, '{}', 'fixture://support/42', '{}', '{}', $4, 'lineage')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'lineage'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'lineage')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
    });
  });
  afterAll(async () => database?.end());

  it('persists all artifact lineage and only completes after it exists', async () => {
    const batch = await createComparisonBatch(database!, { organizationId, projectId, userId: 'lineage', baselineAgentVersionId: baselineId, candidateAgentVersionId: candidateId, scenarioVersionIds: [scenarioId], repetitionCount: 1, idempotencyKey: 'lineage-1' });
    const dispatch = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<{ readonly dispatchId: string; readonly runId: string }>('SELECT id AS "dispatchId", run_id AS "runId" FROM agent_run_dispatches WHERE run_id IN (SELECT id FROM agent_runs WHERE batch_id = $1) ORDER BY created_at LIMIT 1', [batch.id])).rows[0]);
    if (dispatch === undefined) throw new Error('Missing dispatch');
    const claimed = await claimRun(database!, { ...dispatch, organizationId, organizationLimit: 2, endpointLimit: 2 });
    if (claimed === undefined) throw new Error('Run was not claimed');
    const metadata = new Map<string, Readonly<Record<string, string>>>();
    const transport: ArtifactStorageTransport = { write: async ({ key, metadata: value }) => { metadata.set(key, value); }, readMetadata: async (key) => metadata.get(key), signRead: async () => 'https://artifact.test', delete: async () => {} };
    const tombstones: ArtifactTombstoneStore = { exists: async () => false, create: async () => {} };
    await executeClaimedRun(database!, createArtifactStorage(transport, tombstones), organizationId, claimed);
    const result = await withOrganizationTransaction(database!, organizationId, async (client) => client.query('SELECT kind, content_hash, storage_ref FROM agent_run_artifacts WHERE run_id = $1 ORDER BY kind', [claimed.runId]));
    const run = await withOrganizationTransaction(database!, organizationId, async (client) => client.query('SELECT status, event_count, tool_call_count FROM agent_runs WHERE id = $1', [claimed.runId]));
    expect(result.rows.map((row) => row.kind)).toEqual(['normalized-trace', 'raw-trace', 'redacted-trace']);
    expect(result.rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.content_hash)))).toBe(true);
    expect(run.rows[0]).toEqual({ status: 'succeeded', event_count: 1, tool_call_count: 1 });
  });
});
