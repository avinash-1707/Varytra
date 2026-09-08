import { afterEach, describe, expect, it } from 'vitest';
import { startAdapterServer, type AdapterServer } from '@varytra/reference-environment';

describe('adapter-server', () => {
  let server: AdapterServer | undefined;

  afterEach(async () => server?.close());

  it('accepts only controlled agent execution and reset requests', async () => {
    server = await startAdapterServer();
    const invalid = await fetch(`${server.url}/execute`, { method: 'POST', body: JSON.stringify({ agent: 'arbitrary-url' }) });
    expect(invalid.status).toBe(400);

    const baseline = await fetch(`${server.url}/execute`, { method: 'POST', body: JSON.stringify({ agent: 'baseline' }) });
    expect(baseline.status).toBe(200);
    expect((await baseline.json() as { readonly finalState: { readonly status: string } }).finalState.status).toBe('resolved');

    const blocked = await fetch(`${server.url}/execute`, { method: 'POST', body: JSON.stringify({ agent: 'baseline' }) });
    expect(blocked.status).toBe(409);
    expect((await fetch(`${server.url}/reset`, { method: 'POST' })).status).toBe(204);
  });
});
