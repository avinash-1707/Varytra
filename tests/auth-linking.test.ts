import { describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';

describe('auth linking', () => {
  it('rejects social linking without a recently reauthenticated session', async () => {
    let handled = false;
    const app = buildApp({
      auth: {
        handler: async () => {
          handled = true;
          return new Response(null, { status: 200 });
        },
        isRecentSession: async () => false,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/link-social',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'google' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'reauthentication_required' });
    expect(handled).toBe(false);
    await app.close();
  });

  it('forwards a fresh linking request and preserves auth cookies', async () => {
    let handled = false;
    const app = buildApp({
      auth: {
        handler: async () => {
          handled = true;
          return new Response(JSON.stringify({ redirect: false, url: 'https://accounts.google.com' }), {
            headers: { 'set-cookie': 'better-auth.session_token=fresh; HttpOnly; Path=/' },
            status: 200,
          });
        },
        isRecentSession: async () => true,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/link-social',
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'google' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('better-auth.session_token=fresh');
    expect(handled).toBe(true);
    await app.close();
  });
});
