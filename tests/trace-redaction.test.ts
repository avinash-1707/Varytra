import { createTraceRecorder, ingestTrace } from '@varytra/schemas';
import { describe, expect, it } from 'vitest';

describe('trace-redaction', () => {
  it('removes secrets from stored raw-safe and review-safe trace representations', () => {
    const recorder = createTraceRecorder('trace-1', 'run-1', () => new Date('2026-01-01T00:00:00.000Z'));
    const event = recorder.record({ eventType: 'tool_call', actor: 'agent', parentEventId: null, toolName: 'refund', arguments: 'Authorization: Bearer top-secret-token', result: 'password=hunter2', stateBeforeRef: null, stateAfterRef: null, errorClass: null, latencyMs: null, tokenUsage: null, costUsd: null, metadata: { apiKey: 'sk-abcdefghi' } });
    const result = ingestTrace([event], { traceId: 'trace-1', runId: 'run-1' });

    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.restrictedFieldDetected).toBe(true);
      expect(JSON.stringify(result.rawEvents)).not.toContain('top-secret-token');
      expect(JSON.stringify(result.rawEvents)).not.toContain('hunter2');
      expect(JSON.stringify(result.rawEvents)).not.toContain('sk-abcdefghi');
      expect(result.redactedEvents[0]?.argumentsRedacted).toBe('[REDACTED_SECRET]');
    }
  });

  it('never includes unlabelled credential-like content in review events', () => {
    const recorder = createTraceRecorder('trace-2', 'run-2', () => new Date('2026-01-01T00:00:00.000Z'));
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const event = recorder.record({ eventType: 'tool_result', actor: 'tool', parentEventId: null, toolName: 'lookup', arguments: jwt, result: 'ghp_abcdefghijk', stateBeforeRef: null, stateAfterRef: null, errorClass: null, latencyMs: null, tokenUsage: null, costUsd: null, metadata: {} });
    const result = ingestTrace([event], { traceId: 'trace-2', runId: 'run-2' });

    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') expect(JSON.stringify(result.redactedEvents)).not.toContain(jwt);
  });
});
