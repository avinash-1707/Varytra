import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const judgeClassificationSchema = z.enum(['no-material-change', 'suspected-regression', 'inconclusive']);

export const judgeResponseSchema = z.object({
  classification: judgeClassificationSchema,
  severity: z.enum(['medium', 'high']),
  confidence: z.number().finite().min(0).max(1),
  evidenceIds: z.array(z.string().regex(/^(baseline|candidate):[1-9][0-9]*$/)).max(16),
  rationale: z.string().min(1).max(2_000),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().finite().nonnegative(),
  }).strict(),
}).strict();

export type JudgeResponse = z.infer<typeof judgeResponseSchema>;

export const runDispatchSchema = z.object({
  organizationId: z.uuid(),
  runId: z.uuid(),
  dispatchId: z.uuid(),
});

export type RunDispatch = z.infer<typeof runDispatchSchema>;

export const traceSchemaVersion = '1.0' as const;

const traceIdSchema = z.string().min(1).max(128);
const traceContentSchema = z.string().max(32_768);

export const traceEventTypeSchema = z.enum([
  'agent_message',
  'model_call',
  'tool_call',
  'tool_result',
  'state_snapshot',
  'policy_event',
  'error',
  'final_outcome',
]);

export const traceEventSchema = z.object({
  traceId: traceIdSchema,
  runId: traceIdSchema,
  eventId: traceIdSchema,
  sequenceNo: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  eventType: traceEventTypeSchema,
  actor: z.string().min(1).max(128),
  parentEventId: traceIdSchema.nullable(),
  toolName: z.string().min(1).max(128).nullable(),
  arguments: traceContentSchema.nullable(),
  result: traceContentSchema.nullable(),
  stateBeforeRef: traceIdSchema.nullable(),
  stateAfterRef: traceIdSchema.nullable(),
  errorClass: z.string().min(1).max(128).nullable(),
  latencyMs: z.number().finite().nonnegative().nullable(),
  tokenUsage: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
  metadata: z.record(z.string(), z.string().max(1_024)),
  schemaVersion: z.literal(traceSchemaVersion),
});

export type TraceEvent = z.infer<typeof traceEventSchema>;

export const redactedTraceEventSchema = traceEventSchema.omit({
  arguments: true,
  result: true,
}).extend({
  argumentsRedacted: traceContentSchema.nullable(),
  resultSummaryRedacted: traceContentSchema.nullable(),
});

export type RedactedTraceEvent = z.infer<typeof redactedTraceEventSchema>;

export type TraceEventInput = Omit<TraceEvent, 'eventId' | 'observedAt' | 'sequenceNo' | 'traceId' | 'runId' | 'schemaVersion'>;

export interface TraceRecorder {
  readonly record: (event: TraceEventInput) => TraceEvent;
  readonly events: () => readonly TraceEvent[];
}

export interface TraceIngestionIdentity {
  readonly traceId: string;
  readonly runId: string;
}

export function createTraceRecorder(traceId: string, runId: string, now: () => Date = () => new Date()): TraceRecorder {
  const events: TraceEvent[] = [];

  return {
    record(event): TraceEvent {
      const sequenceNo = events.length + 1;
      const recorded = traceEventSchema.parse({
        ...event,
        traceId,
        runId,
        eventId: `${traceId}:${sequenceNo}`,
        sequenceNo,
        observedAt: now().toISOString(),
        schemaVersion: traceSchemaVersion,
      });
      events.push(recorded);
      return recorded;
    },
    events: () => events,
  };
}

const secretKeyPattern = /(?:api[-_]?key|authorization|bearer|cookie|password|secret|token)/i;
const secretValuePattern = /(?:bearer\s+|api[-_]?key\s*[=:]|password\s*[=:]|(?:access[-_]?|id[-_]?)?token\s*[=:]|sk-[a-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[a-z0-9_]{8,}|akia[0-9a-z]{16}|eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|-----begin [a-z ]*private key-----)/i;

function redactContent(content: string | null): string | null {
  if (content === null) return null;
  return secretValuePattern.test(content) ? '[REDACTED_SECRET]' : '[REDACTED]';
}

function hasRestrictedContent(event: TraceEvent): boolean {
  return secretValuePattern.test(event.arguments ?? '')
    || secretValuePattern.test(event.result ?? '')
    || Object.entries(event.metadata).some(([key, value]) => secretKeyPattern.test(key) || secretValuePattern.test(value));
}

function scrubSecrets(event: TraceEvent): TraceEvent {
  const metadata = Object.fromEntries(Object.entries(event.metadata).map(([key, value]) => [key, secretKeyPattern.test(key) || secretValuePattern.test(value) ? '[REDACTED_SECRET]' : value]));
  return {
    ...event,
    arguments: secretValuePattern.test(event.arguments ?? '') ? '[REDACTED_SECRET]' : event.arguments,
    result: secretValuePattern.test(event.result ?? '') ? '[REDACTED_SECRET]' : event.result,
    metadata,
  };
}

export type TraceIngestionResult =
  | { readonly status: 'accepted'; readonly rawEvents: readonly TraceEvent[]; readonly redactedEvents: readonly RedactedTraceEvent[]; readonly restrictedFieldDetected: boolean }
  | { readonly status: 'rejected'; readonly reason: 'malformed_trace' | 'oversized_trace' | 'invalid_sequence' };

export function ingestTrace(input: unknown, identity: TraceIngestionIdentity, maxEvents = 1_000, maxBytes = 1_000_000): TraceIngestionResult {
  if (!Array.isArray(input)) return { status: 'rejected', reason: 'malformed_trace' };
  if (input.length > maxEvents || new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes) return { status: 'rejected', reason: 'oversized_trace' };

  const parsed = z.array(traceEventSchema).safeParse(input);
  if (!parsed.success) return { status: 'rejected', reason: 'malformed_trace' };
  if (parsed.data[0]?.sequenceNo !== 1 || parsed.data.some((event, index) => index > 0 && event.sequenceNo !== parsed.data[index - 1]!.sequenceNo + 1)) return { status: 'rejected', reason: 'invalid_sequence' };
  if (parsed.data.some((event) => event.traceId !== identity.traceId || event.runId !== identity.runId) || new Set(parsed.data.map((event) => event.eventId)).size !== parsed.data.length) return { status: 'rejected', reason: 'malformed_trace' };

  const restrictedFieldDetected = parsed.data.some(hasRestrictedContent);
  const rawEvents = parsed.data.map(scrubSecrets);
  const redactedEvents = parsed.data.map((event) => redactedTraceEventSchema.parse({
    ...event,
    argumentsRedacted: redactContent(event.arguments),
    resultSummaryRedacted: redactContent(event.result),
  }));
  return { status: 'accepted', rawEvents, redactedEvents, restrictedFieldDetected };
}
