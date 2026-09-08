import { createLogger, loadRuntimeConfig, startTelemetry } from '@varytra/runtime';
import { createDatabasePool } from '@varytra/infrastructure';
import { Queue } from 'bullmq';
import type { RunDispatch } from '@varytra/schemas';
import { createAuth, loadAuthConfig } from './auth.js';
import { createSmtpOtpSender, loadSmtpConfig } from './email.js';

const config = loadRuntimeConfig(process.env);
const authConfig = loadAuthConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const telemetry = startTelemetry(config);
const auth = createAuth(authConfig, createSmtpOtpSender(loadSmtpConfig(process.env)));
const database = createDatabasePool({ connectionString: authConfig.databaseUrl });
const redisUrl = process.env.REDIS_URL;
const redis = redisUrl === undefined ? undefined : new URL(redisUrl);
const runQueue = redis === undefined ? undefined : new Queue<RunDispatch>('varytra-agent-runs', { connection: { host: redis.hostname, port: Number(redis.port || '6379'), password: redis.password || undefined } });
const { buildApp } = await import('./app.js');
const app = buildApp({ auth, database, logger, ...(runQueue === undefined ? {} : { dispatchPublisher: { publish: async (dispatch: RunDispatch) => { await runQueue.add('agent-run', dispatch, { jobId: `dispatch-${dispatch.dispatchId}`, attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 1_000 }); } } }) });

await app.listen({ host: config.host, port: config.port });
logger.info('api.started', { host: config.host, port: config.port });

async function shutdown(signal: string): Promise<void> {
  logger.info('api.stopping', { signal });
  await app.close();
  await runQueue?.close();
  await database.end();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
