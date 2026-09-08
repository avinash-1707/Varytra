ALTER TABLE projects
  ADD COLUMN name text NOT NULL DEFAULT 'Untitled project' CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD COLUMN description text CHECK (description IS NULL OR char_length(description) <= 500),
  ADD COLUMN data_classification text NOT NULL DEFAULT 'standard' CHECK (data_classification IN ('standard', 'sensitive', 'restricted')),
  ADD COLUMN retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX projects_organization_updated_at_idx ON projects (organization_id, updated_at DESC, id DESC);
