import { beforeAll, describe, expect, it } from 'vitest';
import { createDatabasePool } from '@varytra/infrastructure';
import { loadMigrations, runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;

describeDatabase('migrations', () => {
  beforeAll(async () => {
    await runMigrations(connectionString!);
  });

  it('loads ordered immutable migrations', async () => {
    const migrations = await loadMigrations();

    expect(migrations.map((migration) => migration.name)).toEqual([
      '001_create_database_roles.sql',
      '002_create_organizations.sql',
      '003_handle_reset_tenant_context.sql',
      '004_create_identity_tables.sql',
      '005_create_account_security_events.sql',
      '006_preserve_account_security_audit_events.sql',
      '007_create_artifact_tombstones.sql',
      '008_handle_reset_artifact_tombstone_context.sql',
      '009_create_organization_authorization.sql',
      '010_add_organization_lifecycle_functions.sql',
      '011_expand_projects_for_workspace.sql',
      '012_create_versioned_project_resources.sql',
    '013_create_comparison_batch_scheduler.sql',
    '014_enforce_agent_run_lease_invariants.sql',
    '015_add_run_artifact_lineage_and_progress.sql',
    '016_create_comparison_reports_and_reviews.sql',
    '017_add_run_outcomes_and_report_finalization.sql',
    '018_grant_report_immutability_trigger_access.sql',
    ]);
    expect(migrations.every((migration) => migration.checksum.length === 64)).toBe(true);
  });

  it('bootstraps schema metadata and database roles', async () => {
    const database = createDatabasePool({ connectionString: connectionString! });
    const migrations = await database.query<{ readonly name: string }>(
      'SELECT name FROM public.schema_migrations ORDER BY name',
    );
    const roles = await database.query<{ readonly rolname: string; readonly rolbypassrls: boolean }>(
      "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('varytra_app', 'varytra_migrator') ORDER BY rolname",
    );
    const organizationOwner = await database.query<{ readonly owner: string }>(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'organizations'::regclass",
    );
    await database.end();

    expect(migrations.rows.map((migration) => migration.name)).toEqual([
      '001_create_database_roles.sql',
      '002_create_organizations.sql',
      '003_handle_reset_tenant_context.sql',
      '004_create_identity_tables.sql',
      '005_create_account_security_events.sql',
      '006_preserve_account_security_audit_events.sql',
      '007_create_artifact_tombstones.sql',
      '008_handle_reset_artifact_tombstone_context.sql',
      '009_create_organization_authorization.sql',
      '010_add_organization_lifecycle_functions.sql',
      '011_expand_projects_for_workspace.sql',
      '012_create_versioned_project_resources.sql',
      '013_create_comparison_batch_scheduler.sql',
      '014_enforce_agent_run_lease_invariants.sql',
      '015_add_run_artifact_lineage_and_progress.sql',
      '016_create_comparison_reports_and_reviews.sql',
      '017_add_run_outcomes_and_report_finalization.sql',
      '018_grant_report_immutability_trigger_access.sql',
    ]);
    expect(roles.rows).toEqual([
      { rolname: 'varytra_app', rolbypassrls: false },
      { rolname: 'varytra_migrator', rolbypassrls: true },
    ]);
    expect(organizationOwner.rows).toEqual([{ owner: 'varytra_migrator' }]);
  });
});
