import Fastify from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { createLogger, runWithLogContext, serializeError, type Logger } from '@varytra/runtime';
import type { Pool } from 'pg';
import { withOrganizationTransaction } from '@varytra/infrastructure';
import { z } from 'zod';
import {
  authenticateCiPrincipal,
  changeMembership,
  createOrganization,
  issueApiKey,
  listOrganizations,
  resolveMembership,
  rotateApiKey,
  AuthorizationError,
  requireCapability,
  writeAuditEvent,
  type ApiKeyScope,
  type Capability,
  type Membership,
} from './authorization.js';

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
    const organizationSchema = z.object({ name: z.string().trim().min(1).max(200) });
    const membershipSchema = z.object({ role: z.enum(['owner', 'admin', 'editor', 'viewer']) });
    const apiKeySchema = z.object({
      expires_at: z.coerce.date().refine((date) => date > new Date(), 'must be in the future'),
      name: z.string().trim().min(1).max(100),
      scopes: z.array(z.enum(['ci:read', 'ci:write'])).min(1),
    });
    const projectSchema = z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional().transform((value) => value === '' ? undefined : value),
    });

    function authorizationReply(error: AuthorizationError, reply: { status: (code: number) => { send: (body: unknown) => unknown } }): unknown {
      const status = error.code === 'invalid_credentials' ? 401 : error.code === 'invalid_request' ? 400 : error.code === 'active_organization_required' ? 409 : error.code === 'forbidden' ? 403 : 404;
      return reply.status(status).send({ error: error.code });
    }

    function isUuid(value: string | undefined): value is string {
      return value !== undefined && z.uuid().safeParse(value).success;
    }

    async function authenticatedUser(request: { readonly headers: Record<string, string | string[] | undefined> }): Promise<string> {
      const userId = await options.auth!.getSessionUserId!(fromNodeHeaders(request.headers));
      if (userId === undefined) {
        throw new AuthorizationError('invalid_credentials');
      }
      return userId;
    }

    async function authenticatedMembership(request: { readonly headers: Record<string, string | string[] | undefined> }): Promise<Membership> {
      const userId = await authenticatedUser(request);
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
          return authorizationReply(error, reply);
        }
        throw error;
      }
    });

    app.post('/v1/organizations', async (request, reply) => {
      try {
        const parsed = organizationSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'invalid_request' });
        }
        const organization = await createOrganization(options.database!, { name: parsed.data.name, ownerId: await authenticatedUser(request) });
        return reply.status(201).send({ organization });
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return authorizationReply(error, reply);
        }
        throw error;
      }
    });

    app.get('/v1/organizations', async (request, reply) => {
      try {
        return { organizations: await listOrganizations(options.database!, await authenticatedUser(request)) };
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return authorizationReply(error, reply);
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
          return authorizationReply(error, reply);
        }
        throw error;
      }
    });

    app.put('/v1/organization/members/:userId', async (request, reply) => {
      try {
        const userId = (request.params as { readonly userId?: string }).userId;
        const body = membershipSchema.safeParse(request.body);
        if (!body.success || userId === undefined || userId.length === 0) {
          return reply.status(400).send({ error: 'invalid_request' });
        }
        const membership = await authenticatedMembership(request);
        authorize(membership, 'members:write');
        await changeMembership(options.database!, { actor: membership, targetUserId: userId, role: body.data.role });
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return authorizationReply(error, reply);
        }
        throw error;
      }
    });

    app.delete('/v1/organization/members/:userId', async (request, reply) => {
      try {
        const userId = (request.params as { readonly userId?: string }).userId;
        if (userId === undefined || userId.length === 0) {
          return reply.status(400).send({ error: 'invalid_request' });
        }
        const membership = await authenticatedMembership(request);
        authorize(membership, 'members:write');
        await changeMembership(options.database!, { actor: membership, targetUserId: userId });
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return authorizationReply(error, reply);
        }
        throw error;
      }
    });

    app.get('/v1/organization/audit-events', async (request, reply) => {
      try {
        const membership = await authenticatedMembership(request);
        authorize(membership, 'audit:read');
        const events = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query(
            `SELECT id, actor_type AS "actorType", actor_id AS "actorId", action, target_type AS "targetType", target_id AS "targetId", occurred_at AS "occurredAt"
             FROM audit_events WHERE organization_id = $1 ORDER BY occurred_at DESC, id DESC`,
            [membership.organizationId],
          );
          return result.rows;
        });
        return { events };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.get('/v1/projects', async (request, reply) => {
      try {
        const membership = await authenticatedMembership(request);
        authorize(membership, 'projects:read');
        const projects = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query(
            `SELECT id, name, description, data_classification AS "dataClassification", retention_days AS "retentionDays", updated_at AS "updatedAt", created_at AS "createdAt"
             FROM projects WHERE organization_id = $1 ORDER BY updated_at DESC, id DESC`,
            [membership.organizationId],
          );
          return result.rows;
        });
        return { projects };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.post('/v1/projects', async (request, reply) => {
      try {
        const body = projectSchema.safeParse(request.body);
        if (!body.success) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'projects:create');
        const project = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const defaults = await client.query<Readonly<{ dataClassification: 'standard' | 'sensitive' | 'restricted'; retentionDays: number }>>(
            'SELECT data_classification AS "dataClassification", retention_days AS "retentionDays" FROM organizations WHERE id = $1',
            [membership.organizationId],
          );
          const organization = defaults.rows[0];
          if (organization === undefined) throw new AuthorizationError('not_found');
          const result = await client.query(
            `INSERT INTO projects (organization_id, name, description, data_classification, retention_days)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, description, data_classification AS "dataClassification", retention_days AS "retentionDays", updated_at AS "updatedAt", created_at AS "createdAt"`,
            [membership.organizationId, body.data.name, body.data.description ?? null, organization.dataClassification, organization.retentionDays],
          );
          const created = result.rows[0];
          if (created === undefined) throw new Error('Project insert did not return a row');
          await writeAuditEvent(client, { organizationId: membership.organizationId, actorType: 'user', actorId: membership.userId, action: 'project.created', targetType: 'project', targetId: created.id });
          return created;
        });
        return reply.status(201).send({ project });
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.get('/v1/projects/:projectId', async (request, reply) => {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        if (!isUuid(projectId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'projects:read');
        const project = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query(
            `SELECT id, name, description, data_classification AS "dataClassification", retention_days AS "retentionDays", updated_at AS "updatedAt", created_at AS "createdAt"
             FROM projects WHERE id = $1`,
            [projectId],
          );
          return result.rows[0];
        });
        if (project === undefined) throw new AuthorizationError('not_found');
        return { project };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.patch('/v1/projects/:projectId', async (request, reply) => {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        const body = projectSchema.partial().safeParse(request.body);
        if (!isUuid(projectId) || !body.success || Object.keys(body.data).length === 0) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'projects:update');
        const project = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query(
            `UPDATE projects SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
             WHERE id = $1
             RETURNING id, name, description, data_classification AS "dataClassification", retention_days AS "retentionDays", updated_at AS "updatedAt", created_at AS "createdAt"`,
            [projectId, body.data.name ?? null, body.data.description ?? null],
          );
          const updated = result.rows[0];
          if (updated === undefined) throw new AuthorizationError('not_found');
          await writeAuditEvent(client, { organizationId: membership.organizationId, actorType: 'user', actorId: membership.userId, action: 'project.updated', targetType: 'project', targetId: projectId });
          return updated;
        });
        return { project };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.get('/v1/projects/:projectId/audit-events', async (request, reply) => {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        if (!isUuid(projectId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'audit:read');
        const events = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const project = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
          if (project.rowCount !== 1) throw new AuthorizationError('not_found');
          const result = await client.query(
            `SELECT id, actor_type AS "actorType", actor_id AS "actorId", action, target_type AS "targetType", target_id AS "targetId", occurred_at AS "occurredAt"
             FROM audit_events WHERE organization_id = $1 AND target_type = 'project' AND target_id = $2 ORDER BY occurred_at DESC, id DESC`,
            [membership.organizationId, projectId],
          );
          return result.rows;
        });
        return { events };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.delete('/v1/projects/:projectId', async (request, reply) => {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        if (!isUuid(projectId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'projects:delete');
        await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const deleted = await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
          if (deleted.rowCount !== 1) throw new AuthorizationError('not_found');
          await writeAuditEvent(client, { organizationId: membership.organizationId, actorType: 'user', actorId: membership.userId, action: 'project.deleted', targetType: 'project', targetId: projectId });
        });
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    app.post('/v1/projects/:projectId/api-keys', async (request, reply) => {
      try {
        const body = apiKeySchema.safeParse(request.body);
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        if (!body.success || !isUuid(projectId)) {
          return reply.status(400).send({ error: 'invalid_request' });
        }
        const membership = await authenticatedMembership(request);
        authorize(membership, 'api_keys:create');
        const project = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]));
        if (project.rowCount !== 1) {
          throw new AuthorizationError('not_found');
        }
        const apiKey = await issueApiKey(options.database!, { organizationId: membership.organizationId, projectId, createdByUserId: membership.userId, name: body.data.name, scopes: body.data.scopes as readonly ApiKeyScope[], expiresAt: body.data.expires_at });
        return reply.status(201).send({ api_key: apiKey });
      } catch (error) {
        if (error instanceof AuthorizationError) {
          return authorizationReply(error, reply);
        }
        throw error;
      }
    });

    app.get('/v1/projects/:projectId/api-keys', async (request, reply) => {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        if (!isUuid(projectId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        let ownKeysOnly = false;
        try { authorize(membership, 'api_keys:manage_any'); } catch { requireCapability(membership.role, 'api_keys:manage_own'); ownKeysOnly = true; }
        const keys = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query(
            `SELECT id, name, scopes, expires_at AS "expiresAt", revoked_at AS "revokedAt", replaced_by AS "replacedBy", last_used_at AS "lastUsedAt", created_at AS "createdAt"
             FROM api_keys WHERE project_id = $1 ${ownKeysOnly ? 'AND created_by_user_id = $2' : ''} ORDER BY created_at DESC`,
            ownKeysOnly ? [projectId, membership.userId] : [projectId],
          );
          return result.rows;
        });
        return { api_keys: keys };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });

    async function manageApiKey(request: { readonly headers: Record<string, string | string[] | undefined>; readonly params: unknown }, reply: { status: (code: number) => { send: (body: unknown) => unknown } }, revoke: boolean): Promise<unknown> {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        const keyId = (request.params as { readonly keyId?: string }).keyId;
        if (!isUuid(projectId) || !isUuid(keyId)) {
          return reply.status(400).send({ error: 'invalid_request' });
        }
        const membership = await authenticatedMembership(request);
        const apiKey = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query<Readonly<{ createdByUserId: string }>>('SELECT created_by_user_id AS "createdByUserId" FROM api_keys WHERE id = $1 AND project_id = $2 FOR UPDATE', [keyId, projectId]);
          const key = result.rows[0];
          if (key === undefined) throw new AuthorizationError('not_found');
          try { authorize(membership, 'api_keys:manage_any'); } catch { requireCapability(membership.role, 'api_keys:manage_own'); if (key.createdByUserId !== membership.userId) throw new AuthorizationError('forbidden'); }
          if (revoke) {
            const revoked = await client.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [keyId]);
            if (revoked.rowCount !== 1) throw new AuthorizationError('not_found');
            await writeAuditEvent(client, { organizationId: membership.organizationId, actorType: 'user', actorId: membership.userId, action: 'api_key.revoked', targetType: 'api_key', targetId: keyId });
          }
          return key;
        });
        if (revoke) return reply.status(204).send('');
        return { api_key: apiKey };
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    }

    app.delete('/v1/projects/:projectId/api-keys/:keyId', async (request, reply) => manageApiKey(request, reply, true));

    app.post('/v1/projects/:projectId/api-keys/:keyId/rotate', async (request, reply) => {
      try {
        const projectId = (request.params as { readonly projectId?: string }).projectId;
        const keyId = (request.params as { readonly keyId?: string }).keyId;
        if (!isUuid(projectId) || !isUuid(keyId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        const existing = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const result = await client.query<Readonly<{ createdByUserId: string }>>('SELECT created_by_user_id AS "createdByUserId" FROM api_keys WHERE id = $1 AND project_id = $2', [keyId, projectId]);
          return result.rows[0];
        });
        if (existing === undefined) throw new AuthorizationError('not_found');
        try { authorize(membership, 'api_keys:manage_any'); } catch { requireCapability(membership.role, 'api_keys:manage_own'); if (existing.createdByUserId !== membership.userId) throw new AuthorizationError('forbidden'); }
        const apiKey = await rotateApiKey(options.database!, { actorId: membership.userId, keyId, organizationId: membership.organizationId, projectId });
        return reply.status(201).send({ api_key: apiKey });
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        throw error;
      }
    });
  }

  if (options.database !== undefined) {
    app.route({
      method: ['GET', 'POST'],
      url: '/v1/ci/authorization',
      handler: async (request, reply) => {
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
        if (token === undefined || token.length === 0) return reply.status(401).send({ error: 'invalid_credentials' });
        try {
          const principal = await authenticateCiPrincipal(options.database!, token, request.method === 'GET' ? 'ci:read' : 'ci:write');
          return { principal: { api_key_id: principal.apiKeyId, organization_id: principal.organizationId, project_id: principal.projectId, scopes: principal.scopes } };
        } catch (error) {
          if (error instanceof AuthorizationError) {
            const status = error.code === 'invalid_credentials' ? 401 : error.code === 'invalid_request' ? 400 : error.code === 'forbidden' ? 403 : 404;
            return reply.status(status).send({ error: error.code });
          }
          throw error;
        }
      },
    });
  }

  return app;
}
