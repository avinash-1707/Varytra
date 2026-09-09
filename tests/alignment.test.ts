import { alignTraces } from '@varytra/alignment';
import type { NormalizedTraceEvent } from '@varytra/normalization';
import { describe, expect, it } from 'vitest';

function event(sequenceNo: number, overrides: Partial<NormalizedTraceEvent> = {}): NormalizedTraceEvent {
  return { eventType: 'tool_call', actor: 'agent', toolName: 'ticket_lookup', argumentsRedacted: null, resultSummaryRedacted: null, sequenceNo, errorClass: null, stateBeforeRef: 'ticket:open', stateAfterRef: null, metadata: {}, ...overrides };
}

describe('alignment', () => {
  it('localizes the first scored material divergence with bounded context', () => {
    const result = alignTraces([event(1), event(2, { eventType: 'final_outcome', stateAfterRef: 'ticket:resolved' })], [event(1), event(2, { eventType: 'policy_event', toolName: null, stateAfterRef: 'ticket:refunded' })]);

    expect(result).toMatchObject({ status: 'complete', score: 12, firstMaterialDivergence: { baselineSequenceRange: [2, 2], candidateSequenceRange: [2, 2], score: 12 } });
  });

  it('returns inconclusive rather than exceeding bounded comparison work', () => {
    expect(alignTraces([event(1), event(2)], [event(1), event(2)], { maxCells: 4 })).toEqual({ status: 'inconclusive', reason: 'alignment_budget_exceeded', partialDivergence: null });
  });
});
