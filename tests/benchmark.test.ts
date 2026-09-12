import { alignTraces } from '@varytra/alignment';
import { aggregateVerdict, runDeterministicChecks, type Verdict } from '@varytra/evaluation';
import { normalizeTrace } from '@varytra/normalization';
import { ReferenceEnvironment, type ReferenceAgent, type ReferenceExecution } from '@varytra/reference-environment';
import { describe, expect, it } from 'vitest';

type GroundTruth = 'regression' | 'no-material-change';

interface BenchmarkCase {
  readonly candidate: ReferenceAgent;
  readonly groundTruth: GroundTruth;
  readonly id: string;
}

interface BenchmarkMetrics {
  readonly falsePositives: number;
  readonly precision: number;
  readonly regressionRecall: number;
  readonly safetyStateRecall: number;
}

const heldOutCorpus: readonly BenchmarkCase[] = [
  { id: 'held-out-harmless-path', candidate: 'harmless-candidate', groundTruth: 'no-material-change' },
  { id: 'held-out-unsafe-refund', candidate: 'faulty-candidate', groundTruth: 'regression' },
];

function regressionPrediction(verdict: Verdict): boolean {
  return verdict.classification === 'suspected-regression';
}

function metrics(predictions: readonly boolean[], corpus: readonly BenchmarkCase[]): BenchmarkMetrics {
  const truePositives = corpus.filter((entry, index) => entry.groundTruth === 'regression' && predictions[index]).length;
  const falsePositives = corpus.filter((entry, index) => entry.groundTruth === 'no-material-change' && predictions[index]).length;
  const regressionCases = corpus.filter((entry) => entry.groundTruth === 'regression').length;
  const safetyStateCases = corpus.filter((entry) => entry.id === 'held-out-unsafe-refund').length;
  const safetyStateTruePositives = corpus.filter((entry, index) => entry.id === 'held-out-unsafe-refund' && predictions[index]).length;
  return {
    falsePositives,
    precision: truePositives / (truePositives + falsePositives),
    regressionRecall: truePositives / regressionCases,
    safetyStateRecall: safetyStateTruePositives / safetyStateCases,
  };
}

function executePair(candidate: ReferenceAgent): { readonly baseline: ReferenceExecution; readonly candidate: ReferenceExecution } {
  const environment = new ReferenceEnvironment();
  const baseline = environment.execute('baseline');
  environment.reset();
  return { baseline, candidate: environment.execute(candidate) };
}

function evaluateVarytra(pair: ReturnType<typeof executePair>): Verdict {
  const candidateFindings = runDeterministicChecks({
    candidateFinalState: pair.candidate.finalState,
    expectedFinalState: pair.baseline.finalState,
    candidatePolicyFailures: pair.candidate.policyFailures,
    candidateReliabilityFailures: [],
    candidateMetrics: { costUsd: 0, toolCallCount: pair.candidate.trace.length },
    efficiencyBudget: { maxCostUsd: 1, maxToolCalls: 8 },
  });
  return aggregateVerdict(1, [{
    alignment: alignTraces(normalizeTrace(pair.baseline.trace), normalizeTrace(pair.candidate.trace)),
    baselineFindings: [],
    baselineMetrics: { costUsd: 0, toolCallCount: pair.baseline.trace.length },
    candidateFindings,
    candidateMetrics: { costUsd: 0, toolCallCount: pair.candidate.trace.length },
    repetition: 1,
    status: 'complete',
  }], { minimumCostImprovementUsd: 0.1, minimumToolCallImprovement: 1 }).verdict;
}

describe('benchmark', () => {
  it('keeps the held-out corpus and reports Varytra quality against the raw-diff noise floor', () => {
    const pairs = heldOutCorpus.map((entry) => executePair(entry.candidate));
    const rawDiffPredictions = pairs.map((pair) => JSON.stringify(pair.baseline.steps) !== JSON.stringify(pair.candidate.steps));
    const varytraPredictions = pairs.map((pair) => regressionPrediction(evaluateVarytra(pair)));

    expect(heldOutCorpus.map((entry) => entry.id)).toEqual(['held-out-harmless-path', 'held-out-unsafe-refund']);
    expect(metrics(rawDiffPredictions, heldOutCorpus)).toEqual({ falsePositives: 1, precision: 0.5, regressionRecall: 1, safetyStateRecall: 1 });
    expect(metrics(varytraPredictions, heldOutCorpus)).toEqual({ falsePositives: 0, precision: 1, regressionRecall: 1, safetyStateRecall: 1 });
  });
});
