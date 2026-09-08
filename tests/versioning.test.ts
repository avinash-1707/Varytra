import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';
import { buildApp } from '../apps/api/src/app.js';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const organizationId = '99999999-9999-4999-8999-999999999999';
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describeDatabase('versioning', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });
  const app = buildApp({ database: database!, auth: { handler: async () => new Response(), getSessionUserId: async (headers) => headers.get('x-test-user') ?? undefined, isRecentSession: async () => true } });
  const headers = { 'x-test-user': 'version-editor', 'x-varytra-organization': organizationId };

  beforeAll(async () => {
    await runMigrations(connectionString!);
    await database!.query('TRUNCATE organizations, "user" CASCADE');
    await database!.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', ['version-editor', 'Version editor', 'version@example.test']);
    await database!.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [organizationId, 'Versioning']);
    await withOrganizationTransaction(database!, organizationId, async (client) => client.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'editor')", [organizationId, 'version-editor']));
    await withOrganizationTransaction(database!, organizationId, async (client) => client.query('INSERT INTO projects (id, organization_id, name) VALUES ($1, $2, $3)', [projectId, organizationId, 'Versioned']));
  });
  afterAll(async () => { await app.close(); await database?.end(); });

  it('creates append-only scenario, policy, and agent versions with stable hashes', async () => {
    const policy = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/policies`, headers, payload: { stable_key: 'refund-policy', rules: { prohibited_actions: ['refund'], required_approvals: ['manager'], severity: 'critical' } } });
    expect(policy.statusCode).toBe(201);
    const policyId = policy.json<{ readonly policy_version: { readonly id: string } }>().policy_version.id;
    const scenario = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/scenarios`, headers, payload: { stable_key: 'refund-check', task_spec: { input: 'Handle ticket 42', success_definition: 'Resolve without refund' }, fixture_ref: 'fixture://support/42', assertion_spec: { expected_state: { ticket: 'resolved' }, assertions: ['ticket is resolved'] }, efficiency_budget: { max_tool_calls: 8, max_cost_usd: 1 }, policy_version_id: policyId } });
    expect(scenario.statusCode).toBe(201);
    const agent = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/agent-versions`, headers, payload: { stable_key: 'baseline', adapter_type: 'reference', config_ref: 'secret://agents/baseline', model_metadata: { model: 'reference-v1' } } });
    expect(agent.statusCode).toBe(201);
    const scenarios = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/scenario-versions`, headers });
    const agents = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/agent-versions`, headers });
    expect(scenarios.json<{ readonly scenario_versions: readonly { readonly contentHash: string }[] }>().scenario_versions[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(agents.json<{ readonly agent_versions: readonly { readonly contentHash: string; readonly configRef?: string }[] }>().agent_versions[0]).toEqual(expect.objectContaining({ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it('scenario-validation rejects incomplete task, fixture, assertion, policy, and efficiency definitions', async () => {
    const response = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/scenarios`, headers, payload: { stable_key: 'invalid', task_spec: { input: '', success_definition: '' }, fixture_ref: '', assertion_spec: { expected_state: {}, assertions: [] }, efficiency_budget: { max_tool_calls: 0, max_cost_usd: 0 } } });
    expect(response.statusCode).toBe(400);
    const policy = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/policies`, headers, payload: { stable_key: 'invalid-policy', rules: { prohibited_actions: [], required_approvals: [], severity: 'unknown' } } });
    expect(policy.statusCode).toBe(400);
  });

  it('agent-versions accepts opaque references and rejects plaintext configuration', async () => {
    const response = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/agent-versions`, headers, payload: { stable_key: 'plaintext', adapter_type: 'registered-http', config_ref: 'sk-live-plaintext', model_metadata: { model: 'example' } } });
    expect(response.statusCode).toBe(400);
  });
});
