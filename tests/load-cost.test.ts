import { performance } from 'node:perf_hooks';
import { ReferenceEnvironment } from '@varytra/reference-environment';
import { describe, expect, it } from 'vitest';

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1] ?? 0;
}

describe('load-cost', () => {
  it('keeps a representative 10-scenario by 10-repetition reference batch bounded', () => {
    const durations: number[] = [];
    let toolCalls = 0;
    for (let scenario = 0; scenario < 10; scenario += 1) {
      for (let repetition = 0; repetition < 10; repetition += 1) {
        const environment = new ReferenceEnvironment();
        const startedAt = performance.now();
        const baseline = environment.execute('baseline');
        environment.reset();
        const candidate = environment.execute(scenario % 2 === 0 ? 'harmless-candidate' : 'faulty-candidate');
        durations.push(performance.now() - startedAt);
        toolCalls += baseline.trace.length + candidate.trace.length;
      }
    }

    expect(durations).toHaveLength(100);
    expect(percentile(durations, 0.5)).toBeLessThan(100);
    expect(percentile(durations, 0.95)).toBeLessThan(500);
    expect(toolCalls).toBeGreaterThan(0);
  });
});
