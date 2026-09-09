import { alignTraces } from '@varytra/alignment';
import { aggregateVerdict, type PairAssessment } from '@varytra/evaluation';
import type { NormalizedTraceEvent } from '@varytra/normalization';
import { describe, expect, it } from 'vitest';

const trace: readonly NormalizedTraceEvent[] = [{ eventType: 'final_outcome', actor: 'agent', toolName: null, argumentsRedacted: null, resultSummaryRedacted: 'resolved', sequenceNo: 1, errorClass: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', metadata: {} }];
const cleanPair = (repetition: number): PairAssessment => ({ status: 'complete', repetition, alignment: alignTraces(trace, trace), baselineFindings: [], candidateFindings: [], baselineMetrics: { costUsd: 1, toolCallCount: 2 }, candidateMetrics: { costUsd: 1, toolCallCount: 2 } });
const policy = { minimumCostImprovementUsd: 0.1, minimumToolCallImprovement: 1 };

describe('verdict-aggregation', () => {
  it('gives critical deterministic findings precedence over incomplete coverage', () => {
    const regression: PairAssessment = { ...cleanPair(1), candidateFindings: [{ category: 'policy', severity: 'critical', failures: ['refund_requires_approval'] }] };
    const result = aggregateVerdict(2, [regression], policy);
    expect(result.verdict).toEqual({ classification: 'suspected-regression', severity: 'critical', confidence: 'high' });
  });

  it('returns inconclusive when coverage or alignment is incomplete', () => {
    const result = aggregateVerdict(2, [cleanPair(1)], policy);
    expect(result.verdict).toMatchObject({ classification: 'inconclusive', reasons: ['incomplete_pair'] });
  });

  it('does not allow duplicate repetitions to satisfy coverage', () => {
    const result = aggregateVerdict(2, [cleanPair(1), cleanPair(1)], policy);
    expect(result.verdict).toMatchObject({ classification: 'inconclusive', reasons: ['incomplete_pair'] });
  });
});
