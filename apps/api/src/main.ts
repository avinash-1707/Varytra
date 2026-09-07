import { createLogger, loadRuntimeConfig, startTelemetry } from '@varytra/runtime';

const config = loadRuntimeConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const telemetry = startTelemetry(config);
const { buildApp } = await import('./app.js');
const app = buildApp({ logger });

await app.listen({ host: config.host, port: config.port });
logger.info('api.started', { host: config.host, port: config.port });

async function shutdown(signal: string): Promise<void> {
  logger.info('api.stopping', { signal });
  await app.close();
  await telemetry.shutdown();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
