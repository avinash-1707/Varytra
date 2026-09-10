import { describe, expect, it } from 'vitest';
import { parseArguments } from '../apps/cli/src/main.js';

describe('CI CLI arguments', () => {
  it('accepts stable flag pairs and rejects incomplete flags', () => {
    expect(parseArguments(['--api-url', 'https://varytra.test', '--api-key', 'vtr_test'])).toEqual({ 'api-url': 'https://varytra.test', 'api-key': 'vtr_test' });
    expect(() => parseArguments(['--api-url'])).toThrow('Arguments must use');
  });
});
