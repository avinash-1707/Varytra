import { createTraceRecorder, ingestTrace } from '@varytra/schemas';
import { createLogger, runWithLogContext } from '@varytra/runtime';
import { describe, expect, it } from 'vitest';

describe('security-regression', () => {
  it('keeps credentials out of trace persistence and structured logs', () => {
    const trace = createTraceRecorder('trace-security', 'run-security');
    trace.record({ eventType: 'tool_call', actor: 'agent', parentEventId: null, toolName: 'refund', arguments: 'Bearer launch-secret', result: 'password=launch-secret', stateBeforeRef: null, stateAfterRef: null, errorClass: null, latencyMs: null, tokenUsage: null, costUsd: null, metadata: {} });
    const ingested = ingestTrace(trace.events(), { traceId: 'trace-security', runId: 'run-security' });
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
    runWithLogContext({ request_id: 'security-check' }, () => logger.error('provider.request.failed', { raw_payload: 'launch-secret' }));

    expect(ingested.status).toBe('accepted');
    expect(JSON.stringify(ingested)).not.toContain('launch-secret');
    expect(lines.join('\n')).not.toContain('launch-secret');
  });
});
