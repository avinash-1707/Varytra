import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { claimReviewNotification, markReviewNotificationDelivered, retryReviewNotification } from '@varytra/infrastructure/review-notifications';
import { completeRunWithArtifacts, deriveComparisonReport, type RunOutcome } from '@varytra/infrastructure/scheduling';

const baseOutcome = (side: 'baseline' | 'candidate', finalState: Readonly<Record<string, unknown>>, policyFailures: readonly string[] = []): RunOutcome => ({
  side,
  repetition: 1,
  finalState,
  policyFailures,
  metrics: { costUsd: 0, durationMs: 10, eventCount: 2, tokenUsage: 0, toolCallCount: 1 },
});

describe('report-finalization', () => {
  it('blocks a critical policy or final-state regression and preserves only redacted evidence', () => {
    const report = deriveComparisonReport({
      expectedFinalState: { refundIssued: false, status: 'resolved' },
      outcomes: [
        baseOutcome('baseline', { refundIssued: false, status: 'resolved' }),
        baseOutcome('candidate', { refundIssued: true, status: 'resolved' }, ['refund_requires_approval']),
      ],
    });

    expect(report).toMatchObject({ classification: 'suspected-regression', severity: 'critical', confidence: 'high', gateStatus: 'block' });
    expect(report.findings.map((finding) => finding.category)).toEqual(['final_state', 'policy']);
    expect(JSON.stringify(report)).not.toContain('raw_trace');
  });

  it('passes equivalent completed outcomes and marks missing pair evidence inconclusive', () => {
    const expectedFinalState = { refundIssued: false, status: 'resolved' };
    expect(deriveComparisonReport({ expectedFinalState, outcomes: [baseOutcome('baseline', expectedFinalState), baseOutcome('candidate', expectedFinalState)] })).toMatchObject({ classification: 'no-material-change', severity: 'none', gateStatus: 'pass' });
    expect(deriveComparisonReport({ expectedFinalState, outcomes: [baseOutcome('baseline', expectedFinalState)] })).toMatchObject({ classification: 'inconclusive', severity: 'unknown', gateStatus: 'review' });
  });
});

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '81818181-8181-4181-8181-818181818181';
const projectId = '82828282-8282-4282-8282-828282828282';
const scenarioId = '83838383-8383-4383-8383-838383838383';
const baselineId = '84848484-8484-4484-8484-848484848484';
const candidateId = '85858585-8585-4585-8585-858585858585';
const batchId = '86868686-8686-4686-8686-868686868686';
const baselineRunId = '87878787-8787-4787-8787-878787878787';
const candidateRunId = '88888888-8888-4888-8888-888888888888';
const baselineLease = '89898989-8989-4989-8989-898989898989';
const candidateLease = '90909090-9090-4090-8090-909090909090';

