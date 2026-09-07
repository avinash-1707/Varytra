import { createLogger, loadRuntimeConfig, startTelemetry } from '@varytra/runtime';
import { createDatabasePool } from '@varytra/infrastructure';
import { createAuth, loadAuthConfig } from './auth.js';
import { createSmtpOtpSender, loadSmtpConfig } from './email.js';

const config = loadRuntimeConfig(process.env);
const authConfig = loadAuthConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const telemetry = startTelemetry(config);
const auth = createAuth(authConfig, createSmtpOtpSender(loadSmtpConfig(process.env)));
const database = createDatabasePool({ connectionString: authConfig.databaseUrl });
const { buildApp } = await import('./app.js');
const app = buildApp({ auth, database, logger });

await app.listen({ host: config.host, port: config.port });
logger.info('api.started', { host: config.host, port: config.port });

async function shutdown(signal: string): Promise<void> {
  logger.info('api.stopping', { signal });
  await app.close();
  await database.end();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
