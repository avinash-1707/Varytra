import { createTraceRecorder, ingestTrace } from '@varytra/schemas';
import { describe, expect, it } from 'vitest';

describe('trace-ingestion', () => {
  it('returns explicit outcomes for malformed, oversized, and out-of-order traces', () => {
    const recorder = createTraceRecorder('trace-1', 'run-1');
    const event = recorder.record({ eventType: 'error', actor: 'adapter', parentEventId: null, toolName: null, arguments: null, result: null, stateBeforeRef: null, stateAfterRef: null, errorClass: 'timeout', latencyMs: null, tokenUsage: null, costUsd: null, metadata: {} });

    const identity = { traceId: 'trace-1', runId: 'run-1' };
    expect(ingestTrace({ event }, identity)).toEqual({ status: 'rejected', reason: 'malformed_trace' });
    expect(ingestTrace([event, event], identity, 1)).toEqual({ status: 'rejected', reason: 'oversized_trace' });
    expect(ingestTrace([event, { ...event, eventId: 'trace-1:2', sequenceNo: 3 }], identity)).toEqual({ status: 'rejected', reason: 'invalid_sequence' });
    expect(ingestTrace([{ ...event, runId: 'foreign-run' }], identity)).toEqual({ status: 'rejected', reason: 'malformed_trace' });
  });
});
