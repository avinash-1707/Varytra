import { createTraceRecorder, ingestTrace } from '@varytra/schemas';
import { normalizeTrace } from '@varytra/normalization';
import { describe, expect, it } from 'vitest';

describe('equivalence-rules', () => {
  it('never normalizes tool identity, state references, errors, recipients, permissions, or monetary values', () => {
    const recorder = createTraceRecorder('trace-equivalence', 'run-equivalence');
    recorder.record({ eventType: 'error', actor: 'agent', parentEventId: null, toolName: 'issue_refund', arguments: JSON.stringify({ recipient: 'customer-17', amount: 25 }), result: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', errorClass: 'tool_timeout', latencyMs: 1, tokenUsage: null, costUsd: null, metadata: { permission: 'write' } });
    const ingested = ingestTrace(recorder.events(), { traceId: 'trace-equivalence', runId: 'run-equivalence' });
    if (ingested.status === 'rejected') throw new Error('Expected trace to be accepted');

    const event = normalizeTrace(ingested.redactedEvents, { ignoredMetadataKeys: ['permission'], ignoredToolArgumentKeys: ['recipient', 'amount'] })[0];
    expect(event).toMatchObject({ eventType: 'error', toolName: 'issue_refund', errorClass: 'tool_timeout', argumentsRedacted: '[REDACTED]', sequenceNo: 1, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', metadata: { permission: 'write' } });
  });
});
