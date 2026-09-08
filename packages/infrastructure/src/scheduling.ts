import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withOrganizationTransaction } from './index.js';

type TerminalRunStatus = 'succeeded' | 'agent_failed' | 'infrastructure_failed' | 'timed_out';

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
}

export async function claimRun(pool: Pool, input: WorkerClaimInput): Promise<ClaimedRun | undefined> {
  return withOrganizationTransaction(pool, input.organizationId, async (client) => {
    const dispatched = await client.query<Readonly<{ endpointKey: string; status: string }>>(
      `SELECT run.endpoint_key AS "endpointKey", run.status FROM agent_run_dispatches dispatch
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
    await client.query("UPDATE comparison_batches SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'queued'", [claimed.rows[0]!.batch_id]);
    return { runId: input.runId, leaseToken };
  });
}

export async function finishRun(pool: Pool, organizationId: string, runId: string, leaseToken: string, status: TerminalRunStatus): Promise<boolean> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const completed = await client.query<Readonly<{ batchId: string }>>(
      `UPDATE agent_runs SET status = $3, lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'running' RETURNING batch_id AS "batchId"`, [runId, leaseToken, status],
    );
    const batchId = completed.rows[0]?.batchId;
    if (batchId === undefined) return false;
    await client.query(
      `UPDATE comparison_batches SET status = 'completed', completed_at = now()
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE batch_id = $1 AND status NOT IN ('succeeded', 'agent_failed', 'infrastructure_failed', 'timed_out'))`, [batchId],
    );
    return true;
  });
}

export async function recoverExpiredRuns(pool: Pool, organizationId: string): Promise<number> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    const expired = await client.query<Readonly<{ id: string; projectId: string; retrySafe: boolean; attemptCount: number; maxAttempts: number }>>(
      `SELECT id, project_id AS "projectId", retry_safe AS "retrySafe", attempt_count AS "attemptCount", max_attempts AS "maxAttempts"
       FROM agent_runs WHERE status = 'running' AND lease_expires_at <= now() FOR UPDATE SKIP LOCKED`,
    );
    for (const run of expired.rows) {
      if (run.retrySafe && run.attemptCount < run.maxAttempts) {
        await client.query("UPDATE agent_runs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, available_at = now(), updated_at = now() WHERE id = $1", [run.id]);
        await client.query("UPDATE agent_run_dispatches SET status = 'ready', available_at = now(), published_at = NULL, handled_at = NULL WHERE run_id = $1", [run.id]);
      } else {
        await client.query("UPDATE agent_runs SET status = 'infrastructure_failed', failure_code = 'lease_expired', lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now() WHERE id = $1", [run.id]);
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
