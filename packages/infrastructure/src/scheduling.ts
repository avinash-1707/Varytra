import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withOrganizationTransaction } from './index.js';

export type TerminalRunStatus = 'succeeded' | 'agent_failed' | 'infrastructure_failed' | 'timed_out';
export type ProgressStage = 'queued' | 'preparing_fixture' | 'running_baseline' | 'running_candidate' | 'complete' | 'failed';

export interface RunArtifactLineage {
  readonly classification: 'restricted' | 'sensitive' | 'internal';
  readonly contentHash: string;
  readonly kind: 'raw-trace' | 'redacted-trace' | 'normalized-trace';
  readonly schemaVersion: string;
  readonly storageRef: string;
  readonly retentionDeadline?: Date;
}

export interface ExpiredArtifactClaim {
  readonly batchId: string;
  readonly claimToken: string;
  readonly contentHash: string;
  readonly id: string;
  readonly kind: RunArtifactLineage['kind'];
  readonly projectId: string;
  readonly retentionDeadline: Date;
  readonly runId: string;
}

export interface SafeRunMetrics {
  readonly costUsd: number;
  readonly durationMs: number;
  readonly eventCount: number;
  readonly tokenUsage: number;
  readonly toolCallCount: number;
}

export interface RunOutcome {
  readonly finalState: Readonly<Record<string, unknown>>;
  readonly metrics: SafeRunMetrics;
  readonly policyFailures: readonly string[];
  readonly repetition: number;
  readonly side: 'baseline' | 'candidate';
}

export interface ComparisonReport {
  readonly classification: 'inconclusive' | 'no-material-change' | 'suspected-regression';
  readonly confidence: 'high' | 'low';
  readonly findings: readonly Readonly<{ category: 'final_state' | 'policy'; severity: 'critical' }> [];
  readonly gateStatus: 'block' | 'pass' | 'review';
  readonly severity: 'critical' | 'none' | 'unknown';
  readonly summary: string;
}

function statesMatch(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) || Array.isArray(right)) return false;
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && statesMatch(leftRecord[key], rightRecord[key]));
}

