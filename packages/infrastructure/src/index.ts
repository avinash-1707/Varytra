import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

const artifactKinds = ['raw-trace', 'redacted-trace', 'report'] as const;
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
    encryption: ArtifactEncryption;
  }>) => Promise<void>;
  readonly readMetadata: (key: string) => Promise<Readonly<Record<string, string>> | undefined>;
  readonly signRead: (key: string, expiresInSeconds: number) => Promise<string>;
  readonly delete: (key: string) => Promise<void>;
}

export type ArtifactEncryption =
  | Readonly<{ readonly mode: 's3' }>
  | Readonly<{ readonly mode: 'kms'; readonly keyId: string }>;

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

  return `${prefix}/run/${owner.runId}/${kind === 'raw-trace' ? 'raw.jsonl' : 'redacted.jsonl'}`;
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
  encryption: ArtifactEncryption = { mode: 's3' },
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
      await transport.write({ key, content: input.content, metadata, encryption });
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

export interface S3ArtifactStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint?: string;
  readonly encryption?: ArtifactEncryption;
}

export function createS3ArtifactStorage(
  config: S3ArtifactStorageConfig,
  tombstones: ArtifactTombstoneStore,
): ArtifactStorage {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
  });
  const encryption = config.encryption ?? { mode: 's3' };
  const transport: ArtifactStorageTransport = {
    async write(input) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        Body: input.content,
        Metadata: input.metadata,
        IfNoneMatch: '*',
        ...(input.encryption.mode === 'kms'
          ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: input.encryption.keyId }
          : { ServerSideEncryption: 'AES256' }),
      }));
    },
    async readMetadata(key) {
      const response = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return response.Metadata;
    },
    async signRead(key, expiresInSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
    async delete(key) {
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: key }));
      const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
        .filter((version) => version.Key === key && version.VersionId !== undefined)
        .map((version) => ({ Key: key, VersionId: version.VersionId! }));

      if (objects.length === 0) {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        return;
      }

      await client.send(new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: { Objects: objects, Quiet: true },
      }));
    },
  };

  return createArtifactStorage(transport, tombstones, encryption);
}
