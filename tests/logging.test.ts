import { describe, expect, it } from 'vitest';
import { createLogger, runWithLogContext, serializeError } from '@varytra/runtime';

describe('structured logging', () => {
  it('correlates requests while excluding secret-bearing fields and error content', () => {
    const output: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => output.push(line) });

    runWithLogContext({ request_id: 'request-123', authorization: 'Bearer sentinel-secret' }, () => {
      logger.error('provider.request.failed', {
        raw_payload: 'sentinel-secret',
        body: 'sentinel-secret',
        error_message: 'sentinel-secret',
        ...serializeError(new Error('sentinel-secret')),
      });
    });

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('request-123');
    expect(output[0]).toContain('"error_type":"Error"');
    expect(output[0]).not.toContain('sentinel-secret');
    expect(output[0]).not.toContain('authorization');
    expect(output[0]).not.toContain('raw_payload');
    expect(output[0]).not.toContain('body');
    expect(output[0]).not.toContain('error_message');

    logger.info('sentinel-secret', { status: 'ok' });
    expect(output[1]).toContain('"event":"unclassified"');
    expect(output[1]).not.toContain('sentinel-secret');
  });
});
