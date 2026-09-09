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
