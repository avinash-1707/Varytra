import { describe, expect, it } from 'vitest';

import { getProjectRequestState, getProjectStateContent, parseProjectsResponse } from '../apps/web/src/app';

describe('project workspace response helpers', () => {
  it('accepts both supported project-list response shapes and retains safe display fields', () => {
    expect(parseProjectsResponse([
      { id: 'project_001', name: 'Refund safeguard', description: 'Can the candidate issue an unsafe refund?', updated_at: '2026-09-08T12:00:00.000Z' },
    ])).toEqual([
      {
        id: 'project_001',
        name: 'Refund safeguard',
        description: 'Can the candidate issue an unsafe refund?',
        updatedAt: '2026-09-08T12:00:00.000Z',
      },
    ]);

    expect(parseProjectsResponse({ projects: [{ id: 'project_002', name: 'Support workflow' }] })).toEqual([
      { id: 'project_002', name: 'Support workflow', description: null, updatedAt: null },
    ]);
  });

  it('rejects malformed project lists and maps only forbidden requests to permission state', () => {
    expect(() => parseProjectsResponse({ projects: [{ id: 'project_003' }] })).toThrow(TypeError);
    expect(getProjectRequestState(403)).toBe('permission');
    expect(getProjectRequestState(500)).toBe('error');
  });

  it('defines explicit empty, error, and permission UI content without project disclosure', () => {
    expect(getProjectStateContent('empty').heading).toBe('No projects in this workspace');
    expect(getProjectStateContent('error').heading).toContain('could not be loaded');
    const permission = getProjectStateContent('permission');
    expect(permission.heading).toContain('do not have access');
    expect(permission.body).not.toContain('Refund safeguard');
  });
});