export function deriveComparisonReport(input: Readonly<{ expectedFinalState: Readonly<Record<string, unknown>>; outcomes: readonly RunOutcome[] }>): ComparisonReport {
  const repetitions = new Set(input.outcomes.map((outcome) => outcome.repetition));
  const completePairs = Array.from(repetitions).every((repetition) => input.outcomes.some((outcome) => outcome.repetition === repetition && outcome.side === 'baseline') && input.outcomes.some((outcome) => outcome.repetition === repetition && outcome.side === 'candidate'));
  if (input.outcomes.length === 0 || !completePairs) return { classification: 'inconclusive', severity: 'unknown', confidence: 'low', gateStatus: 'review', summary: 'Comparison evidence is incomplete.', findings: [] };
  const candidates = input.outcomes.filter((outcome) => outcome.side === 'candidate');
  const findings = candidates.flatMap((outcome) => [
    ...(statesMatch(outcome.finalState, input.expectedFinalState) ? [] : [{ category: 'final_state' as const, severity: 'critical' as const }]),
    ...outcome.policyFailures.map(() => ({ category: 'policy' as const, severity: 'critical' as const })),
  ]);
  if (findings.length > 0) return { classification: 'suspected-regression', severity: 'critical', confidence: 'high', gateStatus: 'block', summary: 'Candidate violated a final-state assertion or policy.', findings };
  return { classification: 'no-material-change', severity: 'none', confidence: 'high', gateStatus: 'pass', summary: 'No material difference across completed paired runs.', findings: [] };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

async function finalizeBatchReports(client: PoolClient, organizationId: string, batchId: string): Promise<void> {
  const batch = await client.query<Readonly<{ status: string }>>('SELECT status FROM comparison_batches WHERE id = $1', [batchId]);
  if (batch.rows[0]?.status !== 'completed') return;
  const outcomes = await client.query<Readonly<{ scenarioVersionId: string; projectId: string; side: 'baseline' | 'candidate'; repetition: number; hasOutcome: boolean; finalState: unknown; policyFailures: unknown; assertionSpec: unknown; costUsd: number; durationMs: number; eventCount: number; tokenUsage: number; toolCallCount: number }>>(
    `SELECT run.scenario_version_id AS "scenarioVersionId", run.project_id AS "projectId", run.side, run.repetition,
            outcome.run_id IS NOT NULL AS "hasOutcome", outcome.final_state AS "finalState", outcome.policy_failures AS "policyFailures", scenario.assertion_spec AS "assertionSpec",
            COALESCE(run.cost_usd, 0)::float8 AS "costUsd", COALESCE(run.duration_ms, 0) AS "durationMs", COALESCE(run.event_count, 0) AS "eventCount", COALESCE(run.token_usage, 0) AS "tokenUsage", COALESCE(run.tool_call_count, 0) AS "toolCallCount"
     FROM agent_runs run LEFT JOIN agent_run_outcomes outcome ON outcome.run_id = run.id
     JOIN scenario_versions scenario ON scenario.id = run.scenario_version_id
     WHERE run.batch_id = $1`, [batchId],
  );
  const byScenario = new Map<string, typeof outcomes.rows>();
  for (const outcome of outcomes.rows) byScenario.set(outcome.scenarioVersionId, [...(byScenario.get(outcome.scenarioVersionId) ?? []), outcome]);
  for (const [scenarioVersionId, rows] of byScenario) {
    const first = rows[0];
    if (first === undefined) continue;
    const expectedFinalState = record(record(first.assertionSpec).expected_state);
    const report = deriveComparisonReport({ expectedFinalState, outcomes: rows.filter((outcome) => outcome.hasOutcome).map((outcome) => ({ side: outcome.side, repetition: outcome.repetition, finalState: record(outcome.finalState), policyFailures: strings(outcome.policyFailures), metrics: { costUsd: outcome.costUsd, durationMs: outcome.durationMs, eventCount: outcome.eventCount, tokenUsage: outcome.tokenUsage, toolCallCount: outcome.toolCallCount } })) });
    const inserted = await client.query<Readonly<{ id: string }>>(
      `INSERT INTO comparisons (organization_id, project_id, batch_id, scenario_version_id, classification, severity, confidence, gate_status, summary_redacted, coverage, state_comparison, evaluator_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'report-finalizer-v1')
       ON CONFLICT (batch_id, scenario_version_id) DO NOTHING RETURNING id`,
      [organizationId, first.projectId, batchId, scenarioVersionId, report.classification, report.severity, report.confidence, report.gateStatus, report.summary, { expected_pairs: new Set(rows.map((row) => row.repetition)).size, complete_pairs: rows.length / 2, analyzable_pairs: report.classification === 'inconclusive' ? 0 : rows.length / 2 }, { status: 'derived', expected_summary: 'Stored in scenario version', baseline_summary: 'Redacted', candidate_summary: 'Redacted', changes: [] }],
    );
    const comparisonId = inserted.rows[0]?.id;
    if (comparisonId === undefined) continue;
    for (const finding of report.findings) {
      await client.query('INSERT INTO comparison_findings (organization_id, project_id, comparison_id, category, severity, summary_redacted) VALUES ($1, $2, $3, $4, $5, $6)', [organizationId, first.projectId, comparisonId, finding.category, finding.severity, finding.category === 'policy' ? 'Candidate policy requirement failed.' : 'Candidate final state did not match the scenario assertion.']);
    }
    if (report.gateStatus === 'block' || report.gateStatus === 'review') {
      await client.query(
        `INSERT INTO review_notification_outbox (organization_id, project_id, comparison_id, recipient_user_id, recipient_email, classification, severity)
         SELECT $1, $2, $3, member.user_id, recipient.email, $4, $5
         FROM organization_memberships member
         JOIN "user" recipient ON recipient.id = member.user_id
         WHERE member.organization_id = $1 AND member.role IN ('owner', 'admin', 'editor') AND recipient."emailVerified" = true
         ON CONFLICT (comparison_id, recipient_user_id) DO NOTHING`,
        [organizationId, first.projectId, comparisonId, report.classification, report.severity],
      );
    }
  }
}

export class SchedulingError extends Error {
  public constructor(public readonly code: 'idempotency_key_reused' | 'invalid_request' | 'not_found' | 'unschedulable_agent') {
    super(code);
    this.name = 'SchedulingError';
  }
}

export interface CreateComparisonBatchInput {
  readonly baselineAgentVersionId: string;
  readonly candidateAgentVersionId: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly repetitionCount: number;
  readonly scenarioVersionIds: readonly string[];
  readonly userId: string;
}

export interface ComparisonBatch {
  readonly id: string;
  readonly runCount: number;
  readonly status: 'queued' | 'running' | 'completed';
}

interface VersionRow {
  readonly id: string;
  readonly adapterType: 'reference' | 'registered-http';
  readonly contentHash: string;
}

function fingerprint(input: CreateComparisonBatchInput): string {
  return createHash('sha256').update(JSON.stringify({
    baselineAgentVersionId: input.baselineAgentVersionId,
    candidateAgentVersionId: input.candidateAgentVersionId,
    projectId: input.projectId,
    repetitionCount: input.repetitionCount,
    scenarioVersionIds: [...input.scenarioVersionIds].sort(),
  })).digest('hex');
}

function endpointKey(version: VersionRow): string {
  return createHash('sha256').update(version.contentHash).digest('hex');
}

export async function createComparisonBatch(pool: Pool, input: CreateComparisonBatchInput): Promise<ComparisonBatch> {
  if (!Number.isInteger(input.repetitionCount) || input.repetitionCount < 1 || input.repetitionCount > 20 || input.scenarioVersionIds.length === 0 || new Set(input.scenarioVersionIds).size !== input.scenarioVersionIds.length || input.baselineAgentVersionId === input.candidateAgentVersionId) {
    throw new SchedulingError('invalid_request');
  }
  const requestFingerprint = fingerprint(input);

  return withOrganizationTransaction(pool, input.organizationId, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.organizationId}:${input.projectId}:${input.idempotencyKey}`]);
    const existing = await client.query<Readonly<{ id: string; requestFingerprint: string; status: ComparisonBatch['status']; runCount: number }>>(
      `SELECT id, request_fingerprint AS "requestFingerprint", status,
        (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id) AS "runCount"
       FROM comparison_batches WHERE project_id = $1 AND idempotency_key = $2`,
      [input.projectId, input.idempotencyKey],
    );
    const existingBatch = existing.rows[0];
    if (existingBatch !== undefined) {
      if (existingBatch.requestFingerprint !== requestFingerprint) throw new SchedulingError('idempotency_key_reused');
      return { id: existingBatch.id, status: existingBatch.status, runCount: existingBatch.runCount };
    }

    if ((await client.query('SELECT 1 FROM projects WHERE id = $1', [input.projectId])).rowCount !== 1) throw new SchedulingError('not_found');
    const versions = await client.query<VersionRow>(
      `SELECT id, adapter_type AS "adapterType", content_hash AS "contentHash"
       FROM agent_versions WHERE project_id = $1 AND id = ANY($2::uuid[])`,
      [input.projectId, [input.baselineAgentVersionId, input.candidateAgentVersionId]],
    );
    if (versions.rows.length !== 2) throw new SchedulingError('not_found');
    if (versions.rows.some((version) => version.adapterType !== 'reference')) throw new SchedulingError('unschedulable_agent');
    const scenarios = await client.query<Readonly<{ id: string; contentHash: string }>>(
      'SELECT id, content_hash AS "contentHash" FROM scenario_versions WHERE project_id = $1 AND id = ANY($2::uuid[])',
      [input.projectId, input.scenarioVersionIds],
    );
    if (scenarios.rows.length !== input.scenarioVersionIds.length) throw new SchedulingError('not_found');

    const scenarioSetHash = createHash('sha256').update(JSON.stringify([...scenarios.rows].map((scenario) => scenario.contentHash).sort())).digest('hex');
    const batch = await client.query<Readonly<{ id: string }>>(
      `INSERT INTO comparison_batches (organization_id, project_id, baseline_agent_version_id, candidate_agent_version_id, scenario_set_hash, config_snapshot, repetition_count, idempotency_key, request_fingerprint, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10) RETURNING id`,
      [input.organizationId, input.projectId, input.baselineAgentVersionId, input.candidateAgentVersionId, scenarioSetHash, { scenarioVersionIds: input.scenarioVersionIds, repetitionCount: input.repetitionCount }, input.repetitionCount, input.idempotencyKey, requestFingerprint, input.userId],
    );
    const batchId = batch.rows[0]?.id;
    if (batchId === undefined) throw new Error('Batch insert did not return an ID');
    const byId = new Map(versions.rows.map((version) => [version.id, version]));
    const runInputs = [
      { side: 'baseline' as const, versionId: input.baselineAgentVersionId },
      { side: 'candidate' as const, versionId: input.candidateAgentVersionId },
    ];
    let runCount = 0;
    for (const scenario of input.scenarioVersionIds) {
      for (let repetition = 1; repetition <= input.repetitionCount; repetition += 1) {
        for (const runInput of runInputs) {
          const version = byId.get(runInput.versionId);
          if (version === undefined) throw new Error('Validated agent version disappeared');
          const run = await client.query<Readonly<{ id: string }>>(
            `INSERT INTO agent_runs (organization_id, project_id, batch_id, scenario_version_id, agent_version_id, side, repetition, endpoint_key, status, retry_safe)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', true) RETURNING id`,
            [input.organizationId, input.projectId, batchId, scenario, runInput.versionId, runInput.side, repetition, endpointKey(version)],
          );
          const runId = run.rows[0]?.id;
          if (runId === undefined) throw new Error('Run insert did not return an ID');
          await client.query("INSERT INTO agent_run_dispatches (organization_id, project_id, run_id, status) VALUES ($1, $2, $3, 'ready')", [input.organizationId, input.projectId, runId]);
          runCount += 1;
        }
      }
    }
    return { id: batchId, status: 'queued', runCount };
  });
}

