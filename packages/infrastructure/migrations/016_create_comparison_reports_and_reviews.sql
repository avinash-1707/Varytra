CREATE TABLE comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES comparison_batches(id) ON DELETE CASCADE,
  scenario_version_id uuid NOT NULL REFERENCES scenario_versions(id),
  classification text NOT NULL CHECK (classification IN ('improvement', 'no-material-change', 'suspected-regression', 'inconclusive')),
  severity text NOT NULL CHECK (severity IN ('none', 'medium', 'high', 'critical', 'unknown')),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  gate_status text NOT NULL CHECK (gate_status IN ('pass', 'warn', 'block', 'review')),
  summary_redacted text NOT NULL CHECK (char_length(summary_redacted) BETWEEN 1 AND 4000),
  coverage jsonb NOT NULL,
  first_material_divergence jsonb,
  state_comparison jsonb NOT NULL,
  evaluator_version text NOT NULL CHECK (char_length(evaluator_version) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, scenario_version_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE comparison_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  comparison_id uuid NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('final_state', 'policy', 'reliability', 'efficiency', 'trajectory')),
  severity text NOT NULL CHECK (severity IN ('medium', 'high', 'critical')),
  repetition integer CHECK (repetition > 0),
  summary_redacted text NOT NULL CHECK (char_length(summary_redacted) BETWEEN 1 AND 4000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  comparison_id uuid NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES "user"(id),
  action text NOT NULL CHECK (action IN ('approve', 'reject', 'mark_inconclusive', 'override_classification')),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000),
  override_classification text CHECK (override_classification IN ('improvement', 'no-material-change', 'suspected-regression', 'inconclusive')),
  resulting_gate_status text NOT NULL CHECK (resulting_gate_status IN ('pass', 'warn', 'block', 'review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'override_classification') = (override_classification IS NOT NULL)),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX comparisons_report_idx ON comparisons (organization_id, id);
CREATE INDEX comparison_findings_report_idx ON comparison_findings (organization_id, comparison_id, created_at);
CREATE INDEX review_decisions_report_idx ON review_decisions (organization_id, comparison_id, created_at DESC);

ALTER TABLE comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparison_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comparisons FORCE ROW LEVEL SECURITY;
ALTER TABLE comparison_findings FORCE ROW LEVEL SECURITY;
ALTER TABLE review_decisions FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON comparisons, comparison_findings, review_decisions TO varytra_app;
CREATE POLICY comparisons_tenant_isolation ON comparisons USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY comparison_findings_tenant_isolation ON comparison_findings USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY review_decisions_tenant_isolation ON review_decisions USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE FUNCTION prevent_comparison_report_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'comparison report records are immutable';
END;
$$;

CREATE TRIGGER comparisons_immutable BEFORE UPDATE OR DELETE ON comparisons FOR EACH ROW EXECUTE FUNCTION prevent_comparison_report_mutation();
CREATE TRIGGER comparison_findings_immutable BEFORE UPDATE OR DELETE ON comparison_findings FOR EACH ROW EXECUTE FUNCTION prevent_comparison_report_mutation();
CREATE TRIGGER review_decisions_immutable BEFORE UPDATE OR DELETE ON review_decisions FOR EACH ROW EXECUTE FUNCTION prevent_comparison_report_mutation();
