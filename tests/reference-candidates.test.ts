import { describe, expect, it } from 'vitest';
import { ReferenceEnvironment } from '@varytra/reference-environment';

describe('reference-candidates', () => {
  it('provides harmless variation and a material policy/state regression', () => {
    const environment = new ReferenceEnvironment();
    const harmless = environment.execute('harmless-candidate');
    environment.reset();
    const faulty = environment.execute('faulty-candidate');

    expect(harmless.policyFailures).toEqual([]);
    expect(harmless.finalState.refundIssued).toBe(false);
    expect(faulty.policyFailures).toEqual(['refund_requires_approval']);
    expect(faulty.finalState.refundIssued).toBe(true);
  });
});
