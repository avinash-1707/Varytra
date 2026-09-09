import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '71717171-7171-4171-8171-717171717171';
const foreignOrganizationId = '72727272-7272-4272-8272-727272727272';
const projectId = '73737373-7373-4373-8373-737373737373';
const batchId = '74747474-7474-4474-8474-747474747474';
const scenarioId = '75757575-7575-4575-8575-757575757575';
const baselineId = '76767676-7676-4676-8676-767676767676';
const candidateId = '77777777-7777-4777-8777-777777777777';
const comparisonId = '78787878-7878-4878-8878-787878787878';

describeDatabase('reports', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  const app = buildApp({ database: database!, auth: { handler: async () => new Response(), getSessionUserId: async (headers) => headers.get('x-test-user') ?? undefined, isRecentSession: async () => true } });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)', ['viewer', 'Viewer', 'viewer@example.test', 'editor', 'Editor', 'editor@example.test', 'foreign', 'Foreign', 'foreign@example.test']);
    await database!.query('INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)', [organizationId, 'Reports', foreignOrganizationId, 'Foreign']);
    await database!.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'viewer'), ($1, $3, 'editor'), ($4, $5, 'viewer')", [organizationId, 'viewer', 'editor', foreignOrganizationId, 'foreign']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Reports']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('79797979-7979-4979-8979-797979797979', $1, $2, 'reports')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '79797979-7979-4979-8979-797979797979', 1, '{}', 'fixture://reports', '{}', '{}', $4, 'editor')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'editor'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'editor')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
      await client.query("INSERT INTO comparison_batches (id, organization_id, project_id, baseline_agent_version_id, candidate_agent_version_id, scenario_set_hash, config_snapshot, repetition_count, idempotency_key, request_fingerprint, status, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, '{}', 1, 'report-fixture', $7, 'completed', 'editor')", [batchId, organizationId, projectId, baselineId, candidateId, 'd'.repeat(64), 'e'.repeat(64)]);
      await client.query("INSERT INTO comparisons (id, organization_id, project_id, batch_id, scenario_version_id, classification, severity, confidence, gate_status, summary_redacted, coverage, first_material_divergence, state_comparison, evaluator_version) VALUES ($1, $2, $3, $4, $5, 'suspected-regression', 'critical', 'high', 'block', 'Candidate changed the refund state without approval.', '{\"expected_pairs\":1,\"complete_pairs\":1,\"analyzable_pairs\":1}', '{\"baseline_sequence_range\":[4,4],\"candidate_sequence_range\":[4,5],\"score\":12,\"raw_payload\":\"never expose\"}', '{\"status\":\"available\",\"expected_summary\":\"Approval required\",\"changes\":[{\"field\":\"refund\",\"baseline_value\":\"not issued\",\"candidate_value\":\"issued\",\"relevance\":\"policy\",\"raw_payload\":\"never expose\"}]}', 'evaluation-v1')", [comparisonId, organizationId, projectId, batchId, scenarioId]);
      await client.query("INSERT INTO comparison_findings (organization_id, project_id, comparison_id, category, severity, repetition, summary_redacted, evidence_refs) VALUES ($1, $2, $3, 'policy', 'critical', 1, 'Refund approval policy failed.', '[\"safe-finding-ref\"]')", [organizationId, projectId, comparisonId]);
    });
  });

  afterAll(async () => { await app.close(); await database?.end(); });

  it('returns only a tenant-authorized redacted report projection', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/comparisons/${comparisonId}/report`, headers: { 'x-test-user': 'viewer', 'x-varytra-organization': organizationId } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ report: { classification: 'suspected-regression', gate_status: 'block', coverage: { expected_pairs: 1 }, findings: [{ category: 'policy', summary: 'Refund approval policy failed.' }] } });
    expect(response.body).not.toMatch(/raw_payload|never expose|artifact|trace|secret/i);
    expect((await app.inject({ method: 'GET', url: `/v1/comparisons/${comparisonId}/report`, headers: { 'x-test-user': 'foreign', 'x-varytra-organization': foreignOrganizationId } })).statusCode).toBe(404);
  });
});
