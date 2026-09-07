import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ArtifactAccessError,
  createArtifactStorage,
  type ArtifactStorageTransport,
  type ArtifactTombstoneStore,
} from '@varytra/infrastructure';

const organizationId = '11111111-1111-4111-8111-111111111111';
const tombstones: ArtifactTombstoneStore = {
  async exists() {
    return false;
  },
  async create() {},
};

function createTransport(): ArtifactStorageTransport & { readonly writes: Map<string, Readonly<Record<string, string>>> } {
  const writes = new Map<string, Readonly<Record<string, string>>>();

  return {
    writes,
    async write(input) {
      writes.set(input.key, input.metadata);
    },
    async readMetadata(key) {
      return writes.get(key);
    },
    async signRead(key, expiresInSeconds) {
      return `https://storage.example.test/${key}?expires=${expiresInSeconds}`;
    },
    async delete() {},
  };
}

describe('artifacts', () => {
  it('writes immutable tenant-scoped keys with verified integrity metadata', async () => {
    const transport = createTransport();
    const storage = createArtifactStorage(transport, tombstones);
    const content = new TextEncoder().encode('{"event":"redacted"}\n');
    const artifact = await storage.write({
      owner: {
        organizationId,
        projectId: 'project-a',
        batchId: 'batch-a',
        runId: 'run-a',
      },
      kind: 'redacted-trace',
      content,
      schemaVersion: '1',
      classification: 'sensitive',
      retentionDeadline: new Date('2026-12-31T00:00:00.000Z'),
      creatorId: 'user-a',
    });

    expect(artifact.key).toBe(`org/${organizationId}/project/project-a/batch/batch-a/run/run-a/redacted.jsonl`);
    expect(artifact.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(transport.writes.get(artifact.key)).toMatchObject({
      classification: 'sensitive',
      content_hash: artifact.contentHash,
      creator_id: 'user-a',
      schema_version: '1',
    });
  });

  it('rejects a storage response whose immutable hash metadata does not match', async () => {
    const transport = createTransport();
    const storage = createArtifactStorage({
      ...transport,
      async readMetadata() {
        return { content_hash: '0'.repeat(64) };
      },
    }, tombstones);

    await expect(storage.write({
      owner: { organizationId, projectId: 'project-a', batchId: 'batch-a', runId: 'run-a' },
      kind: 'raw-trace',
      content: new Uint8Array([1]),
      schemaVersion: '1',
      classification: 'restricted',
      retentionDeadline: new Date('2026-12-31T00:00:00.000Z'),
      creatorId: 'user-a',
    })).rejects.toBeInstanceOf(ArtifactAccessError);
  });
});
