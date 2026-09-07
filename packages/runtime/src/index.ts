import { AsyncLocalStorage } from 'node:async_hooks';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { z } from 'zod';

const logLevels = ['debug', 'info', 'warn', 'error'] as const;
const safeLogFieldNames = new Set([
  'error_type',
  'host',
  'method',
  'port',
  'request_id',
  'route',
  'signal',
  'status',
  'status_code',
]);
const safeEventNames = new Set([
  'api.started',
  'api.stopping',
  'health.checked',
  'http.request.completed',
  'http.request.failed',
  'http.request.started',
  'worker.noop_job.completed',
]);

export const runtimeConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  SERVICE_NAME: z.string().trim().min(1).max(63),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  OTEL_TRACES_EXPORTER: z.literal('none').default('none'),
});

export type RuntimeConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  serviceName: string;
  host: string;
  port: number;
  logLevel: (typeof logLevels)[number];
}>;

export class RuntimeConfigError extends Error {
  public constructor(fields: readonly string[]) {
    super(`Invalid runtime configuration: ${fields.join(', ')}`);
    this.name = 'RuntimeConfigError';
  }
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse(environment);

  if (!parsed.success) {
    throw new RuntimeConfigError(parsed.error.issues.map((issue) => issue.path.join('.')));
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    serviceName: parsed.data.SERVICE_NAME,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
  };
}

export type LogFieldValue = boolean | number | string;
export type LogFields = Readonly<Record<string, LogFieldValue | undefined>>;

export interface SafeError {
  readonly error_type: string;
}

export function serializeError(error: unknown): SafeError {
  return {
    error_type: error instanceof Error ? 'Error' : 'UnknownError',
  };
}

function sanitizeFields(fields: LogFields): Record<string, LogFieldValue> {
  const sanitized: Record<string, LogFieldValue> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && safeLogFieldNames.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

const logContext = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, callback: () => T): T {
  return logContext.run(sanitizeFields(fields), callback);
}

export interface Logger {
  readonly debug: (event: string, fields?: LogFields) => void;
  readonly info: (event: string, fields?: LogFields) => void;
  readonly warn: (event: string, fields?: LogFields) => void;
  readonly error: (event: string, fields?: LogFields) => void;
}

export interface LoggerOptions {
  readonly level?: RuntimeConfig['logLevel'];
  readonly write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => {
    process.stdout.write(line);
  });

  function log(entryLevel: RuntimeConfig['logLevel'], event: string, fields: LogFields = {}): void {
    if (logLevels.indexOf(entryLevel) < logLevels.indexOf(level)) {
      return;
    }

    write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: entryLevel,
      event: safeEventNames.has(event) ? event : 'unclassified',
      ...sanitizeFields(logContext.getStore() ?? {}),
      ...sanitizeFields(fields),
    })}\n`);
  }

  return {
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

export interface Telemetry {
  readonly shutdown: () => Promise<void>;
}

export function startTelemetry(config: RuntimeConfig): Telemetry {
  // No auto-instrumentation is enabled until its captured attributes are reviewed for content safety.
  const sdk = new NodeSDK({ serviceName: config.serviceName, spanProcessors: [] });
  sdk.start();

  return { shutdown: () => sdk.shutdown() };
}
