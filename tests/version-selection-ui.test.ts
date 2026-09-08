import { describe, expect, it } from 'vitest';

import {
  getVersionSelectionStateContent,
  parseAgentVersionsResponse,
  parseScenarioVersionsResponse,
} from '../apps/web/src/app';

describe('version selection response helpers', () => {
  it('retains only immutable scenario metadata for the resolved preview', () => {
    expect(parseScenarioVersionsResponse({
      scenario_versions: [{
        id: 'scenario_version_001',
        version_number: 3,
        content_hash: 'sha256:scenario-content',
        fixture_ref: 'fixture:support-2026-09-08',
        policy_version: 'policy-v4',
        task: 'raw scenario content must not be used by the interface',
      }],
    })).toEqual([{
      id: 'scenario_version_001',
      version: '3',
      contentHash: 'sha256:scenario-content',
      fixtureRef: 'fixture:support-2026-09-08',
      policyVersion: 'policy-v4',
    }]);
  });

  it('retains only safe agent metadata and rejects malformed version envelopes', () => {
    expect(parseAgentVersionsResponse({
      agent_versions: [{
        id: 'agent_version_002',
        version: '12',
        contentHash: 'sha256:agent-content',
        adapter_type: 'registered-http',
        model_name: 'gpt-5.6',
        secret: 'must never be mapped to display data',
      }],
    })).toEqual([{
      id: 'agent_version_002',
      version: '12',
      contentHash: 'sha256:agent-content',
      adapter: 'registered-http',
      model: 'gpt-5.6',
    }]);

    expect(() => parseScenarioVersionsResponse({ scenario_versions: [{}] })).toThrow(TypeError);
    expect(() => parseAgentVersionsResponse({ agent_versions: 'invalid' })).toThrow(TypeError);
  });

  it('has explicit error and permission copy that does not disclose configuration content', () => {
    expect(getVersionSelectionStateContent('error').heading).toContain('could not be loaded');
    const permission = getVersionSelectionStateContent('permission');
    expect(permission.heading).toContain('do not have access');
    expect(permission.body).not.toContain('agent_version_002');
  });

  it('accepts empty immutable version collections for the explicit empty state', () => {
    expect(parseScenarioVersionsResponse({ scenario_versions: [] })).toEqual([]);
    expect(parseAgentVersionsResponse({ agent_versions: [] })).toEqual([]);
  });
});
