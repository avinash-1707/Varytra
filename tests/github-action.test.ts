import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('repository-local CI action', () => {
  it('uses scoped inputs and exposes only opaque identifiers', async () => {
    const action = await readFile(new URL('../.github/actions/varytra-gate/action.yml', import.meta.url), 'utf8');
    expect(action).toContain('Authorization: Bearer $VARYTRA_API_KEY');
    expect(action).toContain('ci-run-id');
    expect(action).toContain('batch-id');
    expect(action).not.toMatch(/trace|artifact|payload/i);
  });
});
