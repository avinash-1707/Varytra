import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '81818181-8181-4181-8181-818181818181';
const projectId = '82828282-8282-4282-8282-828282828282';
const batchId = '83838383-8383-4383-8383-838383838383';
const scenarioId = '84848484-8484-4484-8484-848484848484';
const baselineId = '85858585-8585-4585-8585-858585858585';
const candidateId = '86868686-8686-4686-8686-868686868686';
const comparisonId = '87878787-8787-4787-8787-878787878787';

describeDatabase('review-decisions', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  const app = buildApp({ database: database!, auth: { handler: async () => new Response(), getSessionUserId: async (headers) => headers.get('x-test-user') ?? undefined, isRecentSession: async () => true } });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6)', ['editor', 'Editor', 'editor@example.test', 'viewer', 'Viewer', 'viewer@example.test']);
    await database!.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Review']);
    await database!.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')", [organizationId, 'editor', 'viewer']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Review']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('88888888-8888-4888-8888-888888888888', $1, $2, 'review')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '88888888-8888-4888-8888-888888888888', 1, '{}', 'fixture://review', '{}', '{}', $4, 'editor')", [scenarioId, organizationId, projectId, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'editor'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'editor')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
      await client.query("INSERT INTO comparison_batches (id, organization_id, project_id, baseline_agent_version_id, candidate_agent_version_id, scenario_set_hash, config_snapshot, repetition_count, idempotency_key, request_fingerprint, status, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, '{}', 1, 'review-fixture', $7, 'completed', 'editor')", [batchId, organizationId, projectId, baselineId, candidateId, 'd'.repeat(64), 'e'.repeat(64)]);
      await client.query("INSERT INTO comparisons (id, organization_id, project_id, batch_id, scenario_version_id, classification, severity, confidence, gate_status, summary_redacted, coverage, state_comparison, evaluator_version) VALUES ($1, $2, $3, $4, $5, 'no-material-change', 'none', 'high', 'pass', 'No material difference.', '{\"expected_pairs\":1,\"complete_pairs\":1,\"analyzable_pairs\":1}', '{\"status\":\"unavailable\"}', 'evaluation-v1')", [comparisonId, organizationId, projectId, batchId, scenarioId]);
    });
  });

  afterAll(async () => { await app.close(); await database?.end(); });

  it('requires rationale, appends immutable decisions, audits the action, and recalculates the gate', async () => {
    const headers = { 'x-test-user': 'editor', 'x-varytra-organization': organizationId };
    expect((await app.inject({ method: 'POST', url: `/v1/comparisons/${comparisonId}/review`, headers, payload: { action: 'reject', rationale: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/v1/comparisons/${comparisonId}/review`, headers: { ...headers, 'x-test-user': 'viewer' }, payload: { action: 'reject', rationale: 'Reviewer found a safety issue.' } })).statusCode).toBe(403);
    const response = await app.inject({ method: 'POST', url: `/v1/comparisons/${comparisonId}/review`, headers, payload: { action: 'reject', rationale: 'Reviewer found a safety issue.' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ review_decision: { action: 'reject', gate_status: 'block' } });
    const records = await withOrganizationTransaction(database!, organizationId, async (client) => ({ decisions: await client.query('SELECT action, rationale FROM review_decisions WHERE comparison_id = $1', [comparisonId]), audit: await client.query("SELECT action FROM audit_events WHERE target_id = $1 AND action = 'comparison.review_recorded'", [comparisonId]) }));
    expect(records.decisions.rows).toEqual([{ action: 'reject', rationale: 'Reviewer found a safety issue.' }]);
    expect(records.audit.rowCount).toBe(1);
    await expect(withOrganizationTransaction(database!, organizationId, async (client) => client.query("UPDATE review_decisions SET rationale = 'changed' WHERE comparison_id = $1", [comparisonId]))).rejects.toThrow('comparison report records are immutable');
    const override = await app.inject({ method: 'POST', url: `/v1/comparisons/${comparisonId}/review`, headers, payload: { action: 'override_classification', rationale: 'Evidence was reclassified after review.', override_classification: 'inconclusive' } });
    expect(override.statusCode).toBe(201);
    expect(override.json()).toMatchObject({ review_decision: { action: 'override_classification', override_classification: 'inconclusive', gate_status: 'review' } });
    expect((await app.inject({ method: 'POST', url: `/v1/comparisons/${comparisonId}/review`, headers, payload: { action: 'override_classification', rationale: 'Missing classification.' } })).statusCode).toBe(400);
    const restricted = await app.inject({ method: 'POST', url: `/v1/comparisons/${comparisonId}/review`, headers, payload: { action: 'approve', rationale: 'authorization: Bearer secret-value' } });
    expect(restricted.statusCode).toBe(201);
    const report = await app.inject({ method: 'GET', url: `/v1/comparisons/${comparisonId}/report`, headers });
    expect(report.json()).toMatchObject({ report: { classification: 'inconclusive', gate_status: 'pass', review_decisions: [{ action: 'approve', rationale: '[REDACTED_RESTRICTED_CONTENT]' }] } });
    expect(report.body).not.toContain('secret-value');
  });
});
