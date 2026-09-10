import { describe, expect, it } from 'vitest';
import { toCiGateStatus } from '../apps/api/src/ci-runs.js';

describe('CI gate policy', () => {
  it('never converts a critical block into a pass and preserves inconclusive warning', () => {
    expect(toCiGateStatus('completed', 'block')).toBe('fail');
    expect(toCiGateStatus('completed', 'review')).toBe('warn');
    expect(toCiGateStatus('completed', null)).toBe('warn');
    expect(toCiGateStatus('running', null)).toBe('pending');
  });
});
