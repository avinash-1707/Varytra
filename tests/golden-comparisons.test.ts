import { alignTraces } from '@varytra/alignment';
import { aggregateVerdict, type PairAssessment } from '@varytra/evaluation';
import type { NormalizedTraceEvent } from '@varytra/normalization';
import { describe, expect, it } from 'vitest';

const trace: readonly NormalizedTraceEvent[] = [{ eventType: 'final_outcome', actor: 'agent', toolName: null, argumentsRedacted: null, resultSummaryRedacted: 'resolved', sequenceNo: 1, errorClass: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', metadata: {} }];
const pair = (repetition: number, candidateMetrics = { costUsd: 1, toolCallCount: 2 }, candidateFindings: PairAssessment['candidateFindings'] = []): PairAssessment => ({ status: 'complete', repetition, alignment: alignTraces(trace, trace), baselineFindings: [], candidateFindings, baselineMetrics: { costUsd: 1, toolCallCount: 2 }, candidateMetrics });
const policy = { minimumCostImprovementUsd: 0.1, minimumToolCallImprovement: 1 };

describe('golden-comparisons', () => {
  it('keeps harmless equivalent runs as no material change', () => {
    expect(aggregateVerdict(2, [pair(1), pair(2)], policy).verdict).toEqual({ classification: 'no-material-change', severity: 'none', confidence: 'high' });
  });

  it('recognizes a consistent safe efficiency improvement', () => {
    expect(aggregateVerdict(2, [pair(1, { costUsd: 0.7, toolCallCount: 2 }), pair(2, { costUsd: 0.7, toolCallCount: 2 })], policy).verdict).toEqual({ classification: 'improvement', severity: 'none', confidence: 'high' });
  });

  it('classifies a critical state and policy regression', () => {
    const findings: PairAssessment['candidateFindings'] = [{ category: 'final_state', severity: 'critical', expected: { refundIssued: false }, actual: { refundIssued: true } }, { category: 'policy', severity: 'critical', failures: ['refund_requires_approval'] }];
    expect(aggregateVerdict(1, [pair(1, undefined, findings)], policy).verdict).toEqual({ classification: 'suspected-regression', severity: 'critical', confidence: 'high' });
  });
});
