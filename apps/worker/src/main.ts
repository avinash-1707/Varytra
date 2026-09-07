import { createLogger, loadRuntimeConfig, startTelemetry } from '@varytra/runtime';
import { processNoopJob } from './noop-job.js';

const config = loadRuntimeConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const telemetry = startTelemetry(config);
const result = await processNoopJob();
logger.info('worker.noop_job.completed', { status: result.status });
await telemetry.shutdown();
