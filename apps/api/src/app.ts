import Fastify from 'fastify';
import { createLogger, runWithLogContext, serializeError, type Logger } from '@varytra/runtime';

export interface BuildAppOptions {
  readonly logger?: Logger;
}

export function buildApp(options: BuildAppOptions = {}) {
  const logger = options.logger ?? createLogger();
  const app = Fastify({ logger: false, requestIdHeader: false });

  app.addHook('onRequest', (request, reply, done) => {
    runWithLogContext({ request_id: request.id }, () => {
      reply.header('x-request-id', request.id);
      logger.info('http.request.started', {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
      });
      done();
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info('http.request.completed', {
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error('http.request.failed', {
      request_id: request.id,
      method: request.method,
      ...serializeError(error),
    });
    reply.status(500).send({ error: 'internal_error', request_id: request.id });
  });

  app.get('/health', async () => {
    logger.info('health.checked');
    return { status: 'ok' as const };
  });

  return app;
}
