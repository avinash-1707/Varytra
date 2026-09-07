import { Pool, type PoolClient } from 'pg';

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
