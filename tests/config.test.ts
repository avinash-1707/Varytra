import { describe, expect, it } from 'vitest';
import { RuntimeConfigError, loadRuntimeConfig } from '@varytra/runtime';

describe('runtime configuration', () => {
  it('fails closed when required configuration is missing', () => {
    expect(() => loadRuntimeConfig({})).toThrow(RuntimeConfigError);
    expect(() => loadRuntimeConfig({})).toThrow('NODE_ENV, SERVICE_NAME');
  });

  it('rejects malformed configuration without including supplied values', () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: 'production',
      SERVICE_NAME: 'api',
      PORT: 'not-a-port',
    })).toThrow('PORT');
  });

  it('returns typed defaults for valid configuration', () => {
    expect(loadRuntimeConfig({ NODE_ENV: 'test', SERVICE_NAME: 'varytra-api' })).toEqual({
      nodeEnv: 'test',
      serviceName: 'varytra-api',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
    });
  });
});
