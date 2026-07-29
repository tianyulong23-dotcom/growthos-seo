CREATE TABLE backlink_prospects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  hostname_ascii text NOT NULL,
  registrable_domain text NOT NULL,
  normalization_version text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_prospect_hostname_check CHECK (
    length(btrim(hostname_ascii)) > 0
    AND hostname_ascii = lower(hostname_ascii)
    AND hostname_ascii !~ '\.$'
  ),
  CONSTRAINT backlink_prospect_registrable_domain_check CHECK (
    length(btrim(registrable_domain)) > 0
    AND registrable_domain = lower(registrable_domain)
    AND registrable_domain !~ '\.$'
  ),
  CONSTRAINT backlink_prospect_normalization_version_check
    CHECK (length(btrim(normalization_version)) > 0),
  CONSTRAINT backlink_prospect_version_check CHECK (version > 0),
  CONSTRAINT backlink_prospect_context_parent_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, id,
      recommendation_context_version_id
    ),
  CONSTRAINT backlink_prospect_project_context_hostname_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id,
      recommendation_context_version_id, hostname_ascii
    )
);

CREATE TABLE backlink_recommendations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'evaluating',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_recommendation_status_check CHECK (
    status IN (
      'candidate_raw', 'evaluating', 'ready', 'shown', 'excluded',
      'stale_context', 'accepted'
    )
  ),
  CONSTRAINT backlink_recommendation_version_check CHECK (version > 0),
  CONSTRAINT backlink_recommendation_prospect_context_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, prospect_id,
      recommendation_context_version_id
    ),
  CONSTRAINT backlink_recommendation_score_parent_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, id, prospect_id,
      recommendation_context_version_id
    ),
  CONSTRAINT backlink_recommendation_prospect_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, prospect_id,
      recommendation_context_version_id
    )
    REFERENCES backlink_prospects (
      organization_id, workspace_id, website_project_id, id,
      recommendation_context_version_id
    )
);

CREATE TABLE backlink_recommendation_scores (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  score_model_version text NOT NULL,
  rule_version text NOT NULL,
  total_score numeric(7, 4) NOT NULL,
  components jsonb NOT NULL,
  weights jsonb NOT NULL,
  evidence jsonb NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_recommendation_score_versions_check CHECK (
    length(btrim(score_model_version)) > 0
    AND length(btrim(rule_version)) > 0
  ),
  CONSTRAINT backlink_recommendation_score_range_check
    CHECK (total_score >= 0 AND total_score <= 100),
  CONSTRAINT backlink_recommendation_score_json_check CHECK (
    jsonb_typeof(components) = 'array'
    AND jsonb_typeof(weights) = 'object'
    AND jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT backlink_recommendation_score_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, website_project_id, id),
  CONSTRAINT backlink_recommendation_score_parent_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, recommendation_id,
      prospect_id, recommendation_context_version_id
    )
    REFERENCES backlink_recommendations (
      organization_id, workspace_id, website_project_id, id, prospect_id,
      recommendation_context_version_id
  )
);

CREATE TABLE backlink_recommendation_inventory (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_rec_inventory_status_check CHECK (
    status IN (
      'ready', 'claimed', 'shown', 'rejected', 'stale_context', 'accepted'
    )
  ),
  CONSTRAINT backlink_rec_inventory_version_check CHECK (version > 0),
  CONSTRAINT backlink_rec_inventory_recommendation_context_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, recommendation_id,
      recommendation_context_version_id
    ),
  CONSTRAINT backlink_rec_inventory_parent_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, id,
      recommendation_id, prospect_id, recommendation_context_version_id
    ),
  CONSTRAINT backlink_rec_inventory_recommendation_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, recommendation_id,
      prospect_id, recommendation_context_version_id
    )
    REFERENCES backlink_recommendations (
      organization_id, workspace_id, website_project_id, id, prospect_id,
      recommendation_context_version_id
    )
);

