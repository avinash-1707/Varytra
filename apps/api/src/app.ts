import Fastify from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { createLogger, runWithLogContext, serializeError, type Logger } from '@varytra/runtime';
import type { Pool } from 'pg';
import { withOrganizationTransaction } from '@varytra/infrastructure';
import { resolveMembership, AuthorizationError, requireCapability, type Capability, type Membership } from './authorization.js';

export interface AuthHandler {
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSessionUserId?: (headers: Headers) => Promise<string | undefined>;
  readonly isRecentSession: (headers: Headers) => Promise<boolean>;
}

export interface BuildAppOptions {
  readonly auth?: AuthHandler;
  readonly logger?: Logger;
  readonly database?: Pool;
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

  if (options.auth?.getSessionUserId !== undefined && options.database !== undefined) {
    async function authenticatedMembership(request: { readonly headers: Record<string, string | string[] | undefined> }): Promise<Membership> {
      const userId = await options.auth!.getSessionUserId!(fromNodeHeaders(request.headers));
      if (userId === undefined) {
        throw new AuthorizationError('invalid_credentials');
      }
      const selectedOrganization = request.headers['x-varytra-organization'];
      const organizationId = Array.isArray(selectedOrganization) ? selectedOrganization[0] : selectedOrganization;

      return resolveMembership(options.database!, userId, organizationId);
    }

    function authorize(membership: Membership, capability: Capability): void {
      requireCapability(membership.role, capability);
    }

    app.get('/v1/organization/authorization', async (request, reply) => {
      try {
        const membership = await authenticatedMembership(request);
        return { organization_id: membership.organizationId, role: membership.role };
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return reply.status(error.code === 'invalid_credentials' ? 401 : error.code === 'active_organization_required' ? 409 : 404).send({ error: error.code });
        }
        throw error;
      }
    });

    app.get('/v1/organization/members', async (request, reply) => {
      try {
        const membership = await authenticatedMembership(request);
        authorize(membership, 'members:read');
        const members = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query(
            'SELECT user_id AS "userId", role FROM organization_memberships WHERE organization_id = $1 ORDER BY created_at',
            [membership.organizationId],
          );
          return result.rows;
        });
        return { members };
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return reply.status(error.code === 'invalid_credentials' ? 401 : error.code === 'active_organization_required' ? 409 : error.code === 'forbidden' ? 403 : 404).send({ error: error.code });
        }
        throw error;
      }
    });
  }

  return app;
}
