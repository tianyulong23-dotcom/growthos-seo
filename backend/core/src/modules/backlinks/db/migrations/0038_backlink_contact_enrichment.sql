BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_contact_evidence
  ADD COLUMN rule_version text NOT NULL DEFAULT 'contact-extraction-rules.v1',
  ADD COLUMN domain_relation text NOT NULL DEFAULT 'unknown',
  ADD CONSTRAINT backlink_contact_evidence_rule_version_check CHECK (
    length(btrim(rule_version)) > 0
  ),
  ADD CONSTRAINT backlink_contact_evidence_domain_relation_check CHECK (
    domain_relation IN (
      'same_registrable_domain', 'external_domain', 'unknown'
    )
  );

CREATE TABLE backlink_contact_enrichment_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  root_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  max_pages integer NOT NULL DEFAULT 8,
  max_depth integer NOT NULL DEFAULT 2,
  browser_allowed boolean NOT NULL DEFAULT false,
  browser_used boolean NOT NULL DEFAULT false,
  pages_visited integer NOT NULL DEFAULT 0,
  candidate_count integer NOT NULL DEFAULT 0,
  evidence_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  retry_after timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_contact_enrichment_job_status_check CHECK (
    status IN (
      'pending', 'running', 'completed', 'partially_completed',
      'no_contact_found', 'retry_scheduled'
    )
  ),
  CONSTRAINT backlink_contact_enrichment_job_root_url_check CHECK (
    root_url ~ '^https?://'
  ),
  CONSTRAINT backlink_contact_enrichment_job_limits_check CHECK (
    attempt_count >= 0
    AND max_attempts BETWEEN 1 AND 10
    AND max_pages BETWEEN 1 AND 50
    AND max_depth BETWEEN 0 AND 5
    AND pages_visited >= 0
    AND candidate_count >= 0
    AND evidence_count >= 0
  ),
  CONSTRAINT backlink_contact_enrichment_job_version_check CHECK (
    version > 0
  ),
  CONSTRAINT backlink_contact_enrichment_job_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_contact_enrichment_job_recommendation_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    recommendation_id, recommendation_context_version_id
  ),
  CONSTRAINT backlink_contact_enrichment_job_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, recommendation_id,
    prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id, id,
    prospect_id, recommendation_context_version_id
  )
);

CREATE TABLE backlink_contact_enrichment_pages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  page_url text NOT NULL,
  depth integer NOT NULL,
  discovery_source text NOT NULL,
  status text NOT NULL,
  http_status integer,
  browser_rendered boolean NOT NULL DEFAULT false,
  candidate_count integer NOT NULL DEFAULT 0,
  content_sha256 text,
  error_code text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_contact_enrichment_page_url_check CHECK (
    page_url ~ '^https?://'
  ),
  CONSTRAINT backlink_contact_enrichment_page_depth_check CHECK (
    depth BETWEEN 0 AND 5
  ),
  CONSTRAINT backlink_contact_enrichment_page_source_check CHECK (
    discovery_source IN (
      'homepage', 'common_path', 'navigation', 'footer',
      'robots_sitemap', 'internal_link'
    )
  ),
  CONSTRAINT backlink_contact_enrichment_page_status_check CHECK (
    status IN (
      'fetched', 'robots_disallowed', 'fetch_failed',
      'unsupported_content', 'browser_fetched', 'browser_failed'
    )
  ),
  CONSTRAINT backlink_contact_enrichment_page_http_check CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT backlink_contact_enrichment_page_count_check CHECK (
    candidate_count >= 0
  ),
  CONSTRAINT backlink_contact_enrichment_page_hash_check CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_contact_enrichment_page_job_url_uq UNIQUE (
    organization_id, workspace_id, website_project_id, job_id, page_url
  ),
  CONSTRAINT backlink_contact_enrichment_page_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, job_id
  ) REFERENCES backlink_contact_enrichment_jobs (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX backlink_contact_enrichment_job_status_idx
  ON backlink_contact_enrichment_jobs (
    organization_id, workspace_id, website_project_id,
    status, retry_after, created_at
  );

ALTER TABLE backlink_contact_enrichment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_enrichment_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_enrichment_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_enrichment_pages FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_contact_enrichment_job_tenant_policy
  ON backlink_contact_enrichment_jobs
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_contact_enrichment_page_tenant_policy
  ON backlink_contact_enrichment_pages
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

GRANT SELECT, INSERT, UPDATE
  ON backlink_contact_enrichment_jobs,
     backlink_contact_enrichment_pages
  TO growthos_backlinks_writer;

COMMIT;
