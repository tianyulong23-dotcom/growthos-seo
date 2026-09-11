BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_project_domain_ratings (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  target text NOT NULL,
  provider text NOT NULL DEFAULT 'ahrefs',
  domain_rating numeric,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failure_code text,
  PRIMARY KEY (organization_id, workspace_id, website_project_id, target),
  CONSTRAINT backlink_project_domain_rating_values_ck CHECK (
    provider = 'ahrefs'
    AND target = lower(target) AND length(btrim(target)) > 0
    AND expires_at > observed_at
    AND (
      (domain_rating IS NOT NULL AND domain_rating BETWEEN 0 AND 100 AND failure_code IS NULL)
      OR (domain_rating IS NULL AND failure_code IS NOT NULL AND failure_code LIKE 'AHREFS_%')
    )
  )
);

ALTER TABLE backlink_project_domain_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_project_domain_ratings FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_project_domain_rating_tenant_policy
ON backlink_project_domain_ratings
USING (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id = NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id = NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

REVOKE ALL ON backlink_project_domain_ratings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON backlink_project_domain_ratings TO growthos_backlinks_writer;
GRANT SELECT ON backlink_project_domain_ratings TO growthos_reporting_reader;

COMMENT ON TABLE backlink_project_domain_ratings IS
  'Project-scoped Ahrefs GET cache only; no publisher lookups or cross-project cache.';

COMMIT;