export interface WorkerClaimInput {
  readonly dispatchId: string;
  readonly organizationId: string;
  readonly organizationLimit: number;
  readonly endpointLimit: number;
  readonly runId: string;
}

export interface ClaimedRun {
  readonly leaseToken: string;
  readonly runId: string;
  readonly side: 'baseline' | 'candidate';
}

export async function claimRun(pool: Pool, input: WorkerClaimInput): Promise<ClaimedRun | undefined> {
  return withOrganizationTransaction(pool, input.organizationId, async (client) => {
    const dispatched = await client.query<Readonly<{ endpointKey: string; side: 'baseline' | 'candidate'; status: string }>>(
      `SELECT run.endpoint_key AS "endpointKey", run.side, run.status FROM agent_run_dispatches dispatch
       JOIN agent_runs run ON run.id = dispatch.run_id
       WHERE dispatch.id = $1 AND dispatch.run_id = $2 FOR UPDATE`, [input.dispatchId, input.runId],
    );
    const run = dispatched.rows[0];
    if (run === undefined || run.status !== 'queued' || input.organizationLimit < 1 || input.endpointLimit < 1) return undefined;
    // Serialize the read-then-claim capacity check across all workers for this organization and endpoint.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.organizationId]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.organizationId}:${run.endpointKey}`]);
    const active = await client.query<Readonly<{ organizationCount: number; endpointCount: number }>>(
      `SELECT count(*) FILTER (WHERE true)::integer AS "organizationCount", count(*) FILTER (WHERE endpoint_key = $2)::integer AS "endpointCount"
       FROM agent_runs WHERE organization_id = $1 AND status = 'running' AND lease_expires_at > now()`, [input.organizationId, run.endpointKey],
    );
    const counts = active.rows[0];
    if (counts === undefined || counts.organizationCount >= input.organizationLimit || counts.endpointCount >= input.endpointLimit) return undefined;
    const leaseToken = randomUUID();
    const claimed = await client.query(
      `UPDATE agent_runs SET status = 'running', lease_token = $2, lease_expires_at = now() + interval '60 seconds', attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1 AND status = 'queued' AND available_at <= now() RETURNING batch_id`, [input.runId, leaseToken],
    );
    if (claimed.rowCount !== 1) return undefined;
    await client.query("UPDATE agent_run_dispatches SET status = 'handled', handled_at = now() WHERE id = $1 AND status IN ('ready', 'published')", [input.dispatchId]);
    const stage: ProgressStage = run.side === 'baseline' ? 'running_baseline' : 'running_candidate';
    await client.query("UPDATE comparison_batches SET status = 'running', progress_stage = $2, started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'queued'", [claimed.rows[0]!.batch_id, stage]);
    await client.query('UPDATE agent_runs SET progress_stage = $2 WHERE id = $1', [input.runId, stage]);
    await client.query('INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, run_id, stage) SELECT organization_id, project_id, batch_id, id, $2 FROM agent_runs WHERE id = $1', [input.runId, stage]);
    return { runId: input.runId, leaseToken, side: run.side };
  });
}

