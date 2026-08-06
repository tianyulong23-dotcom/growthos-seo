BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_project_context_snapshots
  ADD CONSTRAINT backlink_project_context_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_contact_evidence
  ADD CONSTRAINT backlink_contact_evidence_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_contact_candidates
  DROP CONSTRAINT backlink_contact_candidate_purpose_check,
  ADD CONSTRAINT backlink_contact_candidate_purpose_check CHECK (
    inferred_purpose IN (
      'press', 'editorial', 'partnerships', 'advertising',
      'business', 'marketing', 'site_owner', 'general',
      'support', 'privacy', 'legal', 'abuse', 'security',
      'billing', 'jobs', 'no_reply', 'unknown'
    )
  );

ALTER TABLE backlink_contacts
  DROP CONSTRAINT backlink_contact_purpose_check,
  ADD CONSTRAINT backlink_contact_purpose_check CHECK (
    inferred_purpose IN (
      'press', 'editorial', 'partnerships', 'advertising',
      'business', 'marketing', 'site_owner', 'general',
      'support', 'privacy', 'legal', 'abuse', 'security',
      'billing', 'jobs', 'no_reply', 'unknown'
    )
  );

CREATE TABLE backlink_contact_enrichment_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_contact_enrichment_batch_status_check CHECK (
    status IN ('running', 'completed', 'stale_context')
  ),
  CONSTRAINT backlink_contact_enrichment_batch_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT backlink_contact_enrichment_batch_version_check CHECK (
    version > 0
  ),
  CONSTRAINT backlink_contact_enrichment_batch_context_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id
  ),
  CONSTRAINT backlink_contact_enrichment_batch_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_contact_enrichment_batch_context_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id
  ) REFERENCES backlink_project_context_snapshots (
    organization_id, workspace_id, website_project_id, id
  )
);

ALTER TABLE backlink_contact_enrichment_jobs
  ADD COLUMN batch_id uuid,
  ADD COLUMN terminal_reason_code text,
  ADD COLUMN method text NOT NULL DEFAULT 'none',
  ADD COLUMN last_error_category text,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT backlink_contact_enrichment_job_reason_check CHECK (
    terminal_reason_code IS NULL OR terminal_reason_code IN (
      'PUBLIC_EMAIL_FOUND', 'CONTACT_FORM_ONLY', 'LOGIN_REQUIRED',
      'CAPTCHA_OR_BOT_CHALLENGE', 'ROBOTS_DISALLOWED', 'ACCESS_DENIED',
      'NO_PUBLIC_EMAIL', 'SITE_UNREACHABLE', 'UNSUPPORTED_CONTENT',
      'MANUAL_REVIEW_REQUIRED', 'COMPLETED_PARTIAL'
    )
  ),
  ADD CONSTRAINT backlink_contact_enrichment_job_method_check CHECK (
    method IN ('none', 'static', 'browser', 'static_and_browser')
  );

RESET ROLE;

INSERT INTO backlink_contact_enrichment_batches (
  id, organization_id, workspace_id, website_project_id,
  recommendation_context_version_id, status, started_at,
  created_by, updated_by
)
SELECT gen_random_uuid(), organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, 'running', min(created_at),
       min(created_by), min(updated_by)
  FROM backlink_contact_enrichment_jobs
 GROUP BY organization_id, workspace_id, website_project_id,
          recommendation_context_version_id
ON CONFLICT (
  organization_id, workspace_id, website_project_id,
  recommendation_context_version_id
) DO NOTHING;

UPDATE backlink_contact_enrichment_jobs AS job
   SET batch_id = batch.id
  FROM backlink_contact_enrichment_batches AS batch
 WHERE (
   batch.organization_id, batch.workspace_id, batch.website_project_id,
   batch.recommendation_context_version_id
 ) = (
   job.organization_id, job.workspace_id, job.website_project_id,
   job.recommendation_context_version_id
 );

SET LOCAL ROLE growthos_backlinks_owner;

ALTER TABLE backlink_contact_enrichment_jobs
  ALTER COLUMN batch_id SET NOT NULL,
  ADD CONSTRAINT backlink_contact_enrichment_job_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, batch_id
  ) REFERENCES backlink_contact_enrichment_batches (
    organization_id, workspace_id, website_project_id, id
  );

CREATE TABLE backlink_contact_evidence_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  contact_candidate_id uuid NOT NULL,
  contact_evidence_id uuid NOT NULL,
  source_url text NOT NULL,
  email_sha256 text NOT NULL,
  email_reference text NOT NULL,
  inferred_purpose text NOT NULL,
  contact_confidence integer NOT NULL,
  purpose_confidence integer NOT NULL,
  evidence_confidence integer NOT NULL,
  collected_at timestamptz NOT NULL,
  rules_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_contact_snapshot_url_check CHECK (
    source_url ~ '^https?://'
  ),
  CONSTRAINT backlink_contact_snapshot_hash_check CHECK (
    email_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_contact_snapshot_reference_check CHECK (
    length(btrim(email_reference)) > 0
    AND length(btrim(rules_version)) > 0
  ),
  CONSTRAINT backlink_contact_snapshot_confidence_check CHECK (
    contact_confidence BETWEEN 0 AND 100
    AND purpose_confidence BETWEEN 0 AND 100
    AND evidence_confidence BETWEEN 0 AND 100
  ),
  CONSTRAINT backlink_contact_snapshot_evidence_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    recommendation_id, recommendation_context_version_id,
    contact_candidate_id, contact_evidence_id, rules_version
  ),
  CONSTRAINT backlink_contact_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_contact_snapshot_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, recommendation_id,
    prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id, id,
    prospect_id, recommendation_context_version_id
  ),
  CONSTRAINT backlink_contact_snapshot_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_candidate_id
  ) REFERENCES backlink_contact_candidates (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_contact_snapshot_evidence_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_evidence_id
  ) REFERENCES backlink_contact_evidence (
    organization_id, workspace_id, website_project_id, id
  )
);

