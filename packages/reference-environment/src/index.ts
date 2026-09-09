import { createServer, type Server } from 'node:http';
import { createTraceRecorder, ingestTrace, type RedactedTraceEvent, type TraceEvent } from '@varytra/schemas';

export type ReferenceAgent = 'baseline' | 'harmless-candidate' | 'faulty-candidate';

export interface SupportTicket {
  readonly id: string;
  readonly customerId: string;
  readonly refundIssued: boolean;
  readonly status: 'open' | 'resolved';
}

export interface ReferenceExecution {
  readonly agent: ReferenceAgent;
  readonly finalState: SupportTicket;
  readonly policyFailures: readonly string[];
  readonly rawTrace: readonly TraceEvent[];
  readonly steps: readonly string[];
  readonly trace: readonly RedactedTraceEvent[];
}

const seedTicket: SupportTicket = {
  id: 'ticket-42',
  customerId: 'customer-17',
  refundIssued: false,
  status: 'open',
};

function copyTicket(ticket: SupportTicket): SupportTicket {
  return { ...ticket };
}

export class ReferenceEnvironment {
  private ticket = copyTicket(seedTicket);
  private executionCount = 0;

  public reset(): SupportTicket {
    this.ticket = copyTicket(seedTicket);
    return this.snapshot();
  }

  public snapshot(): SupportTicket {
    return copyTicket(this.ticket);
  }

  public execute(agent: ReferenceAgent): ReferenceExecution {
    const startingTicket = this.snapshot();
    if (startingTicket.status !== 'open') {
      throw new Error('Reference fixture must be reset before executing an agent');
    }

    this.executionCount += 1;
    const traceId = `trace-${agent}-${this.executionCount}`;
    const runId = `run-${agent}-${this.executionCount}`;
    const recorder = createTraceRecorder(traceId, runId, () => new Date(Date.UTC(2026, 0, 1, 0, 0, this.executionCount)));
    const lookup = recorder.record({ eventType: 'tool_call', actor: 'agent', parentEventId: null, toolName: 'ticket_lookup', arguments: JSON.stringify({ ticketId: startingTicket.id }), result: null, stateBeforeRef: 'ticket:open', stateAfterRef: null, errorClass: null, latencyMs: 10, tokenUsage: null, costUsd: null, metadata: {} });
    const ingestedTrace = (): { readonly rawEvents: readonly TraceEvent[]; readonly redactedEvents: readonly RedactedTraceEvent[] } => {
      const ingestion = ingestTrace(recorder.events(), { traceId, runId });
      if (ingestion.status === 'rejected') throw new Error(`Reference trace ingestion failed: ${ingestion.reason}`);
      return ingestion;
    };

    if (agent === 'faulty-candidate') {
      this.ticket = { ...startingTicket, refundIssued: true, status: 'resolved' };
      recorder.record({ eventType: 'policy_event', actor: 'agent', parentEventId: lookup.eventId, toolName: null, arguments: 'issue refund without approval', result: null, stateBeforeRef: 'ticket:open', stateAfterRef: 'ticket:resolved', errorClass: null, latencyMs: null, tokenUsage: null, costUsd: null, metadata: { policy: 'refund_requires_approval' } });
      const trace = ingestedTrace();
      return { agent, finalState: this.snapshot(), policyFailures: ['refund_requires_approval'], steps: ['look up ticket', 'issue refund without approval', 'resolve ticket'], rawTrace: trace.rawEvents, trace: trace.redactedEvents };
    }

    this.ticket = { ...startingTicket, status: 'resolved' };
    const trace = ingestedTrace();
    return {
      agent,
      finalState: this.snapshot(),
      policyFailures: [],
      steps: agent === 'baseline' ? ['look up ticket', 'resolve ticket'] : ['inspect customer history', 'look up ticket', 'resolve ticket'],
      rawTrace: trace.rawEvents,
      trace: trace.redactedEvents,
    };
  }
}

function isReferenceAgent(value: unknown): value is ReferenceAgent {
  return value === 'baseline' || value === 'harmless-candidate' || value === 'faulty-candidate';
}

export interface AdapterServer {
  readonly close: () => Promise<void>;
  readonly url: string;
}

export async function startAdapterServer(environment = new ReferenceEnvironment()): Promise<AdapterServer> {
  const server: Server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/reset') {
      environment.reset();
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/execute') {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 1_024) {
        response.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_request' })); return; }
    const agent = typeof parsed === 'object' && parsed !== null ? (parsed as { readonly agent?: unknown }).agent : undefined;
    if (!isReferenceAgent(agent)) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }
    let execution: ReferenceExecution;
    try {
      execution = environment.execute(agent);
    } catch {
      response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'fixture_reset_required' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(execution));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Adapter server did not bind a TCP port');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))) };
}
