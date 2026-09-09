import { createTraceRecorder, ingestTrace } from '@varytra/schemas';
import { normalizeTrace } from '@varytra/normalization';
import { describe, expect, it } from 'vitest';

describe('normalization', () => {
  it('removes only explicitly configured non-material metadata and request identifiers', () => {
    const recorder = createTraceRecorder('trace-normalize', 'run-normalize');
    recorder.record({ eventType: 'tool_call', actor: 'agent', parentEventId: null, toolName: 'ticket_update', arguments: JSON.stringify({ request_id: 'req-123', recipient: 'customer-17', amount: 25 }), result: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', errorClass: null, latencyMs: 1, tokenUsage: null, costUsd: null, metadata: { request_id: 'req-123', permission: 'write', timestamp: '2026-01-01T00:00:00.000Z' } });
    const ingested = ingestTrace(recorder.events(), { traceId: 'trace-normalize', runId: 'run-normalize' });
    if (ingested.status === 'rejected') throw new Error('Expected trace to be accepted');

    expect(normalizeTrace(ingested.redactedEvents)).toEqual([{
      eventType: 'tool_call', actor: 'agent', toolName: 'ticket_update', argumentsRedacted: '[REDACTED]', resultSummaryRedacted: null, sequenceNo: 1, errorClass: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', metadata: { permission: 'write' },
    }]);
  });

  it('preserves unknown, case-variant, and nested fields even when a configuration attempts to remove them', () => {
    const recorder = createTraceRecorder('trace-material', 'run-material');
    recorder.record({ eventType: 'tool_call', actor: 'agent', parentEventId: null, toolName: 'refund', arguments: JSON.stringify({ recipient: 'customer-17', amount: 25 }), result: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', errorClass: null, latencyMs: 1, tokenUsage: null, costUsd: null, metadata: { permission: 'write' } });
    const ingested = ingestTrace(recorder.events(), { traceId: 'trace-material', runId: 'run-material' });
    if (ingested.status === 'rejected') throw new Error('Expected trace to be accepted');

    const event = ingested.redactedEvents[0];
    if (event === undefined) throw new Error('Expected an ingested event');
    const normalized = normalizeTrace([{ ...event, argumentsRedacted: JSON.stringify({ Action: 'refund', merchant_id: 'merchant-7', payload: { recipient: 'customer-17' }, request_id: 'req-123' }) }], { ignoredMetadataKeys: ['permission'], ignoredToolArgumentKeys: ['Action', 'merchant_id', 'recipient', 'request_id'] });
    expect(normalized[0]?.argumentsRedacted).toBe(JSON.stringify({ Action: 'refund', merchant_id: 'merchant-7', payload: { recipient: 'customer-17' } }));
    expect(normalized[0]?.metadata).toEqual({ permission: 'write' });
  });
});
