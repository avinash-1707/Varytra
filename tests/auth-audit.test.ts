import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;

describeDatabase('account security audit', () => {
  const database = connectionString === undefined ? undefined : createDatabasePool({ connectionString });

  beforeAll(async () => {
    await runMigrations(connectionString!);
  });

  afterAll(async () => {
    await database?.end();
  });

  it('retains the user identifier without a cascading foreign key', async () => {
    const constraint = await database!.query<{ readonly confdeltype: string }>(
      "SELECT confdeltype FROM pg_constraint WHERE conrelid = 'account_security_events'::regclass AND conname = 'account_security_events_user_id_fkey'",
    );

    expect(constraint.rows).toEqual([]);
  });

  it('denies audit event mutation to the application role', async () => {
    const client = await database!.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE varytra_app');

    await expect(client.query('DELETE FROM account_security_events')).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK');
    client.release();
  });
});