export async function finishRun(pool: Pool, organizationId: string, runId: string, leaseToken: string, status: TerminalRunStatus): Promise<boolean> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const completed = await client.query<Readonly<{ batchId: string }>>(
      `UPDATE agent_runs SET status = $3, progress_stage = CASE WHEN $3 = 'succeeded' THEN 'complete' ELSE 'failed' END, lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'running' RETURNING batch_id AS "batchId"`, [runId, leaseToken, status],
    );
    const batchId = completed.rows[0]?.batchId;
    if (batchId === undefined) return false;
    await client.query('INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, run_id, stage) SELECT organization_id, project_id, batch_id, id, CASE WHEN $2 = \'succeeded\' THEN \'complete\' ELSE \'failed\' END FROM agent_runs WHERE id = $1', [runId, status]);
    await client.query(
      `UPDATE comparison_batches SET status = 'completed', progress_stage = CASE WHEN EXISTS (SELECT 1 FROM agent_runs WHERE batch_id = $1 AND status <> 'succeeded') THEN 'failed' ELSE 'complete' END, completed_at = now()
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE batch_id = $1 AND status NOT IN ('succeeded', 'agent_failed', 'infrastructure_failed', 'timed_out'))`, [batchId],
    );
    return true;
  });
}

export async function setRunProgress(pool: Pool, organizationId: string, runId: string, leaseToken: string, stage: Extract<ProgressStage, 'preparing_fixture' | 'running_baseline' | 'running_candidate'>): Promise<boolean> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const updated = await client.query<Readonly<{ batchId: string; projectId: string }>>(
      `UPDATE agent_runs SET progress_stage = $3, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
       RETURNING batch_id AS "batchId", project_id AS "projectId"`, [runId, leaseToken, stage],
    );
    const run = updated.rows[0];
    if (run === undefined) return false;
    await client.query('UPDATE comparison_batches SET progress_stage = $2 WHERE id = $1 AND status = \'running\'', [run.batchId, stage]);
    await client.query('INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, run_id, stage) VALUES ($1, $2, $3, $4, $5)', [organizationId, run.projectId, run.batchId, runId, stage]);
    return true;
  });
}

