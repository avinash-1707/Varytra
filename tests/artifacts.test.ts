import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ArtifactAccessError,
  createCloudinaryArtifactStorage,
  createArtifactStorage,
  type CloudinaryArtifactClient,
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

  it('stores normalized traces as a separate derived artifact', async () => {
    const transport = createTransport();
    const storage = createArtifactStorage(transport, tombstones);
    const artifact = await storage.write({
      owner: { organizationId, projectId: 'project-a', batchId: 'batch-a', runId: 'run-a' },
      kind: 'normalized-trace', content: new TextEncoder().encode('{"eventType":"tool_call"}\n'), schemaVersion: '1.0', classification: 'internal', retentionDeadline: new Date('2026-12-31T00:00:00.000Z'), creatorId: 'worker',
    });
    expect(artifact.key).toBe(`org/${organizationId}/project/project-a/batch/batch-a/run/run-a/normalized.jsonl`);
  });

  it('uses authenticated raw Cloudinary assets with context-only metadata', async () => {
    let uploadOptions: Readonly<Record<string, unknown>> | undefined;
    let destroyedPublicId: string | undefined;
    const client: CloudinaryArtifactClient = {
      config() {},
      uploader: {
        async upload(_, options) {
          uploadOptions = options;
          return { public_id: options.public_id, context: { custom: options.context } };
        },
        async destroy(publicId, options) {
          destroyedPublicId = publicId;
          expect(options).toEqual({ resource_type: 'raw', type: 'authenticated', invalidate: true });
        },
      },
      utils: {
        private_download_url(publicId, format, options) {
          expect(format).toBe('jsonl');
          expect(options).toMatchObject({ resource_type: 'raw', type: 'authenticated', attachment: true });
          return `https://cloudinary.example.test/${publicId}?expires_at=${options.expires_at}`;
        },
      },
    };
    const storage = createCloudinaryArtifactStorage({
      cloudName: 'varytra-test',
      apiKey: 'key',
      apiSecret: 'secret',
    }, tombstones, client);
    const artifact = await storage.write({
      owner: { organizationId, projectId: 'project-a', batchId: 'batch-a', runId: 'run-a' },
      kind: 'raw-trace',
      content: new TextEncoder().encode('{"event":"raw"}\n'),
      schemaVersion: '1',
      classification: 'restricted',
      retentionDeadline: new Date('2026-12-31T00:00:00.000Z'),
      creatorId: 'user-a',
    });

    expect(uploadOptions).toMatchObject({
      resource_type: 'raw',
      type: 'authenticated',
      public_id: artifact.key,
      overwrite: false,
      unique_filename: false,
      context: { content_hash: artifact.contentHash },
    });
    await expect(storage.getSignedReadUrl({
      requesterOrganizationId: organizationId,
      artifact: { owner: artifact.owner, kind: artifact.kind, contentHash: artifact.contentHash },
      expiresInSeconds: 60,
    })).resolves.toContain('expires_at=');
    await storage.deleteExpired(
      { owner: artifact.owner, kind: artifact.kind, contentHash: artifact.contentHash },
      new Date('2027-01-01T00:00:00.000Z'),
      new Date('2026-12-31T00:00:00.000Z'),
    );
    expect(destroyedPublicId).toBe(artifact.key);
  });
});
