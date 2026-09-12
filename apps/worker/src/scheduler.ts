import { Queue, Worker } from 'bullmq';
import { createDatabasePool, withOrganizationTransaction, type ArtifactStorage } from '@varytra/infrastructure';
import { claimReviewNotification, markReviewNotificationDelivered, retryReviewNotification, type ReviewNotification } from '@varytra/infrastructure/review-notifications';
import { claimExpiredArtifacts, claimRun, completeRunWithArtifacts, finishRun, markExpiredArtifactDeleted, readyOrganizationDispatches, recoverExpiredRuns, setRunProgress, type ClaimedRun, type SafeRunMetrics } from '@varytra/infrastructure/scheduling';
import { ReferenceEnvironment } from '@varytra/reference-environment';
import { normalizeTrace } from '@varytra/normalization';
import { runDispatchSchema, type RunDispatch } from '@varytra/schemas';

const queueName = 'varytra-agent-runs';

export interface SchedulerWorker {
  readonly close: () => Promise<void>;
  readonly enqueue: (dispatch: RunDispatch) => Promise<void>;
}

export interface CompletedExecution {
  readonly finalState: Readonly<Record<string, unknown>>;
  readonly metrics: SafeRunMetrics;
  readonly normalizedTrace: Uint8Array;
  readonly policyFailures: readonly string[];
  readonly rawTrace: Uint8Array;
  readonly redactedTrace: Uint8Array;
}

export type RunExecutor = (input: Readonly<{ runId: string; side: 'baseline' | 'candidate' }>) => Promise<CompletedExecution>;

export interface ReviewNotificationSender {
  readonly send: (notification: ReviewNotification) => Promise<void>;
}

export async function deliverReviewNotification(
  database: ReturnType<typeof createDatabasePool>,
  organizationId: string,
  sender: ReviewNotificationSender,
): Promise<void> {
  const notification = await claimReviewNotification(database, organizationId);
  if (notification === undefined) return;
  try {
    await sender.send(notification);
    await markReviewNotificationDelivered(database, organizationId, notification.id);
  } catch {
    // SMTP errors are retried from the durable outbox; the provider error can contain customer data.
    await retryReviewNotification(database, organizationId, notification.id);
  }
}

