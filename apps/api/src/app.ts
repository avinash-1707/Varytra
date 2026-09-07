import Fastify from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { createLogger, runWithLogContext, serializeError, type Logger } from '@varytra/runtime';

export interface AuthHandler {
  readonly handler: (request: Request) => Promise<Response>;
  readonly isRecentSession: (headers: Headers) => Promise<boolean>;
}

export interface BuildAppOptions {
  readonly auth?: AuthHandler;
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

  if (options.auth !== undefined) {
    app.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (request, reply) => {
        const headers = fromNodeHeaders(request.headers);

        if (request.url.split('?')[0] === '/api/auth/link-social' && !await options.auth!.isRecentSession(headers)) {
          return reply.status(401).send({ error: 'reauthentication_required' });
        }

        const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
        const response = await options.auth!.handler(new Request(url, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }));

        response.headers.forEach((value, key) => reply.header(key, value));
        return reply.status(response.status).send(response.body === null ? null : await response.text());
      },
    });
  }

  return app;
}
