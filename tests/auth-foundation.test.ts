import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../apps/api/src/auth.js';

describe('auth foundation', () => {
  it('fails closed when its database, origin, or secret configuration is absent', () => {
    expect(() => loadAuthConfig({})).toThrow('APP_URL, DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL');
  });

  it('accepts a complete server-only configuration', () => {
    expect(loadAuthConfig({
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
      BETTER_AUTH_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://varytra:varytra@127.0.0.1:5432/varytra',
    })).toEqual({
      appUrl: 'http://localhost:5173',
      baseUrl: 'http://localhost:3000',
      databaseUrl: 'postgres://varytra:varytra@127.0.0.1:5432/varytra',
      secret: '0123456789abcdef0123456789abcdef',
    });
  });

  it('requires both Google OAuth credentials when either is configured', () => {
    expect(() => loadAuthConfig({
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
      BETTER_AUTH_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://varytra:varytra@127.0.0.1:5432/varytra',
      GOOGLE_CLIENT_ID: 'google-client-id',
    })).toThrow('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
  });
});