export async function completeRunWithArtifacts(pool: Pool, organizationId: string, runId: string, leaseToken: string, artifacts: readonly RunArtifactLineage[], metrics: SafeRunMetrics, outcome: Readonly<{ finalState: Readonly<Record<string, unknown>>; policyFailures: readonly string[] }>): Promise<boolean> {
  if (artifacts.length !== 3 || new Set(artifacts.map((artifact) => artifact.kind)).size !== 3) throw new SchedulingError('invalid_request');
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const run = await client.query<Readonly<{ batchId: string; projectId: string }>>('SELECT batch_id AS "batchId", project_id AS "projectId" FROM agent_runs WHERE id = $1 AND lease_token = $2 AND status = \'running\' FOR UPDATE', [runId, leaseToken]);
    const row = run.rows[0];
    if (row === undefined) return false;
    for (const artifact of artifacts) {
      await client.query(
        `INSERT INTO agent_run_artifacts (organization_id, project_id, batch_id, run_id, kind, storage_ref, content_hash, schema_version, classification, retention_deadline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now() + interval '90 days'))`,
        [organizationId, row.projectId, row.batchId, runId, artifact.kind, artifact.storageRef, artifact.contentHash, artifact.schemaVersion, artifact.classification, artifact.retentionDeadline ?? null],
      );
    }
    await client.query(
      `INSERT INTO agent_run_outcomes (run_id, organization_id, project_id, final_state, policy_failures)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, organizationId, row.projectId, JSON.stringify(outcome.finalState), JSON.stringify(outcome.policyFailures)],
    );
    await client.query(
      `UPDATE agent_runs SET status = 'succeeded', progress_stage = 'complete', event_count = $3, tool_call_count = $4, duration_ms = $5, token_usage = $6, cost_usd = $7, lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND lease_token = $2`,
      [runId, leaseToken, metrics.eventCount, metrics.toolCallCount, metrics.durationMs, metrics.tokenUsage, metrics.costUsd],
    );
    await client.query("INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, run_id, stage) VALUES ($1, $2, $3, $4, 'complete')", [organizationId, row.projectId, row.batchId, runId]);
    await client.query(`UPDATE comparison_batches SET status = 'completed', progress_stage = CASE WHEN EXISTS (SELECT 1 FROM agent_runs WHERE batch_id = $1 AND status <> 'succeeded') THEN 'failed' ELSE 'complete' END, completed_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE batch_id = $1 AND status NOT IN ('succeeded', 'agent_failed', 'infrastructure_failed', 'timed_out'))`, [row.batchId]);
    await finalizeBatchReports(client, organizationId, row.batchId);
    return true;
  });
}

export async function claimExpiredArtifacts(pool: Pool, organizationId: string, now: Date, limit: number): Promise<readonly ExpiredArtifactClaim[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SchedulingError('invalid_request');
  const claimToken = randomUUID();
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const result = await client.query<ExpiredArtifactClaim>(
      `WITH expired AS (
         SELECT id FROM agent_run_artifacts
         WHERE retention_deadline <= $1
           AND deleted_at IS NULL
           AND (retention_claim_expires_at IS NULL OR retention_claim_expires_at <= $1)
         ORDER BY retention_deadline, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE agent_run_artifacts artifact
       SET retention_claim_token = $3, retention_claim_expires_at = $1 + interval '5 minutes'
       FROM expired
       WHERE artifact.id = expired.id
       RETURNING artifact.id, artifact.project_id AS "projectId", artifact.batch_id AS "batchId", artifact.run_id AS "runId", artifact.kind, artifact.content_hash AS "contentHash", artifact.retention_deadline AS "retentionDeadline", artifact.retention_claim_token AS "claimToken"`,
      [now, limit, claimToken],
    );
    return result.rows;
  });
}

export async function markExpiredArtifactDeleted(pool: Pool, organizationId: string, artifactId: string, claimToken: string): Promise<boolean> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const result = await client.query(
      `UPDATE agent_run_artifacts
       SET deleted_at = now(), retention_claim_token = NULL, retention_claim_expires_at = NULL
       WHERE id = $1 AND retention_claim_token = $2 AND deleted_at IS NULL`,
      [artifactId, claimToken],
    );
    return result.rowCount === 1;
  });
}

export async function recoverExpiredRuns(pool: Pool, organizationId: string): Promise<number> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const expired = await client.query<Readonly<{ batchId: string; id: string; projectId: string; retrySafe: boolean; attemptCount: number; maxAttempts: number }>>(
      `SELECT id, batch_id AS "batchId", project_id AS "projectId", retry_safe AS "retrySafe", attempt_count AS "attemptCount", max_attempts AS "maxAttempts"
       FROM agent_runs WHERE status = 'running' AND lease_expires_at <= now() FOR UPDATE SKIP LOCKED`,
    );
    for (const run of expired.rows) {
      if (run.retrySafe && run.attemptCount < run.maxAttempts) {
        await client.query("UPDATE agent_runs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, available_at = now(), updated_at = now() WHERE id = $1", [run.id]);
        await client.query("UPDATE agent_run_dispatches SET status = 'ready', available_at = now(), published_at = NULL, handled_at = NULL WHERE run_id = $1", [run.id]);
        await client.query("UPDATE agent_runs SET progress_stage = 'queued' WHERE id = $1", [run.id]);
        await client.query("INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, run_id, stage) VALUES ($1, $2, $3, $4, 'queued')", [organizationId, run.projectId, run.batchId, run.id]);
      } else {
        await client.query("UPDATE agent_runs SET status = 'infrastructure_failed', progress_stage = 'failed', failure_code = 'lease_expired', lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now() WHERE id = $1", [run.id]);
        await client.query("INSERT INTO comparison_batch_progress (organization_id, project_id, batch_id, run_id, stage) VALUES ($1, $2, $3, $4, 'failed')", [organizationId, run.projectId, run.batchId, run.id]);
        await client.query(`UPDATE comparison_batches SET status = 'completed', progress_stage = 'failed', completed_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE batch_id = $1 AND status NOT IN ('succeeded', 'agent_failed', 'infrastructure_failed', 'timed_out'))`, [run.batchId]);
      }
    }
    return expired.rowCount ?? 0;
  });
}

export async function readyDispatches(pool: Pool, organizationId: string, batchId: string): Promise<readonly { readonly dispatchId: string; readonly organizationId: string; readonly runId: string }[]> {
  return withOrganizationTransaction(pool, organizationId, async (client) => (await client.query<Readonly<{ dispatchId: string; organizationId: string; runId: string }>>(
    "SELECT id AS \"dispatchId\", organization_id AS \"organizationId\", run_id AS \"runId\" FROM agent_run_dispatches WHERE status = 'ready' AND run_id IN (SELECT id FROM agent_runs WHERE batch_id = $1) ORDER BY created_at",
    [batchId],
  )).rows);
}

export async function markDispatchPublished(pool: Pool, organizationId: string, dispatchId: string): Promise<void> {
  await withOrganizationTransaction(pool, organizationId, async (client) => {
    await client.query("UPDATE agent_run_dispatches SET status = 'published', published_at = now() WHERE id = $1 AND status = 'ready'", [dispatchId]);
  });
}

export async function readyOrganizationDispatches(pool: Pool, organizationId: string): Promise<readonly { readonly dispatchId: string; readonly organizationId: string; readonly runId: string }[]> {
  return withOrganizationTransaction(pool, organizationId, async (client) => (await client.query<Readonly<{ dispatchId: string; organizationId: string; runId: string }>>(
    "SELECT id AS \"dispatchId\", organization_id AS \"organizationId\", run_id AS \"runId\" FROM agent_run_dispatches WHERE status = 'ready' AND available_at <= now() ORDER BY created_at LIMIT 100",
  )).rows);
}
