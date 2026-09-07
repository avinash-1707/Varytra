import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool, withOrganizationTransaction } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const firstOrganizationId = '11111111-1111-4111-8111-111111111111';
const secondOrganizationId = '22222222-2222-4222-8222-222222222222';
const thirdOrganizationId = '33333333-3333-4333-8333-333333333333';

describeDatabase('rls foundation', () => {
  const pool = connectionString === undefined ? undefined : createDatabasePool({ connectionString, max: 1 });

  beforeAll(async () => {
    await runMigrations(connectionString!);
    const database = createDatabasePool({ connectionString: connectionString! });
    await database.query('TRUNCATE organizations');
    await database.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2), ($3, $4)',
      [firstOrganizationId, 'First organization', secondOrganizationId, 'Second organization'],
    );
    await database.end();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('denies access without tenant context and scopes reads and writes to the transaction organization', async () => {
    const database = pool!;
    const withoutContextClient = await database.connect();
    await withoutContextClient.query('BEGIN');
    await withoutContextClient.query('SET LOCAL ROLE varytra_app');
    const withoutContext = await withoutContextClient.query<{ readonly id: string }>('SELECT id FROM organizations');
    await withoutContextClient.query('ROLLBACK');
    withoutContextClient.release();
    const firstOrganization = await withOrganizationTransaction(database, firstOrganizationId, async (client) => {
      const result = await client.query<{ readonly id: string }>('SELECT id FROM organizations');
      const foreignUpdate = await client.query(
        'UPDATE organizations SET name = $1 WHERE id = $2',
        ['Foreign write', secondOrganizationId],
      );
      return {
        ids: result.rows.map((row) => row.id),
        foreignUpdateCount: foreignUpdate.rowCount,
      };
    });
    const createdOrganization = await withOrganizationTransaction(database, thirdOrganizationId, async (client) => {
      const insert = await client.query(
        'INSERT INTO organizations (id, name) VALUES ($1, $2)',
        [thirdOrganizationId, 'Third organization'],
      );

      return insert.rowCount;
    });

    expect(withoutContext.rows).toEqual([]);
    expect(firstOrganization).toEqual({ ids: [firstOrganizationId], foreignUpdateCount: 0 });
    expect(createdOrganization).toBe(1);
  });

  it('clears tenant context and application role when a pooled connection is released', async () => {
    const database = pool!;
    await withOrganizationTransaction(database, firstOrganizationId, async () => undefined);
    const result = await database.query<{ readonly organizationId: string | null; readonly role: string }>(
      "SELECT current_setting('app.organization_id', true) AS \"organizationId\", current_user AS role",
    );

    expect(result.rows[0]?.organizationId).toBeNull();
    expect(result.rows[0]?.role).not.toBe('varytra_app');
  });
});