ALTER TABLE backlink_recommendation_inventory
  DROP CONSTRAINT backlink_rec_inventory_publication_status_check,
  DROP CONSTRAINT backlink_rec_inventory_verified_email_check,
  ADD COLUMN contact_evidence_snapshot_id uuid,
  ADD COLUMN default_contact_candidate_id uuid,
  ADD COLUMN default_contact_source_url text,
  ADD COLUMN default_contact_email_sha256 text,
  ADD COLUMN default_contact_email_reference text,
  ADD COLUMN contact_collected_at timestamptz,
  ADD COLUMN contact_rules_version text,
  ADD CONSTRAINT backlink_rec_inventory_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    contact_evidence_snapshot_id
  ) REFERENCES backlink_contact_evidence_snapshots (
    organization_id, workspace_id, website_project_id, id
  ),
  ADD CONSTRAINT backlink_rec_inventory_default_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    default_contact_candidate_id
  ) REFERENCES backlink_contact_candidates (
    organization_id, workspace_id, website_project_id, id
  );

RESET ROLE;

UPDATE backlink_recommendation_inventory
   SET publication_status = 'CONTACT_PENDING',
       verified_public_email_count = 0,
       updated_at = now()
 WHERE contact_evidence_snapshot_id IS NULL;

SET LOCAL ROLE growthos_backlinks_owner;

ALTER TABLE backlink_recommendation_inventory
  ADD CONSTRAINT backlink_rec_inventory_publication_status_check CHECK (
    publication_status IN (
      'PUBLISHED', 'NOT_PUBLISHED', 'CONTACT_PENDING', 'CONTACT_REVIEW'
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_publication_gate_check CHECK (
    verified_public_email_count >= 0
    AND (
      publication_status <> 'PUBLISHED'
      OR (
        verified_public_email_count >= 1
        AND contact_evidence_snapshot_id IS NOT NULL
        AND default_contact_candidate_id IS NOT NULL
        AND default_contact_source_url ~ '^https?://'
        AND default_contact_email_sha256 ~ '^[a-f0-9]{64}$'
        AND length(btrim(default_contact_email_reference)) > 0
        AND contact_collected_at IS NOT NULL
        AND length(btrim(contact_rules_version)) > 0
      )
    )
  );

ALTER TABLE backlink_commercial_inventory_policies
  ADD COLUMN published_contact_ready_low_watermark integer NOT NULL DEFAULT 5,
  ADD COLUMN published_contact_ready_high_watermark integer NOT NULL DEFAULT 10,
  ADD CONSTRAINT backlink_commercial_contact_ready_watermark_check CHECK (
    published_contact_ready_low_watermark >= 0
    AND published_contact_ready_high_watermark >
    published_contact_ready_low_watermark
  );

RESET ROLE;

UPDATE backlink_commercial_inventory_policies
   SET published_contact_ready_low_watermark = published_low_watermark,
       published_contact_ready_high_watermark = published_high_watermark;

UPDATE backlink_contact_enrichment_jobs
   SET status = 'retry_scheduled',
       retry_after = now(),
       finished_at = NULL,
       completed_at = NULL,
       terminal_reason_code = NULL,
       method = 'none',
       last_error_category = NULL,
       max_attempts = LEAST(10, GREATEST(max_attempts, attempt_count + 1)),
       updated_at = now(),
       version = version + 1
 WHERE status IN (
   'running', 'completed', 'partially_completed', 'no_contact_found'
 )
   AND terminal_reason_code IS NULL;

SET LOCAL ROLE growthos_backlinks_owner;

CREATE INDEX backlink_contact_enrichment_batch_status_idx
  ON backlink_contact_enrichment_batches (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, status
  );

CREATE INDEX backlink_contact_enrichment_job_batch_reason_idx
  ON backlink_contact_enrichment_jobs (
    organization_id, workspace_id, website_project_id,
    batch_id, terminal_reason_code, status
  );

ALTER TABLE backlink_contact_enrichment_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_enrichment_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_evidence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_evidence_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_contact_enrichment_batch_tenant_policy
  ON backlink_contact_enrichment_batches
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_contact_evidence_snapshot_tenant_policy
  ON backlink_contact_evidence_snapshots
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

GRANT SELECT, INSERT, UPDATE
  ON backlink_contact_enrichment_batches
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_contact_evidence_snapshots
  TO growthos_backlinks_writer;

COMMIT;
