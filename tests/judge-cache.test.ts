import { InMemoryJudgeResultCache, evaluateLocalizedSemanticJudge, type JudgeClient } from '@varytra/evaluation';
import { describe, expect, it } from 'vitest';

describe('judge-cache', () => {
  it('caches immutable input results while attributing provider cost only once', async () => {
    let calls = 0;
    const client: JudgeClient = {
      model: 'fake-1',
      evaluate: async () => {
        calls += 1;
        return { classification: 'no-material-change', severity: 'medium', confidence: 0.9, evidenceIds: [], rationale: 'The observed divergence is benign.', usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.01 } };
      },
    };
    const cache = new InMemoryJudgeResultCache();
    const input = { taskIntent: 'Resolve the support ticket.', policyRequirements: ['Refunds require approval.'], deterministicFindings: [], divergence: null };

    const first = await evaluateLocalizedSemanticJudge(client, input, cache);
    const second = await evaluateLocalizedSemanticJudge(client, input, cache);

    expect(calls).toBe(1);
    expect(first).toMatchObject({ status: 'complete', attribution: { cached: false, costUsd: 0.01 } });
    expect(second).toMatchObject({ status: 'complete', attribution: { cached: true, costUsd: 0 } });
  });
});
