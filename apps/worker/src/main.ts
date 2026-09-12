import { createLogger, loadRuntimeConfig, startTelemetry } from '@varytra/runtime';
import { createCloudinaryArtifactStorage, createDatabasePool, PostgresArtifactTombstoneStore, withOrganizationTransaction } from '@varytra/infrastructure';
import { processNoopJob } from './noop-job.js';
import { createSmtpReviewNotificationSender } from './review-notifications.js';
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
  const artifactDatabase = createDatabasePool({ connectionString: databaseUrl });
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const artifactStorage = cloudName === undefined || apiKey === undefined || apiSecret === undefined ? undefined : createCloudinaryArtifactStorage(
    { cloudName, apiKey, apiSecret },
    {
      exists: (organizationId, objectKey) => withOrganizationTransaction(artifactDatabase, organizationId, (client) => new PostgresArtifactTombstoneStore(client).exists(organizationId, objectKey)),
      create: (tombstone) => withOrganizationTransaction(artifactDatabase, tombstone.organizationId, (client) => new PostgresArtifactTombstoneStore(client).create(tombstone)),
    },
  );
  const reviewNotificationSender = createSmtpReviewNotificationSender(process.env);
  const scheduler = startSchedulerWorker({ databaseUrl, redisUrl, ...(artifactStorage === undefined ? {} : { artifactStorage }), ...(reviewNotificationSender === undefined ? {} : { reviewNotificationSender }), organizationIds: (process.env.VARYTRA_WORKER_ORGANIZATION_IDS ?? '').split(',').filter((id) => id.length > 0), organizationLimit: 4, endpointLimit: 2 });
  const shutdown = async () => { await scheduler.close(); await artifactDatabase.end(); await telemetry.shutdown(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
