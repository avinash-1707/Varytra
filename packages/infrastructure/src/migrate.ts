import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface Migration {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
}

export async function loadMigrations(): Promise<readonly Migration[]> {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(migrationDirectory, name), 'utf8');

    return {
      checksum: createHash('sha256').update(sql).digest('hex'),
      name,
      sql,
    };
  }));
}

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock(783_004_001)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    let usingMigrationRole = false;

    for (const migration of await loadMigrations()) {
      if (migration.name !== '001_create_database_roles.sql' && !usingMigrationRole) {
        await client.query('SET ROLE varytra_migrator');
        usingMigrationRole = true;
      }

      const applied = await client.query<{ readonly checksum: string }>(
        'SELECT checksum FROM public.schema_migrations WHERE name = $1',
        [migration.name],
      );
      const existing = applied.rows[0];

      if (existing !== undefined) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(783_004_001)');
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  await runMigrations(connectionString);
}
