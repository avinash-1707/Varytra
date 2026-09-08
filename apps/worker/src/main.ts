import { createLogger, loadRuntimeConfig, startTelemetry } from '@varytra/runtime';
import { processNoopJob } from './noop-job.js';
import { startSchedulerWorker } from './scheduler.js';

const config = loadRuntimeConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const telemetry = startTelemetry(config);
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (databaseUrl === undefined || redisUrl === undefined) {
  const result = await processNoopJob();
  logger.info('worker.noop_job.completed', { status: result.status });
  await telemetry.shutdown();
} else {
  const scheduler = startSchedulerWorker({ databaseUrl, redisUrl, organizationIds: (process.env.VARYTRA_WORKER_ORGANIZATION_IDS ?? '').split(',').filter((id) => id.length > 0), organizationLimit: 4, endpointLimit: 2 });
  const shutdown = async () => { await scheduler.close(); await telemetry.shutdown(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
