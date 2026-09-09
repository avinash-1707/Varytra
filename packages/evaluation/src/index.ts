import type { AlignmentResult, DivergenceSegment } from '@varytra/alignment';

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
