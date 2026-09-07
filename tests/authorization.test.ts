import { describe, expect, it } from 'vitest';
import { AuthorizationError, requireCapability } from '../apps/api/src/authorization.js';

describe('authorization', () => {
  it('enforces every role capability and denial path', () => {
    expect(() => requireCapability('owner', 'members:write')).not.toThrow();
    expect(() => requireCapability('admin', 'audit:read')).not.toThrow();
    expect(() => requireCapability('editor', 'api_keys:manage_own')).not.toThrow();
    expect(() => requireCapability('viewer', 'members:read')).toThrow(AuthorizationError);
    expect(() => requireCapability('editor', 'members:write')).toThrow(AuthorizationError);
  });
});
