import { describe, expect, it } from 'vitest';
import { AuthorizationError, requireCapability } from '../apps/api/src/authorization.js';

describe('authorization', () => {
  it('enforces every role capability and denial path', () => {
    const allowed = {
      owner: ['members:read', 'members:write', 'projects:read', 'projects:create', 'projects:update', 'projects:delete', 'api_keys:create', 'api_keys:manage_any', 'api_keys:manage_own', 'audit:read'],
      admin: ['members:read', 'members:write', 'projects:read', 'projects:create', 'projects:update', 'projects:delete', 'api_keys:create', 'api_keys:manage_any', 'api_keys:manage_own', 'audit:read'],
      editor: ['projects:read', 'projects:create', 'projects:update', 'api_keys:create', 'api_keys:manage_own'],
      viewer: ['projects:read'],
    } as const;
    const capabilities = ['members:read', 'members:write', 'projects:read', 'projects:create', 'projects:update', 'projects:delete', 'api_keys:create', 'api_keys:manage_any', 'api_keys:manage_own', 'audit:read'] as const;

    for (const [role, permitted] of Object.entries(allowed) as [keyof typeof allowed, readonly (typeof capabilities)[number]][]) {
      for (const capability of capabilities) {
        const assertion = () => requireCapability(role, capability);
        if (permitted.includes(capability)) expect(assertion).not.toThrow();
        else expect(assertion).toThrow(AuthorizationError);
      }
    }
  });
});
