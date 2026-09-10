import { createHash } from 'node:crypto';
import type { AlignmentResult, DivergenceSegment } from '@varytra/alignment';
import { judgeResponseSchema, type JudgeResponse } from '@varytra/schemas';
import { judgePromptVersion, localizedJudgeInstructions } from './judge-prompt.js';

export interface EfficiencyBudget {
  readonly maxCostUsd: number;
  readonly maxToolCalls: number;
}

export interface RunMetrics {
  readonly costUsd: number;
  readonly toolCallCount: number;
}

export interface DeterministicCheckInput {
  readonly candidateFinalState: Readonly<Record<string, unknown>>;
  readonly expectedFinalState: Readonly<Record<string, unknown>>;
  readonly candidatePolicyFailures: readonly string[];
  readonly candidateReliabilityFailures: readonly string[];
  readonly candidateMetrics: RunMetrics;
  readonly efficiencyBudget: EfficiencyBudget;
}

export type DeterministicFinding =
  | { readonly category: 'final_state'; readonly severity: 'critical'; readonly expected: Readonly<Record<string, unknown>>; readonly actual: Readonly<Record<string, unknown>> }
  | { readonly category: 'policy'; readonly severity: 'critical'; readonly failures: readonly string[] }
  | { readonly category: 'reliability'; readonly severity: 'high'; readonly failures: readonly string[] }
  | { readonly category: 'efficiency'; readonly severity: 'medium'; readonly exceeded: readonly ('max_cost_usd' | 'max_tool_calls')[] };

function matchesExpectedState(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== 'object' || actual === null || typeof expected !== 'object' || expected === null) return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected)
      && actual.length === expected.length
      && actual.every((value, index) => matchesExpectedState(value, expected[index]));
  }
  const actualRecord = actual as Readonly<Record<string, unknown>>;
  const expectedRecord = expected as Readonly<Record<string, unknown>>;
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && matchesExpectedState(actualRecord[key], expectedRecord[key]));
}

export function runDeterministicChecks(input: DeterministicCheckInput): readonly DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  if (!matchesExpectedState(input.candidateFinalState, input.expectedFinalState)) {
    findings.push({ category: 'final_state', severity: 'critical', expected: input.expectedFinalState, actual: input.candidateFinalState });
  }
  if (input.candidatePolicyFailures.length > 0) {
    findings.push({ category: 'policy', severity: 'critical', failures: input.candidatePolicyFailures });
  }
  if (input.candidateReliabilityFailures.length > 0) {
    findings.push({ category: 'reliability', severity: 'high', failures: input.candidateReliabilityFailures });
  }
  const exceeded: ('max_cost_usd' | 'max_tool_calls')[] = [];
  if (input.candidateMetrics.costUsd > input.efficiencyBudget.maxCostUsd) exceeded.push('max_cost_usd');
  if (input.candidateMetrics.toolCallCount > input.efficiencyBudget.maxToolCalls) exceeded.push('max_tool_calls');
  if (exceeded.length > 0) findings.push({ category: 'efficiency', severity: 'medium', exceeded });
  return findings;
}

export type Verdict =
  | { readonly classification: 'improvement' | 'no-material-change'; readonly confidence: 'high' | 'medium'; readonly severity: 'none' }
  | { readonly classification: 'suspected-regression'; readonly confidence: 'high' | 'medium'; readonly severity: 'critical' | 'high' | 'medium' }
  | { readonly classification: 'inconclusive'; readonly confidence: 'low'; readonly reasons: readonly InconclusiveReason[]; readonly severity: 'unknown' };

export type InconclusiveReason = 'alignment_divergence' | 'alignment_unresolved' | 'baseline_invalid' | 'incomplete_pair' | 'insufficient_coverage';

export interface PairAssessment {
  readonly alignment: AlignmentResult;
  readonly baselineFindings: readonly DeterministicFinding[];
  readonly baselineMetrics: RunMetrics;
  readonly candidateFindings: readonly DeterministicFinding[];
  readonly candidateMetrics: RunMetrics;
  readonly repetition: number;
  readonly status: 'complete' | 'incomplete';
}

export interface VerdictAggregationPolicy {
  readonly minimumCostImprovementUsd: number;
  readonly minimumToolCallImprovement: number;
}

export interface FindingProjection {
  readonly category: DeterministicFinding['category'] | 'trajectory';
  readonly repetition: number;
  readonly severity: 'critical' | 'high' | 'medium';
}

