BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_outreach_profile_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  profile_version_id text NOT NULL,
  promotion_target_version_id text NOT NULL,
  keywords_and_topics jsonb NOT NULL,
  products_and_services jsonb NOT NULL,
  target_urls jsonb NOT NULL,
  target_audiences jsonb NOT NULL,
  partnership_goals jsonb NOT NULL,
  market text NOT NULL,
  location text NOT NULL,
  language text NOT NULL,
  authorized_discovery_sources jsonb NOT NULL,
  immutable_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_outreach_profile_scope_fingerprint_uq UNIQUE (
    organization_id, workspace_id, website_project_id, immutable_fingerprint
  ),
  CONSTRAINT backlink_outreach_profile_scope_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, profile_version_id
  ),
  CONSTRAINT backlink_outreach_profile_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_outreach_profile_arrays_ck CHECK (
    jsonb_typeof(keywords_and_topics) = 'array'
    AND jsonb_typeof(products_and_services) = 'array'
    AND jsonb_typeof(target_urls) = 'array'
    AND jsonb_typeof(target_audiences) = 'array'
    AND jsonb_typeof(partnership_goals) = 'array'
    AND jsonb_typeof(authorized_discovery_sources) = 'array'
  )
);

CREATE TABLE backlink_shared_seo_evidence_references (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  evidence_type text NOT NULL,
  source_module text NOT NULL,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  normalized_parameters jsonb NOT NULL,
  request_fingerprint text NOT NULL,
  market text NOT NULL,
  location text NOT NULL,
  language text NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  provider_request_id text NOT NULL,
  provider_task_id text,
  cost_micros bigint,
  artifact_ref text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_shared_evidence_source_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    source_module, source_record_id, source_version
  ),
  CONSTRAINT backlink_shared_evidence_values_ck CHECK (
    source_module IN (
      'site-profile', 'keywords', 'competitor-serp', 'content', 'gsc'
    )
    AND status IN ('ready', 'expired', 'failed')
    AND expires_at > fetched_at
    AND (cost_micros IS NULL OR cost_micros >= 0)
  )
);

CREATE TABLE backlink_generation_input_pins (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  project_context_version integer NOT NULL,
  site_profile_version_id text NOT NULL,
  outreach_profile_version_id uuid NOT NULL,
  promotion_target_version_id text NOT NULL,
  keyword_evidence_snapshot_ids jsonb NOT NULL,
  shared_evidence_snapshot_ids jsonb NOT NULL,
  market text NOT NULL,
  qualification_contract_version text NOT NULL,
  immutable_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_generation_input_pin_scope_fingerprint_uq UNIQUE (
    organization_id, workspace_id, website_project_id, immutable_fingerprint
  ),
  CONSTRAINT backlink_generation_input_pin_values_ck CHECK (
    project_context_version > 0
    AND jsonb_typeof(keyword_evidence_snapshot_ids) = 'array'
    AND jsonb_typeof(shared_evidence_snapshot_ids) = 'array'
  ),
  CONSTRAINT backlink_generation_input_pin_outreach_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    outreach_profile_version_id
  ) REFERENCES backlink_outreach_profile_versions (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION backlink_reject_immutable_project_input()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Backlinks project input versions are immutable.';
END;
$function$;

CREATE TRIGGER backlink_outreach_profile_immutable
BEFORE UPDATE OR DELETE ON backlink_outreach_profile_versions
FOR EACH ROW EXECUTE FUNCTION backlink_reject_immutable_project_input();

CREATE TRIGGER backlink_shared_evidence_reference_immutable
BEFORE UPDATE OR DELETE ON backlink_shared_seo_evidence_references
FOR EACH ROW EXECUTE FUNCTION backlink_reject_immutable_project_input();

CREATE TRIGGER backlink_generation_input_pin_immutable
BEFORE UPDATE OR DELETE ON backlink_generation_input_pins
FOR EACH ROW EXECUTE FUNCTION backlink_reject_immutable_project_input();

ALTER TABLE backlink_outreach_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_outreach_profile_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_outreach_profile_tenant_policy
ON backlink_outreach_profile_versions
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

ALTER TABLE backlink_shared_seo_evidence_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_shared_seo_evidence_references FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_shared_evidence_reference_tenant_policy
ON backlink_shared_seo_evidence_references
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

ALTER TABLE backlink_generation_input_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_generation_input_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_generation_input_pin_tenant_policy
ON backlink_generation_input_pins
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

CREATE OR REPLACE FUNCTION backlink_list_project_retained_dependencies(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text
)
RETURNS TABLE (
  owner_module text,
  record_type text,
  record_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.current_organization_id', p_organization_id, true);
  PERFORM set_config('app.current_workspace_id', p_workspace_id, true);
  PERFORM set_config('app.current_website_project_id', p_website_project_id, true);
  PERFORM set_config('app.current_project_id', p_website_project_id, true);

  RETURN QUERY
  SELECT 'BACKLINKS', 'opportunity', item.id::text
    FROM (
      SELECT id FROM backlink_opportunities
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'GMAIL', 'project_mailbox_binding', item.id::text
    FROM (
      SELECT id FROM backlink_website_project_mailbox_bindings
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'REPLY', 'inbound_message', item.id::text
    FROM (
      SELECT id FROM backlink_inbound_messages
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'PLACEMENT', 'placement', item.id::text
    FROM (
      SELECT id FROM backlink_placements
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'LINKS', 'inventory_item', item.id::text
    FROM (
      SELECT id FROM backlink_inventory_items
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'MONITORING', 'inventory_monitor_observation', item.id::text
    FROM (
      SELECT id FROM backlink_inventory_monitor_observations
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'REPORT', 'report_revision', item.id::text
    FROM (
      SELECT id FROM backlink_report_revisions
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item;
END;
$function$;

REVOKE ALL
  ON FUNCTION backlink_list_project_retained_dependencies(text, text, text)
  FROM PUBLIC;

GRANT SELECT, INSERT
  ON backlink_outreach_profile_versions,
     backlink_shared_seo_evidence_references,
     backlink_generation_input_pins
  TO growthos_backlinks_writer;

GRANT USAGE ON SCHEMA backlinks TO growthos_platform_writer;
GRANT EXECUTE
  ON FUNCTION backlink_list_project_retained_dependencies(text, text, text)
  TO growthos_platform_writer;

COMMIT;
