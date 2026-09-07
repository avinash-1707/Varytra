import { describe, expect, it } from 'vitest';
import {
  ArtifactAccessError,
  createArtifactStorage,
  type ArtifactStorageTransport,
  type ArtifactTombstoneStore,
} from '@varytra/infrastructure';

const owner = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-a',
  batchId: 'batch-a',
  runId: 'run-a',
};

describe('retention', () => {
  it('records a tombstone before deleting an expired artifact and denies later access', async () => {
    const tombstones = new Set<string>();
    const store: ArtifactTombstoneStore = {
      async exists(organizationId, objectKey) {
        return tombstones.has(`${organizationId}:${objectKey}`);
      },
      async create(tombstone) {
        tombstones.add(`${tombstone.organizationId}:${tombstone.objectKey}`);
      },
    };
    let deleted = false;
    const transport: ArtifactStorageTransport = {
      async write() {},
      async readMetadata() {
        return { content_hash: 'a'.repeat(64) };
      },
      async signRead() {
        return 'https://storage.example.test/signed';
      },
      async delete() {
        deleted = true;
      },
    };
    const storage = createArtifactStorage(transport, store);
    const artifact = {
      owner,
      kind: 'redacted-trace' as const,
      contentHash: 'a'.repeat(64),
    };

    await storage.deleteExpired(artifact, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    expect(deleted).toBe(true);
    await expect(storage.getSignedReadUrl({
      requesterOrganizationId: owner.organizationId,
      artifact,
      expiresInSeconds: 60,
    })).rejects.toBeInstanceOf(ArtifactAccessError);
  });
});
