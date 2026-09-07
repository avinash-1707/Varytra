DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'varytra_migrator') THEN
    CREATE ROLE varytra_migrator NOLOGIN BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'varytra_app') THEN
    CREATE ROLE varytra_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT varytra_migrator, varytra_app TO CURRENT_USER;
GRANT USAGE, CREATE ON SCHEMA public TO varytra_migrator;
GRANT SELECT, INSERT ON public.schema_migrations TO varytra_migrator;
ALTER TABLE public.schema_migrations OWNER TO varytra_migrator;
