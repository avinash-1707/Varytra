import { describe, expect, it } from 'vitest';
import { createReviewRequestBody, getReportRequestState, getReportStateContent, parseComparisonReportResponse, readComparisonIdFromSearch } from '../apps/web/src/report';

const safeReport = {
  report: {
    classification: 'suspected-regression',
    severity: 'critical',
    confidence: 'high',
    coverage: { expected_pairs: 2, complete_pairs: 2, analyzable_pairs: 2 },
    gate_status: 'block',
    summary: 'Candidate violated the approval policy after a retry.',
    findings: [{ id: 'finding_01', category: 'policy', severity: 'critical', repetition: 1, summary: 'Approval policy failed.' }],
    first_material_divergence: { baseline_sequence_range: [4, 4], candidate_sequence_range: [4, 5], score: 12, baseline_context: [{ raw_payload: 'must not reach UI' }] },
    state_comparison: {
      expected_summary: 'Approval remains required.',
      baseline_summary: 'No refund issued.',
      candidate_summary: 'Refund state changed.',
      changes: [{ field: 'refund status', baseline_value: 'not issued', candidate_value: 'issued', relevance: 'policy-relevant' }],
    },
    review_decisions: [{ id: 'review_01', action: 'reject', rationale: 'Unsafe state transition requires remediation.', actor_label: 'Release reviewer', created_at: '2026-09-09T12:00:00.000Z' }],
    raw_trace: 'must not reach UI',
  },
};

describe('report UI response helpers', () => {
  it('projects only the allowlisted redacted report fields', () => {
    const report = parseComparisonReportResponse(safeReport);

    expect(report).toMatchObject({
      classification: 'suspected-regression',
      gateStatus: 'block',
      coverage: { expectedPairs: 2, completePairs: 2, analyzablePairs: 2 },
      firstMaterialDivergence: { baselineSequenceRange: [4, 4], candidateSequenceRange: [4, 5], score: 12 },
      stateComparison: { changes: [{ field: 'refund status', relevance: 'policy-relevant' }] },
      reviewDecisions: [{ action: 'reject', actor: 'Release reviewer' }],
    });
    expect(JSON.stringify(report)).not.toContain('must not reach UI');
  });

  it('keeps redaction and inconclusive evidence explicit without accepting malformed reports', () => {
    const report = parseComparisonReportResponse({
      report: {
        ...safeReport.report,
        classification: 'inconclusive',
        state_comparison: { status: 'redacted', redaction_reason: 'Restricted state evidence.', changes: [] },
        redaction: { reason: 'Redacted by project policy.', scope: 'state comparison', access_role: 'owner' },
      },
    });

    expect(report.classification).toBe('inconclusive');
    expect(report.stateComparison.status).toBe('redacted');
    expect(report.redaction).toEqual({ reason: 'Redacted by project policy.', scope: 'state comparison', accessRole: 'owner' });
    expect(() => parseComparisonReportResponse({ report: { findings: [] } })).toThrow(TypeError);
  });

  it('maps deep links and denied requests without disclosing a report', () => {
    expect(readComparisonIdFromSearch('?comparisonId=comparison_01')).toBe('comparison_01');
    expect(readComparisonIdFromSearch('?batchId=batch_01')).toBeNull();
    expect(getReportRequestState(403)).toBe('permission');
    expect(getReportRequestState(500)).toBe('error');
    expect(getReportStateContent('permission').body).not.toContain('Candidate violated');
  });

  it('sends a replacement classification only with an override decision', () => {
    expect(createReviewRequestBody({ action: 'approve', rationale: 'Evidence supports the release.' })).toEqual({
      action: 'approve',
      rationale: 'Evidence supports the release.',
    });
    expect(createReviewRequestBody({ action: 'override_classification', rationale: 'The reported state change is expected.', overrideClassification: 'no-material-change' })).toEqual({
      action: 'override_classification',
      rationale: 'The reported state change is expected.',
      override_classification: 'no-material-change',
    });
  });
});
