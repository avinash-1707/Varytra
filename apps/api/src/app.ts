import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { createLogger, runWithLogContext, serializeError, type Logger } from '@varytra/runtime';
import type { Pool } from 'pg';
import { withOrganizationTransaction } from '@varytra/infrastructure';
import { createComparisonBatch, markDispatchPublished, readyDispatches, SchedulingError } from '@varytra/infrastructure/scheduling';
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
  readonly dispatchPublisher?: Readonly<{ publish: (dispatch: { readonly dispatchId: string; readonly organizationId: string; readonly runId: string }) => Promise<void> }>;
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
    const policySchema = z.object({ stable_key: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/), rules: z.object({ prohibited_actions: z.array(z.string().min(1)).max(100), required_approvals: z.array(z.string().min(1)).max(100), severity: z.enum(['low', 'medium', 'high', 'critical']) }) });
    const scenarioSchema = z.object({ stable_key: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/), task_spec: z.object({ input: z.string().min(1).max(20_000), success_definition: z.string().min(1).max(10_000) }), fixture_ref: z.string().min(1).max(500), assertion_spec: z.object({ expected_state: z.record(z.string(), z.unknown()), assertions: z.array(z.string().min(1)).min(1).max(100) }), efficiency_budget: z.object({ max_tool_calls: z.number().int().positive().max(10_000), max_cost_usd: z.number().positive().max(100_000) }), policy_version_id: z.uuid().optional() });
    const agentVersionSchema = z.object({ stable_key: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/), adapter_type: z.enum(['reference', 'registered-http']), config_ref: z.string().regex(/^(secret|vault):\/\/[A-Za-z0-9._/-]+$/), model_metadata: z.object({ model: z.string().min(1).max(200) }).catchall(z.string().max(500)) });
    const batchSchema = z.object({ baseline_agent_version_id: z.uuid(), candidate_agent_version_id: z.uuid(), scenario_version_ids: z.array(z.uuid()).min(1).max(100), repetition_count: z.number().int().min(1).max(20), idempotency_key: z.string().trim().min(1).max(128) });
    const comparisonClassificationSchema = z.enum(['improvement', 'no-material-change', 'suspected-regression', 'inconclusive']);
    const reviewSchema = z.object({ action: z.enum(['approve', 'reject', 'mark_inconclusive', 'override_classification']), rationale: z.string().trim().min(1).max(2000), override_classification: comparisonClassificationSchema.optional() }).superRefine((value, context) => {
      if (value.action === 'override_classification' && value.override_classification === undefined) context.addIssue({ code: 'custom', message: 'override classification is required', path: ['override_classification'] });
      if (value.action !== 'override_classification' && value.override_classification !== undefined) context.addIssue({ code: 'custom', message: 'override classification is only allowed for override decisions', path: ['override_classification'] });
    });

    function contentHash(value: unknown): string {
      return createHash('sha256').update(JSON.stringify(value)).digest('hex');
    }

    function authorizationReply(error: AuthorizationError, reply: { status: (code: number) => { send: (body: unknown) => unknown } }): unknown {
      const status = error.code === 'invalid_credentials' ? 401 : error.code === 'invalid_request' ? 400 : error.code === 'active_organization_required' ? 409 : error.code === 'forbidden' ? 403 : 404;
      return reply.status(status).send({ error: error.code });
    }

    function isUuid(value: string | undefined): value is string {
      return value !== undefined && z.uuid().safeParse(value).success;
    }

    function reportGateStatus(action: z.infer<typeof reviewSchema>['action']): 'pass' | 'warn' | 'block' | 'review' {
      return ({ approve: 'pass', reject: 'block', mark_inconclusive: 'warn', override_classification: 'review' } as const)[action];
    }

    function reportJsonObject(value: unknown): Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
    }

    function redactReviewRationale(value: string): string {
      // Reviewer input is a report trust boundary, so never render credential-like values or pasted structured payloads by default.
      return /(?:api[-_]?key|authorization|bearer|cookie|password|secret|token)\s*[=:]|(?:sk-[a-z0-9_-]{8,}|gh[pousr]_|github_pat_|akia[0-9a-z]{16}|eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)|(?:^|\n)\s*[[{]/i.test(value) ? '[REDACTED_RESTRICTED_CONTENT]' : value;
    }

    function safeReportProjection(value: Readonly<{ coverage: unknown; firstMaterialDivergence: unknown; stateComparison: unknown }>) {
      const coverage = reportJsonObject(value.coverage);
      const divergence = reportJsonObject(value.firstMaterialDivergence);
      const stateComparison = reportJsonObject(value.stateComparison);
      const number = (candidate: unknown): number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
      const text = (candidate: unknown): string | null => typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
      const range = (candidate: unknown): readonly [number, number] | null => Array.isArray(candidate) && candidate.length === 2 && candidate.every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) ? [candidate[0] as number, candidate[1] as number] : null;
      const changes = Array.isArray(stateComparison.changes) ? stateComparison.changes.flatMap((change) => {
        const record = reportJsonObject(change);
        const field = text(record.field);
        return field === null ? [] : [{ field, baseline_value: text(record.baseline_value), candidate_value: text(record.candidate_value), relevance: text(record.relevance) }];
      }) : [];
      return {
        coverage: { expected_pairs: number(coverage.expected_pairs), complete_pairs: number(coverage.complete_pairs), analyzable_pairs: number(coverage.analyzable_pairs) },
        first_material_divergence: Object.keys(divergence).length === 0 ? null : { baseline_sequence_range: range(divergence.baseline_sequence_range), candidate_sequence_range: range(divergence.candidate_sequence_range), score: typeof divergence.score === 'number' && Number.isFinite(divergence.score) ? divergence.score : null },
        state_comparison: { status: text(stateComparison.status) ?? 'unavailable', expected_summary: text(stateComparison.expected_summary), baseline_summary: text(stateComparison.baseline_summary), candidate_summary: text(stateComparison.candidate_summary), changes, redaction_reason: text(stateComparison.redaction_reason) },
      };
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

    async function projectMembership(request: { readonly headers: Record<string, string | string[] | undefined>; readonly params: unknown }, capability: Capability): Promise<{ readonly membership: Membership; readonly projectId: string }> {
      const projectId = (request.params as { readonly projectId?: string }).projectId;
      if (!isUuid(projectId)) throw new AuthorizationError('invalid_request');
      const membership = await authenticatedMembership(request);
      authorize(membership, capability);
      return { membership, projectId };
    }

    app.get('/v1/projects/:projectId/scenario-versions', async (request, reply) => {
      try {
        const { membership, projectId } = await projectMembership(request, 'versions:read');
        const scenarioVersions = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => (await client.query(`SELECT id, scenario_id AS "scenarioId", version, fixture_ref AS "fixtureRef", policy_version_id AS "policyVersion", content_hash AS "contentHash", created_at AS "createdAt" FROM scenario_versions WHERE project_id = $1 ORDER BY created_at DESC`, [projectId])).rows);
        return { scenario_versions: scenarioVersions };
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.get('/v1/projects/:projectId/agent-versions', async (request, reply) => {
      try {
        const { membership, projectId } = await projectMembership(request, 'versions:read');
        const agentVersions = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => (await client.query(`SELECT id, stable_key AS "stableKey", version, adapter_type AS "adapterType", model_metadata AS "modelMetadata", content_hash AS "contentHash", created_at AS "createdAt" FROM agent_versions WHERE project_id = $1 ORDER BY created_at DESC`, [projectId])).rows);
        return { agent_versions: agentVersions };
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.post('/v1/projects/:projectId/policies', async (request, reply) => {
      try {
        const body = policySchema.safeParse(request.body); if (!body.success) return reply.status(400).send({ error: 'invalid_request' });
        const { membership, projectId } = await projectMembership(request, 'versions:create');
        const policyVersion = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const policy = await client.query<{ readonly id: string }>('INSERT INTO policies (organization_id, project_id, stable_key) VALUES ($1, $2, $3) RETURNING id', [membership.organizationId, projectId, body.data.stable_key]);
          const policyId = policy.rows[0]?.id; if (policyId === undefined) throw new Error('Policy insert did not return a row');
          const hash = contentHash(body.data.rules);
          const version = await client.query('INSERT INTO policy_versions (organization_id, project_id, policy_id, version, rules, content_hash, created_by_user_id) VALUES ($1, $2, $3, 1, $4, $5, $6) RETURNING id, version, content_hash AS "contentHash"', [membership.organizationId, projectId, policyId, body.data.rules, hash, membership.userId]);
          return version.rows[0];
        });
        return reply.status(201).send({ policy_version: policyVersion });
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.post('/v1/projects/:projectId/scenarios', async (request, reply) => {
      try {
        const body = scenarioSchema.safeParse(request.body); if (!body.success) return reply.status(400).send({ error: 'invalid_request' });
        const { membership, projectId } = await projectMembership(request, 'versions:create');
        const scenarioVersion = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          if (body.data.policy_version_id !== undefined && (await client.query('SELECT 1 FROM policy_versions WHERE id = $1 AND project_id = $2', [body.data.policy_version_id, projectId])).rowCount !== 1) throw new AuthorizationError('not_found');
          const scenario = await client.query<{ readonly id: string }>('INSERT INTO scenarios (organization_id, project_id, stable_key) VALUES ($1, $2, $3) RETURNING id', [membership.organizationId, projectId, body.data.stable_key]);
          const scenarioId = scenario.rows[0]?.id; if (scenarioId === undefined) throw new Error('Scenario insert did not return a row');
          const hash = contentHash(body.data);
          const version = await client.query(`INSERT INTO scenario_versions (organization_id, project_id, scenario_id, version, task_spec, fixture_ref, assertion_spec, efficiency_budget, policy_version_id, content_hash, created_by_user_id) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10) RETURNING id, scenario_id AS "scenarioId", version, fixture_ref AS "fixtureRef", policy_version_id AS "policyVersion", content_hash AS "contentHash"`, [membership.organizationId, projectId, scenarioId, body.data.task_spec, body.data.fixture_ref, body.data.assertion_spec, body.data.efficiency_budget, body.data.policy_version_id ?? null, hash, membership.userId]);
          return version.rows[0];
        });
        return reply.status(201).send({ scenario_version: scenarioVersion });
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.post('/v1/projects/:projectId/agent-versions', async (request, reply) => {
      try {
        const body = agentVersionSchema.safeParse(request.body); if (!body.success) return reply.status(400).send({ error: 'invalid_request' });
        const { membership, projectId } = await projectMembership(request, 'versions:create');
        const agentVersion = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const hash = contentHash(body.data);
          const result = await client.query(`INSERT INTO agent_versions (organization_id, project_id, stable_key, version, adapter_type, config_ref, model_metadata, content_hash, created_by_user_id) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8) RETURNING id, stable_key AS "stableKey", version, adapter_type AS "adapterType", model_metadata AS "modelMetadata", content_hash AS "contentHash"`, [membership.organizationId, projectId, body.data.stable_key, body.data.adapter_type, body.data.config_ref, body.data.model_metadata, hash, membership.userId]);
          return result.rows[0];
        });
        return reply.status(201).send({ agent_version: agentVersion });
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.post('/v1/comparison-batches', async (request, reply) => {
      try {
        const body = batchSchema.safeParse(request.body);
        const projectId = typeof (request.body as { readonly project_id?: unknown } | undefined)?.project_id === 'string' ? (request.body as { readonly project_id: string }).project_id : undefined;
        if (!body.success || !isUuid(projectId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'batches:create');
        const batch = await createComparisonBatch(options.database!, {
          organizationId: membership.organizationId,
          projectId,
          userId: membership.userId,
          baselineAgentVersionId: body.data.baseline_agent_version_id,
          candidateAgentVersionId: body.data.candidate_agent_version_id,
          scenarioVersionIds: body.data.scenario_version_ids,
          repetitionCount: body.data.repetition_count,
          idempotencyKey: body.data.idempotency_key,
        });
        if (options.dispatchPublisher !== undefined) {
          const dispatches = await readyDispatches(options.database!, membership.organizationId, batch.id);
          for (const dispatch of dispatches) {
            await options.dispatchPublisher.publish(dispatch);
            await markDispatchPublished(options.database!, membership.organizationId, dispatch.dispatchId);
          }
        }
        return reply.status(201).send({ batch: { id: batch.id, status: batch.status, run_count: batch.runCount } });
      } catch (error) {
        if (error instanceof AuthorizationError) return authorizationReply(error, reply);
        if (error instanceof SchedulingError) return reply.status(error.code === 'idempotency_key_reused' ? 409 : error.code === 'not_found' ? 404 : 400).send({ error: error.code });
        throw error;
      }
    });

    app.get('/v1/comparison-batches/:batchId', async (request, reply) => {
      try {
        const batchId = (request.params as { readonly batchId?: string }).batchId;
        if (!isUuid(batchId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'batches:read');
        const batch = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => (await client.query<Readonly<{ id: string; status: 'queued' | 'running' | 'completed'; runCount: number }>>(
          `SELECT id, status, (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id) AS "runCount"
           FROM comparison_batches WHERE id = $1`, [batchId],
        )).rows[0]);
        if (batch === undefined) throw new AuthorizationError('not_found');
        return { batch: { id: batch.id, status: batch.status, run_count: batch.runCount } };
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.get('/v1/comparison-batches/:batchId/progress', async (request, reply) => {
      try {
        const batchId = (request.params as { readonly batchId?: string }).batchId;
        if (!isUuid(batchId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'batches:read');
        const progress = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => (await client.query<Readonly<{
          batchId: string;
          stage: 'queued' | 'preparing_fixture' | 'running_baseline' | 'running_candidate' | 'complete' | 'failed';
          status: 'queued' | 'running' | 'completed';
          total: number;
          queued: number;
          running: number;
          succeeded: number;
          failed: number;
        }>>(
          `SELECT id AS "batchId", status, progress_stage AS stage,
             (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id) AS total,
             (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id AND status = 'queued') AS queued,
             (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id AND status = 'running') AS running,
             (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id AND status = 'succeeded') AS succeeded,
             (SELECT count(*)::integer FROM agent_runs WHERE batch_id = comparison_batches.id AND status IN ('agent_failed', 'infrastructure_failed', 'timed_out')) AS failed
           FROM comparison_batches WHERE id = $1`, [batchId],
        )).rows[0]);
        if (progress === undefined) throw new AuthorizationError('not_found');
        return { progress: { batch_id: progress.batchId, status: progress.status, stage: progress.stage, runs: { total: progress.total, queued: progress.queued, running: progress.running, succeeded: progress.succeeded, failed: progress.failed } } };
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.get('/v1/comparisons/:comparisonId/report', async (request, reply) => {
      try {
        const comparisonId = (request.params as { readonly comparisonId?: string }).comparisonId;
        if (!isUuid(comparisonId)) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'reports:read');
        const report = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const comparison = (await client.query<Readonly<{ classification: string; severity: string; confidence: string; gateStatus: 'pass' | 'warn' | 'block' | 'review'; summary: string; coverage: unknown; firstMaterialDivergence: unknown; stateComparison: unknown }>>(
            `SELECT classification, severity, confidence, gate_status AS "gateStatus", summary_redacted AS summary, coverage,
                    first_material_divergence AS "firstMaterialDivergence", state_comparison AS "stateComparison"
             FROM comparisons WHERE id = $1`, [comparisonId],
          )).rows[0];
          if (comparison === undefined) throw new AuthorizationError('not_found');
          const [findings, decisions] = await Promise.all([
            client.query<Readonly<{ id: string; category: string; severity: string; repetition: number | null; summary: string }>>('SELECT id, category, severity, repetition, summary_redacted AS summary FROM comparison_findings WHERE comparison_id = $1 ORDER BY created_at, id', [comparisonId]),
            client.query<Readonly<{ id: string; action: string; rationale: string; actor: string; createdAt: string; gateStatus: 'pass' | 'warn' | 'block' | 'review'; overrideClassification: z.infer<typeof comparisonClassificationSchema> | null }>>('SELECT id, action, rationale, actor_id AS actor, created_at AS "createdAt", resulting_gate_status AS "gateStatus", override_classification AS "overrideClassification" FROM review_decisions WHERE comparison_id = $1 ORDER BY created_at DESC, id DESC', [comparisonId]),
          ]);
          const projection = safeReportProjection(comparison);
          const latestDecision = decisions.rows[0];
          const latestOverride = decisions.rows.find((decision) => decision.overrideClassification !== null);
          return {
            classification: latestOverride?.overrideClassification ?? comparison.classification,
            severity: comparison.severity,
            confidence: comparison.confidence,
            gate_status: latestDecision?.gateStatus ?? comparison.gateStatus,
            summary: comparison.summary,
            ...projection,
            findings: findings.rows,
            review_decisions: decisions.rows,
          };
        });
        return { report };
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
    });

    app.post('/v1/comparisons/:comparisonId/review', async (request, reply) => {
      try {
        const comparisonId = (request.params as { readonly comparisonId?: string }).comparisonId;
        const body = reviewSchema.safeParse(request.body);
        if (!isUuid(comparisonId) || !body.success) return reply.status(400).send({ error: 'invalid_request' });
        const membership = await authenticatedMembership(request);
        authorize(membership, 'reports:review');
        const resultingGateStatus = reportGateStatus(body.data.action);
        const decision = await withOrganizationTransaction(options.database!, membership.organizationId, async (client) => {
          const comparison = await client.query('SELECT project_id FROM comparisons WHERE id = $1', [comparisonId]);
          const projectId = comparison.rows[0]?.project_id as string | undefined;
          if (projectId === undefined) throw new AuthorizationError('not_found');
          const result = await client.query<Readonly<{ id: string; createdAt: string }>>(
            'INSERT INTO review_decisions (organization_id, project_id, comparison_id, actor_id, action, rationale, override_classification, resulting_gate_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at AS "createdAt"',
            [membership.organizationId, projectId, comparisonId, membership.userId, body.data.action, redactReviewRationale(body.data.rationale), body.data.override_classification ?? null, resultingGateStatus],
          );
          const created = result.rows[0];
          if (created === undefined) throw new Error('Review decision insert did not return a row');
          await writeAuditEvent(client, { organizationId: membership.organizationId, actorType: 'user', actorId: membership.userId, action: 'comparison.review_recorded', targetType: 'comparison', targetId: comparisonId, metadata: { action: body.data.action, gate_status: resultingGateStatus, review_decision_id: created.id } });
          return created;
        });
        return reply.status(201).send({ review_decision: { id: decision.id, action: body.data.action, override_classification: body.data.override_classification ?? null, gate_status: resultingGateStatus, created_at: decision.createdAt } });
      } catch (error) { if (error instanceof AuthorizationError) return authorizationReply(error, reply); throw error; }
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
