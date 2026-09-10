import { combineDeterministicAndSemanticVerdict, evaluateLocalizedSemanticJudge, type JudgeClient, type SemanticJudgeResult, type VerdictAssessment } from '@varytra/evaluation';
import { describe, expect, it } from 'vitest';

const input = { taskIntent: 'Resolve the support ticket.', policyRequirements: ['Refunds require approval.'], deterministicFindings: [], divergence: null };

describe('judge-results', () => {
  it.each([
    ['malformed', { classification: 'suspected-regression' }],
    ['low confidence', { classification: 'suspected-regression', severity: 'high', confidence: 0.4, evidenceIds: [], rationale: 'Unsafe action.', usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.01 } }],
  ])('returns inconclusive for %s provider responses', async (_label, response) => {
    const client: JudgeClient = { model: 'fake-1', evaluate: async () => response };
    await expect(evaluateLocalizedSemanticJudge(client, input)).resolves.toMatchObject({ status: 'inconclusive' });
  });

  it('returns inconclusive when the provider is unavailable', async () => {
    const client: JudgeClient = { model: 'fake-1', evaluate: async () => { throw new Error('provider unavailable'); } };
    await expect(evaluateLocalizedSemanticJudge(client, input)).resolves.toMatchObject({ status: 'inconclusive', reason: 'unavailable' });
  });

  it('uses consistent high-confidence semantic evidence only to resolve localized ambiguity', () => {
    const ambiguous: VerdictAssessment = {
      classification: 'inconclusive',
      coverage: { expectedPairs: 1, completePairs: 1, analyzablePairs: 1 },
      findings: [],
      firstMaterialDivergence: null,
      verdict: { classification: 'inconclusive', severity: 'unknown', confidence: 'low', reasons: ['alignment_divergence'] },
    };
    const semantic: SemanticJudgeResult = {
      status: 'complete',
      cacheKey: 'cache-key',
      response: { classification: 'no-material-change', severity: 'medium', confidence: 0.95, evidenceIds: [], rationale: 'Benign retry.', usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.01 } },
      attribution: { cached: false, inputTokens: 12, outputTokens: 8, costUsd: 0.01, latencyMs: 4 },
    };

    expect(combineDeterministicAndSemanticVerdict(ambiguous, [semantic]).verdict).toEqual({ classification: 'no-material-change', severity: 'none', confidence: 'high' });
    const conflicting: SemanticJudgeResult = { ...semantic, cacheKey: 'other-cache-key', response: { ...semantic.response, classification: 'suspected-regression' } };
    expect(combineDeterministicAndSemanticVerdict(ambiguous, [semantic, conflicting])).toEqual(ambiguous);
  });
});
