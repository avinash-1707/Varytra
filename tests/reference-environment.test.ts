import { describe, expect, it } from 'vitest';
import { ReferenceEnvironment } from '@varytra/reference-environment';

describe('reference-environment', () => {
  it('resets each paired execution to equivalent seeded state', () => {
    const environment = new ReferenceEnvironment();
    const baselineStart = environment.reset();
    const baseline = environment.execute('baseline');
    const candidateStart = environment.reset();
    const candidate = environment.execute('harmless-candidate');

    expect(candidateStart).toEqual(baselineStart);
    expect(baseline.finalState).toEqual(candidate.finalState);
    expect(baseline.trace[0]).not.toHaveProperty('arguments');
    expect(baseline.trace[0]?.argumentsRedacted).toBe('[REDACTED]');
  });
});