export interface VerdictAssessment {
  readonly classification: Verdict['classification'];
  readonly coverage: Readonly<{ analyzablePairs: number; completePairs: number; expectedPairs: number }>;
  readonly findings: readonly FindingProjection[];
  readonly firstMaterialDivergence: DivergenceSegment | null;
  readonly verdict: Verdict;
}

function findingSeverity(findings: readonly DeterministicFinding[]): 'critical' | 'high' | 'medium' | null {
  if (findings.some((finding) => finding.severity === 'critical')) return 'critical';
  if (findings.some((finding) => finding.severity === 'high')) return 'high';
  if (findings.some((finding) => finding.severity === 'medium')) return 'medium';
  return null;
}

function projectedFindings(pair: PairAssessment): readonly FindingProjection[] {
  const deterministic: FindingProjection[] = pair.candidateFindings.map((finding) => ({ category: finding.category, repetition: pair.repetition, severity: finding.severity }));
  if (pair.alignment.status === 'complete' && pair.alignment.firstMaterialDivergence !== null) deterministic.push({ category: 'trajectory', repetition: pair.repetition, severity: 'medium' });
  return deterministic;
}

export function aggregateVerdict(expectedPairs: number, pairs: readonly PairAssessment[], policy: VerdictAggregationPolicy): VerdictAssessment {
  const completePairs = pairs.filter((pair) => pair.status === 'complete');
  const analyzablePairs = completePairs.filter((pair) => pair.alignment.status === 'complete' && findingSeverity(pair.baselineFindings) === null);
  const findings = pairs.flatMap(projectedFindings);
  const coverage = { expectedPairs, completePairs: completePairs.length, analyzablePairs: analyzablePairs.length };
  const repetitions = new Set(completePairs.map((pair) => pair.repetition));
  const hasCompleteCoverage = expectedPairs > 0 && completePairs.length === expectedPairs && repetitions.size === expectedPairs && Array.from({ length: expectedPairs }, (_, index) => repetitions.has(index + 1)).every(Boolean);
  const decisive = analyzablePairs.find((pair) => findingSeverity(pair.candidateFindings) !== null);
  if (decisive !== undefined) {
    const severity = findingSeverity(decisive.candidateFindings)!;
    const verdict: Verdict = { classification: 'suspected-regression', severity, confidence: severity === 'critical' || hasCompleteCoverage ? 'high' : 'medium' };
    return { classification: verdict.classification, coverage, findings, firstMaterialDivergence: decisive.alignment.status === 'complete' ? decisive.alignment.firstMaterialDivergence : null, verdict };
  }
  const inconclusiveReasons: InconclusiveReason[] = [];
  if (!hasCompleteCoverage) inconclusiveReasons.push('incomplete_pair');
  if (analyzablePairs.length !== completePairs.length) inconclusiveReasons.push('baseline_invalid');
  if (completePairs.some((pair) => pair.alignment.status === 'inconclusive')) inconclusiveReasons.push('alignment_unresolved');
  if (analyzablePairs.some((pair) => pair.alignment.status === 'complete' && pair.alignment.firstMaterialDivergence !== null)) inconclusiveReasons.push('alignment_divergence');
  if (analyzablePairs.length === 0) inconclusiveReasons.push('insufficient_coverage');
  if (inconclusiveReasons.length > 0) {
    const verdict: Verdict = { classification: 'inconclusive', severity: 'unknown', confidence: 'low', reasons: inconclusiveReasons };
    return { classification: verdict.classification, coverage, findings, firstMaterialDivergence: null, verdict };
  }
  const improved = analyzablePairs.every((pair) => pair.candidateMetrics.costUsd <= pair.baselineMetrics.costUsd && pair.candidateMetrics.toolCallCount <= pair.baselineMetrics.toolCallCount)
    && analyzablePairs.some((pair) => pair.baselineMetrics.costUsd - pair.candidateMetrics.costUsd >= policy.minimumCostImprovementUsd || pair.baselineMetrics.toolCallCount - pair.candidateMetrics.toolCallCount >= policy.minimumToolCallImprovement);
  const verdict: Verdict = improved
    ? { classification: 'improvement', severity: 'none', confidence: 'high' }
    : { classification: 'no-material-change', severity: 'none', confidence: 'high' };
  return { classification: verdict.classification, coverage, findings, firstMaterialDivergence: null, verdict };
}

