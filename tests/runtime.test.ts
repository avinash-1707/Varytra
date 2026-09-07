import { describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { processNoopJob } from '../apps/worker/src/noop-job.js';
import { healthResponseSchema } from '@varytra/schemas';
import { createLogger } from '@varytra/runtime';

describe('runtime foundation', () => {
  it('serves the health endpoint', async () => {
    const logOutput: string[] = [];
    const app = buildApp({ logger: createLogger({ write: (line) => logOutput.push(line) }) });

    const response = await app.inject({
      method: 'GET',
      url: '/health?token=sentinel-secret',
      headers: { 'x-request-id': 'client-controlled-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();
    expect(healthResponseSchema.parse(response.json())).toEqual({ status: 'ok' });
    expect(logOutput.some((line) => line.includes('"event":"health.checked"') && line.includes('"request_id":"req-1"'))).toBe(true);
    expect(logOutput.join('')).not.toContain('sentinel-secret');
    expect(logOutput.join('')).not.toContain('client-controlled-secret');
    await app.close();
  });

  it('processes a no-op worker job', async () => {
    await expect(processNoopJob()).resolves.toEqual({ status: 'processed' });
  });
});
