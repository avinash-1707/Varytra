import { createTraceRecorder, traceSchemaVersion } from '@varytra/schemas';
import { describe, expect, it } from 'vitest';

describe('trace-contract', () => {
  it('records versioned canonical events in strictly increasing sequence order', () => {
    const recorder = createTraceRecorder('trace-1', 'run-1', () => new Date('2026-01-01T00:00:00.000Z'));
    const first = recorder.record({ eventType: 'agent_message', actor: 'agent', parentEventId: null, toolName: null, arguments: 'resolve ticket', result: null, stateBeforeRef: null, stateAfterRef: null, errorClass: null, latencyMs: null, tokenUsage: 10, costUsd: 0.01, metadata: {} });
    const second = recorder.record({ eventType: 'final_outcome', actor: 'agent', parentEventId: first.eventId, toolName: null, arguments: null, result: 'resolved', stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', errorClass: null, latencyMs: null, tokenUsage: null, costUsd: null, metadata: {} });

    expect([first.sequenceNo, second.sequenceNo]).toEqual([1, 2]);
    expect(second.parentEventId).toBe(first.eventId);
    expect(second.schemaVersion).toBe(traceSchemaVersion);
  });
});
