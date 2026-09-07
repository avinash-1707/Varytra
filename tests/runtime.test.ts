import { describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { processNoopJob } from '../apps/worker/src/noop-job.js';
import { healthResponseSchema } from '@varytra/schemas';

describe('runtime foundation', () => {
  it('serves the health endpoint', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual({ status: 'ok' });
    await app.close();
  });

  it('processes a no-op worker job', async () => {
    await expect(processNoopJob()).resolves.toEqual({ status: 'processed' });
  });
});
