import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@varytra/schemas';

describe('workspace', () => {
  it('keeps shared schemas browser-safe', () => {
    expect(healthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
  });
});
