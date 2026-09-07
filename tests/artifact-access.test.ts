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

const transport: ArtifactStorageTransport = {
  async write() {},
  async readMetadata() {
    return { content_hash: 'a'.repeat(64) };
  },
  async signRead(key, expiresInSeconds) {
    return `https://storage.example.test/${key}?expires=${expiresInSeconds}`;
  },
  async delete() {},
};
const tombstones: ArtifactTombstoneStore = {
  async exists() {
    return false;
  },
  async create() {},
};

describe('artifact access', () => {
  it('allows only the owning organization to receive a short-lived signed URL', async () => {
    const storage = createArtifactStorage(transport, tombstones);
    const url = await storage.getSignedReadUrl({
      requesterOrganizationId: owner.organizationId,
      artifact: {
        owner,
        kind: 'raw-trace',
        contentHash: 'a'.repeat(64),
      },
      expiresInSeconds: 60,
    });

    expect(url).toContain('expires=60');
    await expect(storage.getSignedReadUrl({
      requesterOrganizationId: '22222222-2222-4222-8222-222222222222',
      artifact: { owner, kind: 'raw-trace', contentHash: 'a'.repeat(64) },
      expiresInSeconds: 60,
    })).rejects.toBeInstanceOf(ArtifactAccessError);
  });

  it('rejects URLs outside the configured maximum lifetime', async () => {
    const storage = createArtifactStorage(transport, tombstones);

    await expect(storage.getSignedReadUrl({
      requesterOrganizationId: owner.organizationId,
      artifact: { owner, kind: 'raw-trace', contentHash: 'a'.repeat(64) },
      expiresInSeconds: 61,
    })).rejects.toBeInstanceOf(ArtifactAccessError);
  });
});
