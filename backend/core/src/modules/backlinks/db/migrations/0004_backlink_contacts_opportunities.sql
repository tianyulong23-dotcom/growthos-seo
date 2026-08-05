CREATE TABLE backlink_contact_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  normalized_email text NOT NULL,
  email_domain_ascii text NOT NULL,
  domain_relation text NOT NULL,
  syntax_validator_version text NOT NULL,
  confidence integer NOT NULL,
  guessed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'candidate',
  invalidated_at timestamptz,
  invalidation_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_contact_candidate_email_check CHECK (
    normalized_email = lower(normalized_email)
    AND length(btrim(normalized_email)) > 3
    AND email_domain_ascii = lower(email_domain_ascii)
    AND length(btrim(email_domain_ascii)) > 0
  ),
  CONSTRAINT backlink_contact_candidate_relation_check CHECK (
    domain_relation IN (
      'same_registrable_domain', 'external_domain', 'unknown'
    )
  ),
  CONSTRAINT backlink_contact_candidate_status_check CHECK (
    status IN ('candidate', 'rejected', 'promoted', 'invalid')
  ),
  CONSTRAINT backlink_contact_candidate_confidence_check
    CHECK (confidence >= 0 AND confidence <= 100),
  CONSTRAINT backlink_contact_candidate_validator_check
    CHECK (length(btrim(syntax_validator_version)) > 0),
  CONSTRAINT backlink_contact_candidate_invalidation_check CHECK (
    (status = 'invalid'
      AND invalidated_at IS NOT NULL
      AND invalidation_reason IS NOT NULL
      AND length(btrim(invalidation_reason)) > 0)
    OR (status <> 'invalid'
      AND invalidated_at IS NULL
      AND invalidation_reason IS NULL)
  ),
  CONSTRAINT backlink_contact_candidate_version_check CHECK (version > 0),
  CONSTRAINT backlink_contact_candidate_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_contact_candidate_email_uq UNIQUE (
    organization_id, workspace_id, website_project_id, prospect_id,
    recommendation_context_version_id, normalized_email
  ),
  CONSTRAINT backlink_contact_candidate_parent_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, prospect_id,
    recommendation_context_version_id
  ),
  CONSTRAINT backlink_contact_candidate_prospect_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, prospect_id,
    recommendation_context_version_id
  ) REFERENCES backlink_prospects (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  )
);

CREATE TABLE backlink_contact_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  source_url text NOT NULL,
  observed_at timestamptz NOT NULL,
  extraction_method text NOT NULL,
  evidence_snippet text NOT NULL,
  parser_version text NOT NULL,
  content_sha256 text NOT NULL,
  confidence integer NOT NULL,
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_contact_evidence_source_check CHECK (
    source_url ~ '^https?://'
    AND length(btrim(evidence_snippet)) > 0
    AND length(btrim(parser_version)) > 0
  ),
  CONSTRAINT backlink_contact_evidence_method_check CHECK (
    extraction_method IN (
      'mailto', 'visible_text', 'obfuscated_text', 'json_ld', 'manual'
    )
  ),
  CONSTRAINT backlink_contact_evidence_hash_check
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_contact_evidence_confidence_check
    CHECK (confidence >= 0 AND confidence <= 100),
  CONSTRAINT backlink_contact_evidence_expiry_check
    CHECK (expires_at > observed_at),
  CONSTRAINT backlink_contact_evidence_invalidation_check CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (
      invalidated_at IS NOT NULL
      AND invalidated_at >= observed_at
      AND invalidation_reason IS NOT NULL
      AND length(btrim(invalidation_reason)) > 0
    )
  ),
  CONSTRAINT backlink_contact_evidence_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id
  ) REFERENCES backlink_contact_candidates (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_contacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  source_candidate_id uuid NOT NULL,
  normalized_email text NOT NULL,
  contact_role text NOT NULL,
  confidence integer NOT NULL,
  guessed boolean NOT NULL DEFAULT false,
  confirmed_at timestamptz NOT NULL,
  confirmed_by text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  invalidated_at timestamptz,
  invalidation_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_contact_email_check CHECK (
    normalized_email = lower(normalized_email)
    AND length(btrim(normalized_email)) > 3
  ),
  CONSTRAINT backlink_contact_role_check
    CHECK (length(btrim(contact_role)) > 0),
  CONSTRAINT backlink_contact_confidence_check
    CHECK (confidence >= 0 AND confidence <= 100),
  CONSTRAINT backlink_contact_confirmation_check CHECK (
    length(btrim(confirmed_by)) > 0
  ),
  CONSTRAINT backlink_contact_status_check
    CHECK (status IN ('active', 'invalid')),
  CONSTRAINT backlink_contact_invalidation_check CHECK (
    (status = 'invalid'
      AND invalidated_at IS NOT NULL
      AND invalidated_at >= confirmed_at
      AND invalidation_reason IS NOT NULL
      AND length(btrim(invalidation_reason)) > 0)
    OR (status = 'active'
      AND invalidated_at IS NULL
      AND invalidation_reason IS NULL)
  ),
  CONSTRAINT backlink_contact_version_check CHECK (version > 0),
  CONSTRAINT backlink_contact_email_uq UNIQUE (
    organization_id, workspace_id, website_project_id, prospect_id,
    recommendation_context_version_id, normalized_email
  ),
  CONSTRAINT backlink_contact_source_candidate_uq UNIQUE (
    organization_id, workspace_id, website_project_id, source_candidate_id
  ),
  CONSTRAINT backlink_contact_source_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, source_candidate_id,
    prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_contact_candidates (
    organization_id, workspace_id, website_project_id, id, prospect_id,
    recommendation_context_version_id
  )
);

ALTER TABLE backlink_contact_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_contact_candidate_tenant_policy
  ON backlink_contact_candidates
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

CREATE POLICY backlink_contact_evidence_tenant_policy
  ON backlink_contact_evidence
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

CREATE POLICY backlink_contact_tenant_policy
  ON backlink_contacts
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
