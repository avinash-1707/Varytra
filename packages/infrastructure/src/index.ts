import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly max?: number;
}

export function createDatabasePool(config: DatabaseConfig): Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.max,
  });
}

export async function withOrganizationTransaction<T>(
  pool: Pool,
  organizationId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!uuidPattern.test(organizationId)) {
    throw new Error('organizationId must be a UUID');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE varytra_app');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const artifactKinds = ['raw-trace', 'redacted-trace', 'normalized-trace', 'report'] as const;
const artifactClassifications = ['restricted', 'sensitive', 'internal'] as const;
const maximumSignedUrlLifetimeSeconds = 60;

export type ArtifactKind = (typeof artifactKinds)[number];
export type ArtifactClassification = (typeof artifactClassifications)[number];

export interface ArtifactOwner {
  readonly organizationId: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly runId?: string;
}

export interface StoredArtifact {
  readonly owner: ArtifactOwner;
  readonly kind: ArtifactKind;
  readonly key: string;
  readonly contentHash: string;
}

export class ArtifactAccessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactAccessError';
  }
}

export interface ArtifactStorageTransport {
  readonly write: (input: Readonly<{
    key: string;
    content: Uint8Array;
    metadata: Readonly<Record<string, string>>;
  }>) => Promise<void>;
  readonly readMetadata: (key: string) => Promise<Readonly<Record<string, string>> | undefined>;
  readonly signRead: (key: string, expiresInSeconds: number) => Promise<string>;
  readonly delete: (key: string) => Promise<void>;
}

export interface ArtifactTombstone {
  readonly organizationId: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly retentionDeadline: Date;
}

export interface ArtifactTombstoneStore {
  readonly exists: (organizationId: string, objectKey: string) => Promise<boolean>;
  readonly create: (tombstone: ArtifactTombstone) => Promise<void>;
}

export class PostgresArtifactTombstoneStore implements ArtifactTombstoneStore {
  public constructor(private readonly client: PoolClient) {}

  public async exists(organizationId: string, objectKey: string): Promise<boolean> {
    const result = await this.client.query(
      'SELECT 1 FROM artifact_tombstones WHERE organization_id = $1 AND object_key = $2',
      [organizationId, objectKey],
    );

    return result.rowCount === 1;
  }

  public async create(tombstone: ArtifactTombstone): Promise<void> {
    await this.client.query(
      `INSERT INTO artifact_tombstones (organization_id, object_key, content_hash, retention_deadline)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, object_key) DO NOTHING`,
      [
        tombstone.organizationId,
        tombstone.objectKey,
        tombstone.contentHash,
        tombstone.retentionDeadline,
      ],
    );
  }
}

export interface ArtifactStorage {
  readonly write: (input: Readonly<{
    owner: ArtifactOwner;
    kind: ArtifactKind;
    content: Uint8Array;
    schemaVersion: string;
    classification: ArtifactClassification;
    retentionDeadline: Date;
    creatorId: string;
  }>) => Promise<StoredArtifact>;
  readonly getSignedReadUrl: (input: Readonly<{
    requesterOrganizationId: string;
    artifact: Omit<StoredArtifact, 'key'>;
    expiresInSeconds: number;
  }>) => Promise<string>;
  readonly deleteExpired: (
    artifact: Omit<StoredArtifact, 'key'>,
    now: Date,
    retentionDeadline: Date,
  ) => Promise<void>;
}

function artifactKey(owner: ArtifactOwner, kind: ArtifactKind): string {
  const prefix = `org/${owner.organizationId}/project/${owner.projectId}/batch/${owner.batchId}`;

  if (kind === 'report') {
    return `${prefix}/report.json`;
  }

  if (owner.runId === undefined || owner.runId.length === 0) {
    throw new ArtifactAccessError('Run artifacts require a run ID');
  }

  const filename = kind === 'raw-trace' ? 'raw.jsonl' : kind === 'redacted-trace' ? 'redacted.jsonl' : 'normalized.jsonl';
  return `${prefix}/run/${owner.runId}/${filename}`;
}

function assertArtifactOwner(owner: ArtifactOwner): void {
  if (!uuidPattern.test(owner.organizationId)) {
    throw new ArtifactAccessError('Artifact organization ID must be a UUID');
  }

  for (const value of [owner.projectId, owner.batchId, owner.runId]) {
    if (value !== undefined && !/^[a-zA-Z0-9_-]+$/.test(value)) {
      throw new ArtifactAccessError('Artifact identifiers must be URL-safe');
    }
  }
}

function assertHash(contentHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new ArtifactAccessError('Artifact content hash must be SHA-256 hex');
  }
}

