import type { NormalizedTraceEvent } from '@varytra/normalization';

export const alignmentVersion = '1.0' as const;

export interface AlignmentOptions {
  readonly contextEvents: number;
  readonly maxCells: number;
  readonly maxEventsPerTrace: number;
  readonly maxSegmentEvents: number;
}

export interface DivergenceSegment {
  readonly baselineContext: readonly NormalizedTraceEvent[];
  readonly baselineSequenceRange: readonly [number, number] | null;
  readonly candidateContext: readonly NormalizedTraceEvent[];
  readonly candidateSequenceRange: readonly [number, number] | null;
  readonly score: number;
}

export type AlignmentResult =
  | { readonly status: 'complete'; readonly score: number; readonly firstMaterialDivergence: DivergenceSegment | null }
  | { readonly status: 'inconclusive'; readonly reason: 'alignment_budget_exceeded' | 'divergence_segment_too_large' | 'trace_limit_exceeded'; readonly partialDivergence: DivergenceSegment | null };

const defaultOptions: AlignmentOptions = { contextEvents: 2, maxCells: 65_536, maxEventsPerTrace: 256, maxSegmentEvents: 12 };

function eventCost(event: NormalizedTraceEvent): number {
  if (event.eventType === 'policy_event') return 12;
  if (event.eventType === 'error') return 10;
  if (event.eventType === 'final_outcome' || event.stateBeforeRef !== event.stateAfterRef) return 8;
  if (event.eventType === 'tool_call' || event.eventType === 'tool_result') return 4;
  return 1;
}

function eventsMatch(left: NormalizedTraceEvent, right: NormalizedTraceEvent): boolean {
  return left.eventType === right.eventType && left.actor === right.actor && left.toolName === right.toolName
    && left.argumentsRedacted === right.argumentsRedacted && left.resultSummaryRedacted === right.resultSummaryRedacted
    && left.errorClass === right.errorClass && left.stateBeforeRef === right.stateBeforeRef && left.stateAfterRef === right.stateAfterRef
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}

function segment(baseline: readonly NormalizedTraceEvent[], candidate: readonly NormalizedTraceEvent[], baselineStart: number, baselineEnd: number, candidateStart: number, candidateEnd: number, contextEvents: number, score: number): DivergenceSegment {
  const baselineRange = baselineStart === baselineEnd ? null : [baseline[baselineStart]!.sequenceNo, baseline[baselineEnd - 1]!.sequenceNo] as const;
  const candidateRange = candidateStart === candidateEnd ? null : [candidate[candidateStart]!.sequenceNo, candidate[candidateEnd - 1]!.sequenceNo] as const;
  return {
    baselineContext: baseline.slice(Math.max(0, baselineStart - contextEvents), Math.min(baseline.length, baselineEnd + contextEvents)),
    baselineSequenceRange: baselineRange,
    candidateContext: candidate.slice(Math.max(0, candidateStart - contextEvents), Math.min(candidate.length, candidateEnd + contextEvents)),
    candidateSequenceRange: candidateRange,
    score,
  };
}

export function alignTraces(baseline: readonly NormalizedTraceEvent[], candidate: readonly NormalizedTraceEvent[], overrides: Partial<AlignmentOptions> = {}): AlignmentResult {
  const options = { ...defaultOptions, ...overrides };
  if (baseline.length > options.maxEventsPerTrace || candidate.length > options.maxEventsPerTrace) return { status: 'inconclusive', reason: 'trace_limit_exceeded', partialDivergence: null };
  if ((baseline.length + 1) * (candidate.length + 1) > options.maxCells) return { status: 'inconclusive', reason: 'alignment_budget_exceeded', partialDivergence: null };

  const costs = Array.from({ length: baseline.length + 1 }, () => Array<number>(candidate.length + 1).fill(0));
  for (let baselineIndex = 1; baselineIndex <= baseline.length; baselineIndex += 1) costs[baselineIndex]![0] = costs[baselineIndex - 1]![0]! + eventCost(baseline[baselineIndex - 1]!);
  for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) costs[0]![candidateIndex] = costs[0]![candidateIndex - 1]! + eventCost(candidate[candidateIndex - 1]!);
  for (let baselineIndex = 1; baselineIndex <= baseline.length; baselineIndex += 1) {
    for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
      const left = baseline[baselineIndex - 1]!;
      const right = candidate[candidateIndex - 1]!;
      const diagonal = costs[baselineIndex - 1]![candidateIndex - 1]! + (eventsMatch(left, right) ? 0 : Math.max(eventCost(left), eventCost(right)));
      const deletion = costs[baselineIndex - 1]![candidateIndex]! + eventCost(left);
      const insertion = costs[baselineIndex]![candidateIndex - 1]! + eventCost(right);
      costs[baselineIndex]![candidateIndex] = Math.min(diagonal, deletion, insertion);
    }
  }

  let baselineIndex = baseline.length;
  let candidateIndex = candidate.length;
  let first: DivergenceSegment | null = null;
  while (baselineIndex > 0 || candidateIndex > 0) {
    const current = costs[baselineIndex]![candidateIndex]!;
    const left = baseline[baselineIndex - 1];
    const right = candidate[candidateIndex - 1];
    if (left !== undefined && right !== undefined && current === costs[baselineIndex - 1]![candidateIndex - 1]! + (eventsMatch(left, right) ? 0 : Math.max(eventCost(left), eventCost(right)))) {
      if (!eventsMatch(left, right)) first = segment(baseline, candidate, baselineIndex - 1, baselineIndex, candidateIndex - 1, candidateIndex, options.contextEvents, Math.max(eventCost(left), eventCost(right)));
      baselineIndex -= 1; candidateIndex -= 1; continue;
    }
    if (left !== undefined && current === costs[baselineIndex - 1]![candidateIndex]! + eventCost(left)) {
      first = segment(baseline, candidate, baselineIndex - 1, baselineIndex, candidateIndex, candidateIndex, options.contextEvents, eventCost(left)); baselineIndex -= 1; continue;
    }
    if (right !== undefined) {
      first = segment(baseline, candidate, baselineIndex, baselineIndex, candidateIndex - 1, candidateIndex, options.contextEvents, eventCost(right)); candidateIndex -= 1;
    }
  }
  if (first !== null && first.baselineContext.length + first.candidateContext.length > options.maxSegmentEvents + options.contextEvents * 2) return { status: 'inconclusive', reason: 'divergence_segment_too_large', partialDivergence: first };
  return { status: 'complete', score: costs[baseline.length]![candidate.length]!, firstMaterialDivergence: first };
}