function serializeLines(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export const executeReferenceRun: RunExecutor = async ({ side }) => {
  const environment = new ReferenceEnvironment();
  environment.reset();
  const execution = environment.execute(side === 'baseline' ? 'baseline' : 'harmless-candidate');
  const trace = execution.trace;
  const normalized = normalizeTrace(trace);
  return {
    rawTrace: serializeLines(execution.rawTrace),
    redactedTrace: serializeLines(trace),
    normalizedTrace: serializeLines(normalized),
    finalState: { ...execution.finalState },
    policyFailures: execution.policyFailures,
    metrics: {
      eventCount: trace.length,
      toolCallCount: trace.filter((event) => event.eventType === 'tool_call').length,
      durationMs: trace.reduce((total, event) => total + (event.latencyMs ?? 0), 0),
      tokenUsage: trace.reduce((total, event) => total + (event.tokenUsage ?? 0), 0),
      costUsd: trace.reduce((total, event) => total + (event.costUsd ?? 0), 0),
    },
  };
};

async function persistExecution(
  database: ReturnType<typeof createDatabasePool>,
  artifactStorage: ArtifactStorage,
  organizationId: string,
  claimed: ClaimedRun,
  execution: CompletedExecution,
): Promise<boolean> {
  const owner = await withOrganizationTransaction(database, organizationId, async (client) => {
    const result = await client.query<Readonly<{ batchId: string; projectId: string; retentionDays: number }>>('SELECT run.batch_id AS "batchId", run.project_id AS "projectId", project.retention_days AS "retentionDays" FROM agent_runs run JOIN projects project ON project.id = run.project_id AND project.organization_id = run.organization_id WHERE run.id = $1 AND run.lease_token = $2 AND run.status = \'running\'', [claimed.runId, claimed.leaseToken]);
    return result.rows[0];
  });
  if (owner === undefined) return false;
  const retentionDeadline = new Date(Date.now() + owner.retentionDays * 24 * 60 * 60 * 1_000);
  const artifactOwner = { organizationId, projectId: owner.projectId, batchId: owner.batchId, runId: claimed.runId };
  const [raw, redacted, normalized] = await Promise.all([
    artifactStorage.write({ owner: artifactOwner, kind: 'raw-trace', content: execution.rawTrace, schemaVersion: '1.0', classification: 'restricted', retentionDeadline, creatorId: 'worker' }),
    artifactStorage.write({ owner: artifactOwner, kind: 'redacted-trace', content: execution.redactedTrace, schemaVersion: '1.0', classification: 'sensitive', retentionDeadline, creatorId: 'worker' }),
    artifactStorage.write({ owner: artifactOwner, kind: 'normalized-trace', content: execution.normalizedTrace, schemaVersion: '1.0', classification: 'internal', retentionDeadline, creatorId: 'worker' }),
  ]);
  return completeRunWithArtifacts(database, organizationId, claimed.runId, claimed.leaseToken, [
    { kind: 'raw-trace', storageRef: raw.key, contentHash: raw.contentHash, schemaVersion: '1.0', classification: 'restricted', retentionDeadline },
    { kind: 'redacted-trace', storageRef: redacted.key, contentHash: redacted.contentHash, schemaVersion: '1.0', classification: 'sensitive', retentionDeadline },
    { kind: 'normalized-trace', storageRef: normalized.key, contentHash: normalized.contentHash, schemaVersion: '1.0', classification: 'internal', retentionDeadline },
  ], execution.metrics, { finalState: execution.finalState, policyFailures: execution.policyFailures });
}

export async function cleanupExpiredArtifacts(database: ReturnType<typeof createDatabasePool>, artifactStorage: ArtifactStorage, organizationId: string, now = new Date()): Promise<number> {
  const claims = await claimExpiredArtifacts(database, organizationId, now, 25);
  for (const claim of claims) {
    await artifactStorage.deleteExpired({
      owner: { organizationId, projectId: claim.projectId, batchId: claim.batchId, runId: claim.runId },
      kind: claim.kind,
      contentHash: claim.contentHash,
    }, now, claim.retentionDeadline);
    await markExpiredArtifactDeleted(database, organizationId, claim.id, claim.claimToken);
  }
  return claims.length;
}

export async function executeClaimedRun(
  database: ReturnType<typeof createDatabasePool>,
  artifactStorage: ArtifactStorage | undefined,
  organizationId: string,
  claimed: ClaimedRun,
  executeRun: RunExecutor = executeReferenceRun,
): Promise<void> {
  try {
    if (artifactStorage === undefined) throw new Error('Artifact storage is not configured');
    await setRunProgress(database, organizationId, claimed.runId, claimed.leaseToken, 'preparing_fixture');
    const execution = await executeRun({ runId: claimed.runId, side: claimed.side });
    await setRunProgress(database, organizationId, claimed.runId, claimed.leaseToken, claimed.side === 'baseline' ? 'running_baseline' : 'running_candidate');
    await persistExecution(database, artifactStorage, organizationId, claimed, execution);
  } catch {
    await finishRun(database, organizationId, claimed.runId, claimed.leaseToken, 'infrastructure_failed');
  }
}

export function startSchedulerWorker(input: Readonly<{
  databaseUrl: string;
  endpointLimit: number;
  artifactStorage?: ArtifactStorage;
  executeRun?: RunExecutor;
  organizationIds?: readonly string[];
  organizationLimit: number;
  redisUrl: string;
  reviewNotificationSender?: ReviewNotificationSender;
}>): SchedulerWorker {
  const redis = new URL(input.redisUrl);
  const connection = { host: redis.hostname, port: Number(redis.port || '6379'), password: redis.password || undefined, maxRetriesPerRequest: null as null };
  const database = createDatabasePool({ connectionString: input.databaseUrl });
  const queue = new Queue<RunDispatch>(queueName, { connection });
  const organizations = new Set(input.organizationIds ?? []);
  const reconcileOrganization = async (organizationId: string): Promise<void> => {
    await recoverExpiredRuns(database, organizationId);
    if (input.artifactStorage !== undefined) await cleanupExpiredArtifacts(database, input.artifactStorage, organizationId);
    const dispatches = await readyOrganizationDispatches(database, organizationId);
    for (const dispatch of dispatches) await queue.add('agent-run', dispatch, { jobId: `dispatch-${dispatch.dispatchId}`, attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 });
    if (input.reviewNotificationSender !== undefined) await deliverReviewNotification(database, organizationId, input.reviewNotificationSender);
  };
  const reconciliationTimer = setInterval(() => { for (const organizationId of organizations) void reconcileOrganization(organizationId); }, 15_000);
  const worker = new Worker<RunDispatch>(queueName, async (job) => {
    const dispatch = runDispatchSchema.parse(job.data);
    organizations.add(dispatch.organizationId);
    const claimed = await claimRun(database, { ...dispatch, endpointLimit: input.endpointLimit, organizationLimit: input.organizationLimit });
    if (claimed === undefined) return;
    await executeClaimedRun(database, input.artifactStorage, dispatch.organizationId, claimed, input.executeRun);
    await reconcileOrganization(dispatch.organizationId);
  }, { connection, concurrency: input.organizationLimit });
  return {
    enqueue: async (dispatch) => {
      runDispatchSchema.parse(dispatch);
      await queue.add('agent-run', dispatch, { jobId: `dispatch-${dispatch.dispatchId}`, attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 });
    },
    close: async () => { clearInterval(reconciliationTimer); await worker.close(); await queue.close(); await database.end(); },
  };
}