export function createArtifactStorage(
  transport: ArtifactStorageTransport,
  tombstones: ArtifactTombstoneStore,
): ArtifactStorage {
  return {
    async write(input) {
      assertArtifactOwner(input.owner);
      if (!artifactKinds.includes(input.kind) || !artifactClassifications.includes(input.classification)) {
        throw new ArtifactAccessError('Artifact kind or classification is invalid');
      }
      const key = artifactKey(input.owner, input.kind);
      if (await tombstones.exists(input.owner.organizationId, key)) {
        throw new ArtifactAccessError('Expired artifacts cannot be recreated');
      }
      const contentHash = createHash('sha256').update(input.content).digest('hex');
      const metadata = {
        classification: input.classification,
        content_hash: contentHash,
        creator_id: input.creatorId,
        retention_deadline: input.retentionDeadline.toISOString(),
        schema_version: input.schemaVersion,
      };
      await transport.write({ key, content: input.content, metadata });
      const storedMetadata = await transport.readMetadata(key);

      if (storedMetadata?.content_hash !== contentHash) {
        throw new ArtifactAccessError('Artifact integrity metadata did not persist');
      }

      return { owner: input.owner, kind: input.kind, key, contentHash };
    },

    async getSignedReadUrl(input) {
      assertArtifactOwner(input.artifact.owner);
      assertHash(input.artifact.contentHash);
      const key = artifactKey(input.artifact.owner, input.artifact.kind);

      if (input.requesterOrganizationId !== input.artifact.owner.organizationId) {
        throw new ArtifactAccessError('Artifact access is limited to the owning organization');
      }
      if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > maximumSignedUrlLifetimeSeconds) {
        throw new ArtifactAccessError('Artifact signed URL lifetime is invalid');
      }
      if (await tombstones.exists(input.artifact.owner.organizationId, key)) {
        throw new ArtifactAccessError('Artifact has expired');
      }

      return transport.signRead(key, input.expiresInSeconds);
    },

    async deleteExpired(artifact, now, retentionDeadline) {
      assertArtifactOwner(artifact.owner);
      assertHash(artifact.contentHash);
      const key = artifactKey(artifact.owner, artifact.kind);

      if (retentionDeadline > now) {
        throw new ArtifactAccessError('Artifact retention deadline has not elapsed');
      }
      // The tombstone blocks new reads even if object deletion needs a later retry.
      await tombstones.create({
        organizationId: artifact.owner.organizationId,
        objectKey: key,
        contentHash: artifact.contentHash,
        retentionDeadline,
      });
      await transport.delete(key);
    },
  };
}

export interface CloudinaryArtifactStorageConfig {
  readonly cloudName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

interface CloudinaryUploadResult {
  readonly public_id: string;
  readonly context: unknown;
}

export interface CloudinaryArtifactClient {
  readonly config: (config: Readonly<{
    cloud_name: string;
    api_key: string;
    api_secret: string;
  }>) => unknown;
  readonly uploader: Readonly<{
    upload: (file: string, options: Readonly<{
      resource_type: 'raw';
      type: 'authenticated';
      public_id: string;
      overwrite: false;
      unique_filename: false;
      context: Readonly<Record<string, string>>;
    }>) => Promise<CloudinaryUploadResult>;
    destroy: (publicId: string, options: Readonly<{
      resource_type: 'raw';
      type: 'authenticated';
      invalidate: true;
    }>) => Promise<unknown>;
  }>;
  readonly utils: Readonly<{
    private_download_url: (publicId: string, format: string, options: Readonly<{
      resource_type: 'raw';
      type: 'authenticated';
      expires_at: number;
      attachment: true;
    }>) => string;
  }>;
}

function cloudinaryContext(context: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    return undefined;
  }

  const custom = (context as Readonly<Record<string, unknown>>).custom;
  const values = custom === undefined ? context : custom;

  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return undefined;
  }

  const entries = Object.entries(values);
  if (entries.some(([, value]) => typeof value !== 'string')) {
    return undefined;
  }

  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function artifactFormat(key: string): string {
  const extension = key.split('.').at(-1);
  if (extension === undefined || !/^[a-z0-9]+$/.test(extension)) {
    throw new ArtifactAccessError('Artifact key must include a file extension');
  }

  return extension;
}

export function createCloudinaryArtifactStorage(
  config: CloudinaryArtifactStorageConfig,
  tombstones: ArtifactTombstoneStore,
  client: CloudinaryArtifactClient = cloudinary,
): ArtifactStorage {
  client.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
  });
  const metadata = new Map<string, Readonly<Record<string, string>>>();
  const transport: ArtifactStorageTransport = {
    async write(input) {
      const response = await client.uploader.upload(
        `data:application/octet-stream;base64,${Buffer.from(input.content).toString('base64')}`,
        {
          resource_type: 'raw',
          type: 'authenticated',
          public_id: input.key,
          overwrite: false,
          unique_filename: false,
          context: input.metadata,
        },
      );

      if (response.public_id !== input.key) {
        throw new ArtifactAccessError('Cloudinary returned an unexpected artifact public ID');
      }

      const storedMetadata = cloudinaryContext(response.context);
      if (storedMetadata === undefined) {
        throw new ArtifactAccessError('Cloudinary did not return artifact context metadata');
      }

      metadata.set(input.key, storedMetadata);
    },
    async readMetadata(key) {
      return metadata.get(key);
    },
    async signRead(key, expiresInSeconds) {
      return client.utils.private_download_url(key, artifactFormat(key), {
        resource_type: 'raw',
        type: 'authenticated',
        expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
        attachment: true,
      });
    },
    async delete(key) {
      await client.uploader.destroy(key, {
        resource_type: 'raw',
        type: 'authenticated',
        invalidate: true,
      });
      metadata.delete(key);
    },
  };

  return createArtifactStorage(transport, tombstones);
}