CREATE TABLE backlink_recommendation_claims (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inventory_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  claim_token text NOT NULL,
  claimed_by text NOT NULL,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_rec_claim_status_check
    CHECK (status IN ('active', 'released', 'consumed')),
  CONSTRAINT backlink_rec_claim_lease_check
    CHECK (lease_expires_at > claimed_at),
  CONSTRAINT backlink_rec_claim_finish_check CHECK (
    (status = 'active' AND finished_at IS NULL)
    OR (
      status IN ('released', 'consumed')
      AND finished_at IS NOT NULL
      AND finished_at >= claimed_at
    )
  ),
  CONSTRAINT backlink_rec_claim_token_check
    CHECK (length(btrim(claim_token)) > 0),
  CONSTRAINT backlink_rec_claim_actor_check
    CHECK (length(btrim(claimed_by)) > 0),
  CONSTRAINT backlink_rec_claim_version_check CHECK (version > 0),
  CONSTRAINT backlink_rec_claim_inventory_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, inventory_id
    ),
  CONSTRAINT backlink_rec_claim_token_uq
    UNIQUE (workspace_id, claim_token),
  CONSTRAINT backlink_rec_claim_inventory_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, inventory_id,
      recommendation_id, prospect_id, recommendation_context_version_id
    )
    REFERENCES backlink_recommendation_inventory (
      organization_id, workspace_id, website_project_id, id,
      recommendation_id, prospect_id, recommendation_context_version_id
    )
);

CREATE TABLE backlink_recommendation_rejections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inventory_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  rejection_type text NOT NULL,
  reason_code text NOT NULL,
  rejected_at timestamptz NOT NULL,
  cooldown_until timestamptz,
  rejected_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_rec_rejection_type_check CHECK (
    rejection_type IN ('skipped', 'permanently_rejected')
  ),
  CONSTRAINT backlink_rec_rejection_reason_check
    CHECK (length(btrim(reason_code)) > 0),
  CONSTRAINT backlink_rec_rejection_actor_check
    CHECK (length(btrim(rejected_by)) > 0),
  CONSTRAINT backlink_rec_rejection_cooldown_check CHECK (
    (
      rejection_type = 'skipped'
      AND cooldown_until IS NOT NULL
      AND cooldown_until > rejected_at
    )
    OR (
      rejection_type = 'permanently_rejected'
      AND cooldown_until IS NULL
    )
  ),
  CONSTRAINT backlink_rec_rejection_inventory_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, inventory_id,
      recommendation_id, prospect_id, recommendation_context_version_id
    )
    REFERENCES backlink_recommendation_inventory (
      organization_id, workspace_id, website_project_id, id,
      recommendation_id, prospect_id, recommendation_context_version_id
    )
);

CREATE TABLE backlink_recommendation_refills (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  trigger_reason text NOT NULL,
  low_watermark integer NOT NULL,
  high_watermark integer NOT NULL,
  refill_window_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_rec_refill_trigger_check
    CHECK (trigger_reason IN ('inventory_low', 'manual')),
  CONSTRAINT backlink_rec_refill_watermark_check
    CHECK (low_watermark >= 0 AND high_watermark > low_watermark),
  CONSTRAINT backlink_rec_refill_window_key_check
    CHECK (length(btrim(refill_window_key)) > 0),
  CONSTRAINT backlink_rec_refill_version_check CHECK (version > 0),
  CONSTRAINT backlink_rec_refill_job_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, job_id
    ),
  CONSTRAINT backlink_rec_refill_window_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id,
      recommendation_context_version_id, refill_window_key
    ),
  CONSTRAINT backlink_rec_refill_job_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, job_id
    )
    REFERENCES backlink_jobs (
      organization_id, workspace_id, website_project_id, id
    )
);

CREATE FUNCTION backlink_reject_recommendation_score_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'backlink_recommendation_scores are immutable';
END;
$$;

CREATE TRIGGER backlink_recommendation_score_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_scores
FOR EACH ROW EXECUTE FUNCTION backlink_reject_recommendation_score_mutation();

ALTER TABLE backlink_prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_prospects FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendations FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_scores FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_inventory FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_rejections FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_refills ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_refills FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_prospect_tenant_policy
  ON backlink_prospects
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

CREATE POLICY backlink_recommendation_tenant_policy
  ON backlink_recommendations
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

CREATE POLICY backlink_recommendation_score_tenant_policy
  ON backlink_recommendation_scores
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

CREATE POLICY backlink_rec_inventory_tenant_policy
  ON backlink_recommendation_inventory
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

CREATE POLICY backlink_rec_claim_tenant_policy
  ON backlink_recommendation_claims
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

CREATE POLICY backlink_rec_rejection_tenant_policy
  ON backlink_recommendation_rejections
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

CREATE POLICY backlink_rec_refill_tenant_policy
  ON backlink_recommendation_refills
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
