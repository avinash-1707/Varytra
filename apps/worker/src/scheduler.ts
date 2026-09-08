import { Queue, Worker } from 'bullmq';
import { createDatabasePool } from '@varytra/infrastructure';
import { claimRun, finishRun, readyOrganizationDispatches, recoverExpiredRuns } from '@varytra/infrastructure/scheduling';
import { runDispatchSchema, type RunDispatch } from '@varytra/schemas';

const queueName = 'varytra-agent-runs';

export interface SchedulerWorker {
  readonly close: () => Promise<void>;
  readonly enqueue: (dispatch: RunDispatch) => Promise<void>;
}

export function startSchedulerWorker(input: Readonly<{
  databaseUrl: string;
  endpointLimit: number;
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
    await finishRun(database, dispatch.organizationId, claimed.runId, claimed.leaseToken, 'succeeded');
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
