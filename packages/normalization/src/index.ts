import type { RedactedTraceEvent } from '@varytra/schemas';

export const normalizationVersion = '1.0' as const;

export interface NormalizationRules {
  readonly ignoredMetadataKeys: readonly string[];
  readonly ignoredToolArgumentKeys: readonly string[];
}

export interface NormalizedTraceEvent {
  readonly eventType: RedactedTraceEvent['eventType'];
  readonly actor: string;
  readonly toolName: string | null;
  readonly argumentsRedacted: string | null;
  readonly resultSummaryRedacted: string | null;
  readonly sequenceNo: number;
  readonly errorClass: string | null;
  readonly stateAfterRef: string | null;
  readonly stateBeforeRef: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export const defaultNormalizationRules: NormalizationRules = {
  ignoredMetadataKeys: ['request_id', 'timestamp'],
  ignoredToolArgumentKeys: ['request_id'],
};

const volatileFieldNames = new Set(['request_id', 'timestamp']);

function isSafeToIgnore(key: string, ignoredKeys: readonly string[]): boolean {
  return ignoredKeys.includes(key) && volatileFieldNames.has(key);
}

function normalizeRedactedContent(content: string | null, ignoredKeys: readonly string[]): string | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return content;
    const normalized = Object.fromEntries(Object.entries(parsed).filter(([key]) => !isSafeToIgnore(key, ignoredKeys)).sort(([left], [right]) => left.localeCompare(right)));
    return JSON.stringify(normalized);
  } catch {
    return content;
  }
}

export function normalizeTrace(events: readonly RedactedTraceEvent[], rules: NormalizationRules = defaultNormalizationRules): readonly NormalizedTraceEvent[] {
  return events.map((event) => ({
    eventType: event.eventType,
    actor: event.actor,
    toolName: event.toolName,
    argumentsRedacted: normalizeRedactedContent(event.argumentsRedacted, rules.ignoredToolArgumentKeys),
    resultSummaryRedacted: event.resultSummaryRedacted,
    sequenceNo: event.sequenceNo,
    errorClass: event.errorClass,
    stateAfterRef: event.stateAfterRef,
    stateBeforeRef: event.stateBeforeRef,
    metadata: Object.fromEntries(Object.entries(event.metadata).filter(([key]) => !isSafeToIgnore(key, rules.ignoredMetadataKeys)).sort(([left], [right]) => left.localeCompare(right))),
  }));
}
