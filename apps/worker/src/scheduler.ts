import { Queue, Worker } from 'bullmq';
import { createDatabasePool, withOrganizationTransaction, type ArtifactStorage } from '@varytra/infrastructure';
import { claimRun, completeRunWithArtifacts, finishRun, readyOrganizationDispatches, recoverExpiredRuns, setRunProgress, type ClaimedRun, type SafeRunMetrics } from '@varytra/infrastructure/scheduling';
import { ReferenceEnvironment } from '@varytra/reference-environment';
import { normalizeTrace } from '@varytra/normalization';
import { runDispatchSchema, type RunDispatch } from '@varytra/schemas';

const queueName = 'varytra-agent-runs';

export interface SchedulerWorker {
  readonly close: () => Promise<void>;
  readonly enqueue: (dispatch: RunDispatch) => Promise<void>;
}

export interface CompletedExecution {
  readonly metrics: SafeRunMetrics;
  readonly normalizedTrace: Uint8Array;
  readonly rawTrace: Uint8Array;
  readonly redactedTrace: Uint8Array;
}

export type RunExecutor = (input: Readonly<{ runId: string; side: 'baseline' | 'candidate' }>) => Promise<CompletedExecution>;

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
    const result = await client.query<Readonly<{ batchId: string; projectId: string }>>('SELECT batch_id AS "batchId", project_id AS "projectId" FROM agent_runs WHERE id = $1 AND lease_token = $2 AND status = \'running\'', [claimed.runId, claimed.leaseToken]);
    return result.rows[0];
  });
  if (owner === undefined) return false;
  const retentionDeadline = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000);
  const artifactOwner = { organizationId, projectId: owner.projectId, batchId: owner.batchId, runId: claimed.runId };
  const [raw, redacted, normalized] = await Promise.all([
    artifactStorage.write({ owner: artifactOwner, kind: 'raw-trace', content: execution.rawTrace, schemaVersion: '1.0', classification: 'restricted', retentionDeadline, creatorId: 'worker' }),
    artifactStorage.write({ owner: artifactOwner, kind: 'redacted-trace', content: execution.redactedTrace, schemaVersion: '1.0', classification: 'sensitive', retentionDeadline, creatorId: 'worker' }),
    artifactStorage.write({ owner: artifactOwner, kind: 'normalized-trace', content: execution.normalizedTrace, schemaVersion: '1.0', classification: 'internal', retentionDeadline, creatorId: 'worker' }),
  ]);
  return completeRunWithArtifacts(database, organizationId, claimed.runId, claimed.leaseToken, [
    { kind: 'raw-trace', storageRef: raw.key, contentHash: raw.contentHash, schemaVersion: '1.0', classification: 'restricted' },
    { kind: 'redacted-trace', storageRef: redacted.key, contentHash: redacted.contentHash, schemaVersion: '1.0', classification: 'sensitive' },
    { kind: 'normalized-trace', storageRef: normalized.key, contentHash: normalized.contentHash, schemaVersion: '1.0', classification: 'internal' },
  ], execution.metrics);
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
}>): SchedulerWorker {
  const redis = new URL(input.redisUrl);
  const connection = { host: redis.hostname, port: Number(redis.port || '6379'), password: redis.password || undefined, maxRetriesPerRequest: null as null };
  const database = createDatabasePool({ connectionString: input.databaseUrl });
  const queue = new Queue<RunDispatch>(queueName, { connection });
  const organizations = new Set(input.organizationIds ?? []);
  const reconcileOrganization = async (organizationId: string): Promise<void> => {
    await recoverExpiredRuns(database, organizationId);
    const dispatches = await readyOrganizationDispatches(database, organizationId);
    for (const dispatch of dispatches) await queue.add('agent-run', dispatch, { jobId: `dispatch-${dispatch.dispatchId}`, attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 });
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
