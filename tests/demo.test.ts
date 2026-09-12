import { deriveComparisonReport } from '@varytra/infrastructure/scheduling';
import { toCiGateStatus } from '../apps/api/src/ci-runs.js';
import { describe, expect, it } from 'vitest';

const outcome = (side: 'baseline' | 'candidate', refundIssued: boolean, policyFailures: readonly string[] = []) => ({
  side,
  repetition: 1,
  finalState: { refundIssued, status: 'resolved' },
  policyFailures,
  metrics: { costUsd: 0, durationMs: 10, eventCount: 2, tokenUsage: 0, toolCallCount: 1 },
});

describe('demo', () => {
  it('demonstrates harmless variation passing and an unsafe refund blocking CI with redacted evidence', () => {
    const harmless = deriveComparisonReport({ expectedFinalState: { refundIssued: false, status: 'resolved' }, outcomes: [outcome('baseline', false), outcome('candidate', false)] });
    const regression = deriveComparisonReport({ expectedFinalState: { refundIssued: false, status: 'resolved' }, outcomes: [outcome('baseline', false), outcome('candidate', true, ['refund_requires_approval'])] });

    expect(harmless).toMatchObject({ classification: 'no-material-change', gateStatus: 'pass' });
    expect(toCiGateStatus('completed', harmless.gateStatus)).toBe('pass');
    expect(regression).toMatchObject({ classification: 'suspected-regression', severity: 'critical', gateStatus: 'block' });
    expect(toCiGateStatus('completed', regression.gateStatus)).toBe('fail');
    expect(JSON.stringify(regression)).not.toContain('raw_trace');
  });
});