describeDatabase('report-finalization persistence', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true), ($4, $5, $6, true), ($7, $8, $9, false)', ['finalizer', 'Finalizer', 'finalizer@example.test', 'stale', 'Stale', 'stale@example.test', 'viewer', 'Viewer', 'viewer@example.test']);
    await withOrganizationTransaction(database!, organizationId, async (client) => {
      await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Finalizer']);
      await client.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, 'finalizer', 'editor'), ($1, 'stale', 'editor'), ($1, 'viewer', 'viewer')", [organizationId]);
      await client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Finalizer project']);
      await client.query("INSERT INTO scenarios (id, organization_id, project_id, stable_key) VALUES ('91919191-9191-4191-8191-919191919191', $1, $2, 'finalizer')", [organizationId, projectId]);
      await client.query("INSERT INTO scenario_versions (id, organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, content_hash, created_by_user_id) VALUES ($1, $2, $3, '91919191-9191-4191-8191-919191919191', 1, '{}', 'fixture://finalizer', $4, '{}', $5, 'finalizer')", [scenarioId, organizationId, projectId, { expected_state: { refundIssued: false, status: 'resolved' } }, 'a'.repeat(64)]);
      await client.query("INSERT INTO agent_versions (id, organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 'baseline', 1, 'reference', 'secret://baseline', '{}', $4, 'finalizer'), ($5, $2, $3, 'candidate', 1, 'reference', 'secret://candidate', '{}', $6, 'finalizer')", [baselineId, organizationId, projectId, 'b'.repeat(64), candidateId, 'c'.repeat(64)]);
      await client.query("INSERT INTO comparison_batches (id, organization_id, project_id, baseline_agent_version_id, candidate_agent_version_id, scenario_set_hash, config_snapshot, repetition_count, idempotency_key, request_fingerprint, status, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, '{}', 1, 'finalizer-test', $7, 'running', 'finalizer')", [batchId, organizationId, projectId, baselineId, candidateId, 'd'.repeat(64), 'e'.repeat(64)]);
      await client.query("INSERT INTO agent_runs (id, organization_id, project_id, batch_id, scenario_version_id, agent_version_id, side, repetition, endpoint_key, status, retry_safe, lease_token, lease_expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'baseline', 1, 'baseline', 'running', true, $7, now() + interval '1 minute'), ($8, $2, $3, $4, $5, $9, 'candidate', 1, 'candidate', 'running', true, $10, now() + interval '1 minute')", [baselineRunId, organizationId, projectId, batchId, scenarioId, baselineId, baselineLease, candidateRunId, candidateId, candidateLease]);
    });
  });

  afterAll(async () => database?.end());

  it('creates an immutable critical report after paired outcomes become terminal', async () => {
    const artifacts = (runId: string) => [
      { kind: 'raw-trace' as const, storageRef: `org/test/${runId}/raw`, contentHash: '1'.repeat(64), schemaVersion: '1.0', classification: 'restricted' as const },
      { kind: 'redacted-trace' as const, storageRef: `org/test/${runId}/redacted`, contentHash: '2'.repeat(64), schemaVersion: '1.0', classification: 'sensitive' as const },
      { kind: 'normalized-trace' as const, storageRef: `org/test/${runId}/normalized`, contentHash: '3'.repeat(64), schemaVersion: '1.0', classification: 'internal' as const },
    ];
    const metrics = { costUsd: 0, durationMs: 10, eventCount: 2, tokenUsage: 0, toolCallCount: 1 };
    await completeRunWithArtifacts(database!, organizationId, baselineRunId, baselineLease, artifacts(baselineRunId), metrics, { finalState: { refundIssued: false, status: 'resolved' }, policyFailures: [] });
    await completeRunWithArtifacts(database!, organizationId, candidateRunId, candidateLease, artifacts(candidateRunId), metrics, { finalState: { refundIssued: true, status: 'resolved' }, policyFailures: ['refund_requires_approval'] });
    const comparison = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<Readonly<{ id: string; classification: string; severity: string; gateStatus: string; summary: string }>>('SELECT id, classification, severity, gate_status AS "gateStatus", summary_redacted AS summary FROM comparisons WHERE batch_id = $1', [batchId])).rows[0]);
    expect(comparison).toMatchObject({ classification: 'suspected-regression', severity: 'critical', gateStatus: 'block' });
    expect(JSON.stringify(comparison)).not.toContain('raw');
    await withOrganizationTransaction(database!, organizationId, async (client) => { await client.query("DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = 'stale'", [organizationId]); });
    const notification = await claimReviewNotification(database!, organizationId);
    expect(notification).toMatchObject({ comparisonId: comparison?.id, projectId, recipientEmail: 'finalizer@example.test', severity: 'critical' });
    expect(JSON.stringify(notification)).not.toContain('raw_trace');
    expect(notification?.recipientEmail).not.toBe('viewer@example.test');
    const staleState = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<Readonly<{ status: string }>>("SELECT status FROM review_notification_outbox WHERE recipient_user_id = 'stale'", [])).rows[0]);
    expect(staleState).toEqual({ status: 'cancelled' });
    await retryReviewNotification(database!, organizationId, notification!.id);
    const retryState = await withOrganizationTransaction(database!, organizationId, async (client) => (await client.query<Readonly<{ attemptCount: number; status: string }>>('SELECT attempt_count AS "attemptCount", status FROM review_notification_outbox WHERE id = $1', [notification!.id])).rows[0]);
    expect(retryState).toEqual({ attemptCount: 1, status: 'queued' });
    await withOrganizationTransaction(database!, organizationId, async (client) => { await client.query('UPDATE review_notification_outbox SET available_at = now() WHERE id = $1', [notification!.id]); });
    const retried = await claimReviewNotification(database!, organizationId);
    expect(retried?.id).toBe(notification?.id);
    await markReviewNotificationDelivered(database!, organizationId, retried!.id);
    expect(await claimReviewNotification(database!, organizationId)).toBeUndefined();
  });
});
