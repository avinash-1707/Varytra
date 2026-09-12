CREATE TABLE review_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  comparison_id uuid NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  recipient_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('inconclusive', 'no-material-change', 'suspected-regression')),
  severity text NOT NULL CHECK (severity IN ('none', 'medium', 'high', 'critical', 'unknown')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comparison_id, recipient_user_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX review_notification_outbox_ready_idx ON review_notification_outbox (organization_id, status, available_at);

ALTER TABLE review_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_notification_outbox FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON review_notification_outbox TO varytra_app;
CREATE POLICY review_notification_outbox_tenant_isolation ON review_notification_outbox
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
