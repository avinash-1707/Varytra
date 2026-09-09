import { runDeterministicChecks } from '@varytra/evaluation';
import { describe, expect, it } from 'vitest';

describe('deterministic-checks', () => {
  it('reports final-state and policy failures before trajectory-adjacent reliability and efficiency findings', () => {
    const findings = runDeterministicChecks({
      candidateFinalState: { status: 'resolved', refundIssued: true },
      expectedFinalState: { status: 'resolved', refundIssued: false },
      candidatePolicyFailures: ['refund_requires_approval'],
      candidateReliabilityFailures: ['tool_timeout'],
      candidateMetrics: { costUsd: 1.2, toolCallCount: 9 },
      efficiencyBudget: { maxCostUsd: 1, maxToolCalls: 8 },
    });

    expect(findings.map((finding) => finding.category)).toEqual(['final_state', 'policy', 'reliability', 'efficiency']);
    expect(findings[0]).toMatchObject({ severity: 'critical' });
    expect(findings[1]).toMatchObject({ severity: 'critical' });
  });

  it('requires an exact structural final-state match', () => {
    const findings = runDeterministicChecks({
      candidateFinalState: { status: 'resolved', outcome: { refundIssued: false }, unexpectedSideEffect: true },
      expectedFinalState: { status: 'resolved', outcome: { refundIssued: false } },
      candidatePolicyFailures: [],
      candidateReliabilityFailures: [],
      candidateMetrics: { costUsd: 0.1, toolCallCount: 1 },
      efficiencyBudget: { maxCostUsd: 1, maxToolCalls: 8 },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'final_state', severity: 'critical' });
  });
});
