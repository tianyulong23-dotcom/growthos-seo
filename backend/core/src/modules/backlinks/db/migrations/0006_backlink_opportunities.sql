BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_opportunities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  target_site_key text NOT NULL,
  target_host_ascii text NOT NULL,
  target_identity_kind text NOT NULL DEFAULT 'registrable_domain',
  target_identity_rule_version text NOT NULL,
  target_identity_override_reason text,
  join_sequence integer NOT NULL,
  business_stage text NOT NULL DEFAULT 'JOINED',
  management_status text NOT NULL DEFAULT 'ACTIVE',
  outcome_status text NOT NULL DEFAULT 'OPEN',
  fulfillment_status text NOT NULL DEFAULT 'NOT_EXPECTED',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_opportunity_target_site_check CHECK (
    length(btrim(target_site_key)) > 0
    AND target_site_key = lower(target_site_key)
    AND target_site_key !~ '\.$'
    AND length(btrim(target_host_ascii)) > 0
    AND target_host_ascii = lower(target_host_ascii)
    AND target_host_ascii !~ '\.$'
  ),
  CONSTRAINT backlink_opportunity_target_identity_check CHECK (
    target_identity_kind IN ('registrable_domain', 'exact_host')
    AND length(btrim(target_identity_rule_version)) > 0
    AND (
      (target_identity_kind = 'registrable_domain'
        AND target_identity_override_reason IS NULL)
      OR
      (target_identity_kind = 'exact_host'
        AND length(btrim(target_identity_override_reason)) > 0)
    )
  ),
  CONSTRAINT backlink_opportunity_join_sequence_check
    CHECK (join_sequence > 0),
  CONSTRAINT backlink_opportunity_business_stage_check CHECK (
    business_stage IN (
      'JOINED', 'CONTACT_PREPARING', 'READY_TO_CONTACT',
      'OUTREACH_ACTIVE', 'NEGOTIATING', 'AGREED', 'WAITING_PLACEMENT',
      'RELATIONSHIP_ACTIVE', 'CLOSED'
    )
  ),
  CONSTRAINT backlink_opportunity_management_status_check
    CHECK (management_status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  CONSTRAINT backlink_opportunity_outcome_status_check
    CHECK (outcome_status IN ('OPEN', 'WON', 'LOST')),
  CONSTRAINT backlink_opportunity_fulfillment_status_check CHECK (
    fulfillment_status IN (
      'NOT_EXPECTED', 'PENDING', 'PARTIAL', 'FULFILLED'
    )
  ),
  CONSTRAINT backlink_opportunity_version_check CHECK (version > 0),
  CONSTRAINT backlink_opportunity_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_opportunity_project_target_site_uq UNIQUE (
    website_project_id, target_site_key
  ),
  CONSTRAINT backlink_opportunity_project_join_sequence_uq UNIQUE (
    website_project_id, join_sequence
  ),
  CONSTRAINT backlink_opportunity_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, recommendation_id,
    prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id, id, prospect_id,
    recommendation_context_version_id
  )
);

CREATE TABLE backlink_opportunity_cycles (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  cycle_number integer NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  close_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_opportunity_cycle_number_check
    CHECK (cycle_number > 0),
  CONSTRAINT backlink_opportunity_cycle_close_check CHECK (
    (ended_at IS NULL AND close_reason IS NULL)
    OR (
      ended_at IS NOT NULL
      AND ended_at >= started_at
      AND length(btrim(close_reason)) > 0
    )
  ),
  CONSTRAINT backlink_opportunity_cycle_version_check CHECK (version > 0),
  CONSTRAINT backlink_opportunity_cycle_number_uq UNIQUE (
    opportunity_id, cycle_number
  ),
  CONSTRAINT backlink_opportunity_cycle_parent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_opportunity_cooperation_types (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  method_key text NOT NULL,
  registry_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_opportunity_cooperation_method_check CHECK (
    method_key IN (
      'guest_post', 'blogger_outreach', 'link_insertion', 'resource_page',
      'broken_link', 'partnership', 'sponsored_post', 'other'
    )
  ),
  CONSTRAINT backlink_opportunity_cooperation_registry_check
    CHECK (length(btrim(registry_version)) > 0),
  CONSTRAINT backlink_opportunity_cooperation_method_uq UNIQUE (
    opportunity_id, method_key
  ),
  CONSTRAINT backlink_opportunity_cooperation_parent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

ALTER TABLE backlink_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunities FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_cycles FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_cooperation_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_cooperation_types FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_opportunity_tenant_policy
  ON backlink_opportunities
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

CREATE POLICY backlink_opportunity_cycle_tenant_policy
  ON backlink_opportunity_cycles
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

CREATE POLICY backlink_opportunity_cooperation_tenant_policy
  ON backlink_opportunity_cooperation_types
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

COMMIT;
