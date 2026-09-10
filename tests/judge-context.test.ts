import { buildJudgeContext } from '@varytra/evaluation';
import type { DivergenceSegment } from '@varytra/alignment';
import { describe, expect, it } from 'vitest';

const divergence: DivergenceSegment = {
  baselineContext: [{ eventType: 'tool_call', actor: 'agent', toolName: 'lookup_ticket', argumentsRedacted: 'Authorization: Bearer top-secret-token', resultSummaryRedacted: 'ticket found', sequenceNo: 1, errorClass: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:open', metadata: { request_id: 'request-1' } }],
  baselineSequenceRange: [1, 1],
  candidateContext: [{ eventType: 'tool_call', actor: 'agent', toolName: 'refund', argumentsRedacted: '{"amount":20}', resultSummaryRedacted: 'refund issued', sequenceNo: 2, errorClass: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:open', metadata: { api_key: 'sk-abcdefghijk' } }],
  candidateSequenceRange: [2, 2],
  score: 8,
};

describe('judge-context', () => {
  it('sends bounded redacted divergence evidence rather than raw trace content', () => {
    const context = buildJudgeContext({
      taskIntent: 'Resolve the ticket using Authorization: Bearer task-secret-token.',
      policyRequirements: ['Do not issue refunds without approval.', 'password=hunter2'],
      deterministicFindings: [{ category: 'efficiency', severity: 'medium' }],
      divergence,
    });

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('top-secret-token');
    expect(serialized).not.toContain('task-secret-token');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-abcdefghijk');
    expect(context.baselineEvents).toHaveLength(1);
    expect(context.candidateEvents).toHaveLength(1);
    expect(context.availableEvidenceIds).toEqual(['baseline:1', 'candidate:2']);
  });
});