const judgeConfidenceThreshold = 0.75;
const judgeContextEventLimit = 8;
const judgeTextLimit = 1_000;
const judgePolicyLimit = 10;
const judgePolicyTextLimit = 300;
const judgeEventTextLimit = 1_000;
const secretPattern = /(?:bearer\s+|api[-_]?key\s*[=:]|password\s*[=:]|(?:access[-_]?|id[-_]?)?token\s*[=:]|sk-[a-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[a-z0-9_]{8,}|akia[0-9a-z]{16}|eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|-----begin [a-z ]*private key-----)/i;

export interface JudgeContextEvent {
  readonly evidenceId: string;
  readonly eventType: string;
  readonly actor: string;
  readonly toolName: string | null;
  readonly argumentsRedacted: string | null;
  readonly resultSummaryRedacted: string | null;
  readonly errorClass: string | null;
  readonly stateBeforeRef: string | null;
  readonly stateAfterRef: string | null;
}

export interface JudgeContextPacket {
  readonly availableEvidenceIds: readonly string[];
  readonly baselineEvents: readonly JudgeContextEvent[];
  readonly candidateEvents: readonly JudgeContextEvent[];
  readonly deterministicFindings: readonly Readonly<{ category: FindingProjection['category']; severity: FindingProjection['severity'] }> [];
  readonly finalStateSummary: string | null;
  readonly instructions: string;
  readonly policyRequirements: readonly string[];
  readonly promptVersion: typeof judgePromptVersion;
  readonly taskIntent: string;
}

export interface BuildJudgeContextInput {
  readonly deterministicFindings: readonly Readonly<{ category: FindingProjection['category']; severity: FindingProjection['severity'] }> [];
  readonly divergence: DivergenceSegment | null;
  readonly finalStateSummary?: string;
  readonly policyRequirements: readonly string[];
  readonly taskIntent: string;
}

function redactJudgeText(value: string | null): string | null {
  if (value === null) return null;
  return secretPattern.test(value) ? '[REDACTED_SECRET]' : value;
}

function boundedJudgeText(value: string, limit: number): string {
  return (redactJudgeText(value) ?? '').slice(0, limit);
}

function projectJudgeEvent(side: 'baseline' | 'candidate', event: DivergenceSegment['baselineContext'][number]): JudgeContextEvent {
  return {
    evidenceId: `${side}:${event.sequenceNo}`,
    eventType: event.eventType,
    actor: boundedJudgeText(event.actor, 128),
    toolName: event.toolName === null ? null : boundedJudgeText(event.toolName, 128),
    argumentsRedacted: event.argumentsRedacted === null ? null : boundedJudgeText(event.argumentsRedacted, judgeEventTextLimit),
    resultSummaryRedacted: event.resultSummaryRedacted === null ? null : boundedJudgeText(event.resultSummaryRedacted, judgeEventTextLimit),
    errorClass: event.errorClass === null ? null : boundedJudgeText(event.errorClass, 128),
    stateBeforeRef: event.stateBeforeRef === null ? null : boundedJudgeText(event.stateBeforeRef, 128),
    stateAfterRef: event.stateAfterRef === null ? null : boundedJudgeText(event.stateAfterRef, 128),
  };
}

export function buildJudgeContext(input: BuildJudgeContextInput): JudgeContextPacket {
  const baselineEvents = (input.divergence?.baselineContext ?? []).slice(0, judgeContextEventLimit).map((event) => projectJudgeEvent('baseline', event));
  const candidateEvents = (input.divergence?.candidateContext ?? []).slice(0, judgeContextEventLimit).map((event) => projectJudgeEvent('candidate', event));
  return {
    instructions: localizedJudgeInstructions,
    promptVersion: judgePromptVersion,
    taskIntent: boundedJudgeText(input.taskIntent, judgeTextLimit),
    policyRequirements: input.policyRequirements.slice(0, judgePolicyLimit).map((requirement) => boundedJudgeText(requirement, judgePolicyTextLimit)),
    deterministicFindings: input.deterministicFindings,
    finalStateSummary: input.finalStateSummary === undefined ? null : boundedJudgeText(input.finalStateSummary, judgeTextLimit),
    baselineEvents,
    candidateEvents,
    availableEvidenceIds: [...baselineEvents, ...candidateEvents].map((event) => event.evidenceId),
  };
}

export interface JudgeClient {
  readonly model: string;
  readonly evaluate: (context: JudgeContextPacket) => Promise<unknown>;
}

export interface JudgeAttribution {
  readonly cached: boolean;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly latencyMs: number;
  readonly outputTokens: number;
}

export type SemanticJudgeResult =
  | { readonly status: 'complete'; readonly cacheKey: string; readonly response: JudgeResponse; readonly attribution: JudgeAttribution }
  | { readonly status: 'inconclusive'; readonly cacheKey: string; readonly reason: 'low_confidence' | 'malformed' | 'unavailable' };

export interface JudgeResultCache {
  readonly get: (cacheKey: string) => JudgeResponse | undefined;
  readonly set: (cacheKey: string, response: JudgeResponse) => void;
}

export class InMemoryJudgeResultCache implements JudgeResultCache {
  readonly #entries = new Map<string, JudgeResponse>();

  get(cacheKey: string): JudgeResponse | undefined {
    return this.#entries.get(cacheKey);
  }

  set(cacheKey: string, response: JudgeResponse): void {
    this.#entries.set(cacheKey, response);
  }
}

function cacheKey(client: JudgeClient, context: JudgeContextPacket): string {
  return createHash('sha256').update(JSON.stringify({ model: client.model, context })).digest('hex');
}

function completeJudgeResult(cacheKeyValue: string, response: JudgeResponse, attribution: JudgeAttribution): SemanticJudgeResult {
  return { status: 'complete', cacheKey: cacheKeyValue, response: { ...response, rationale: redactJudgeText(response.rationale) ?? '[REDACTED_SECRET]' }, attribution };
}

export async function evaluateLocalizedSemanticJudge(client: JudgeClient, input: BuildJudgeContextInput, cache?: JudgeResultCache): Promise<SemanticJudgeResult> {
  const context = buildJudgeContext(input);
  const cacheKeyValue = cacheKey(client, context);
  const cached = cache?.get(cacheKeyValue);
  if (cached !== undefined) return completeJudgeResult(cacheKeyValue, cached, { cached: true, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });

  const startedAt = performance.now();
  let providerResponse: unknown;
  try {
    providerResponse = await client.evaluate(context);
  } catch {
    return { status: 'inconclusive', cacheKey: cacheKeyValue, reason: 'unavailable' };
  }
  const parsed = judgeResponseSchema.safeParse(providerResponse);
  if (!parsed.success || !parsed.data.evidenceIds.every((evidenceId) => context.availableEvidenceIds.includes(evidenceId))) {
    return { status: 'inconclusive', cacheKey: cacheKeyValue, reason: 'malformed' };
  }
  if (parsed.data.confidence < judgeConfidenceThreshold || parsed.data.classification === 'inconclusive') {
    return { status: 'inconclusive', cacheKey: cacheKeyValue, reason: 'low_confidence' };
  }
  cache?.set(cacheKeyValue, parsed.data);
  return completeJudgeResult(cacheKeyValue, parsed.data, {
    cached: false,
    inputTokens: parsed.data.usage.inputTokens,
    outputTokens: parsed.data.usage.outputTokens,
    costUsd: parsed.data.usage.costUsd,
    latencyMs: Math.round(performance.now() - startedAt),
  });
}

export function combineDeterministicAndSemanticVerdict(deterministic: VerdictAssessment, semanticResults: readonly SemanticJudgeResult[]): VerdictAssessment {
  if (deterministic.verdict.classification === 'suspected-regression' || deterministic.verdict.classification !== 'inconclusive') return deterministic;
  if (deterministic.verdict.reasons.some((reason) => reason !== 'alignment_divergence')) return deterministic;
  const completeResults = semanticResults.filter((result): result is Extract<SemanticJudgeResult, { readonly status: 'complete' }> => result.status === 'complete');
  if (completeResults.length === 0 || completeResults.length !== semanticResults.length) return deterministic;
  const responses = completeResults.map((result) => result.response);
  const classifications = new Set(responses.map((response) => response.classification));
  if (classifications.size !== 1) return deterministic;
  const confidence = responses.every((response) => response.confidence >= 0.9) ? 'high' : 'medium';
  const classification = responses[0]!.classification;
  if (classification === 'no-material-change') {
    return { ...deterministic, classification, verdict: { classification, severity: 'none', confidence } };
  }
  if (classification === 'suspected-regression') {
    const severity = responses.some((response) => response.severity === 'high') ? 'high' : 'medium';
    return { ...deterministic, classification, verdict: { classification, severity, confidence } };
  }
  return deterministic;
}
