BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_recommendation_qualification_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  candidate_id uuid,
  recommendation_id uuid,
  prospect_id uuid,
  canonical_domain text NOT NULL,
  metric_scope text NOT NULL,
  traffic_organic_etv numeric(18, 4),
  spam_score numeric(7, 4),
  authority_rank numeric(7, 4),
  accessibility_decision text NOT NULL,
  semantic_score numeric(7, 4),
  attempt integer NOT NULL,
  decision text NOT NULL,
  decision_reason_code text NOT NULL,
  score_model_version text NOT NULL,
  model_version text,
  prompt_version text,
  rule_version text NOT NULL,
  fact_contract_version text NOT NULL,
  worker_contract_version text NOT NULL,
  request_fingerprints jsonb NOT NULL,
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_rec_qualification_attempt_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_domain, attempt
  ),
  CONSTRAINT backlink_rec_qualification_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_rec_qualification_values_ck CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND metric_scope IN ('TARGET_MARKET', 'GLOBAL')
    AND (traffic_organic_etv IS NULL OR traffic_organic_etv >= 0)
    AND (spam_score IS NULL OR (spam_score >= 0 AND spam_score <= 100))
    AND (
      authority_rank IS NULL
      OR (authority_rank >= 0 AND authority_rank <= 100)
    )
    AND accessibility_decision IN (
      'accessible', 'inaccessible', 'insufficient_data'
    )
    AND (
      semantic_score IS NULL
      OR (semantic_score >= 0 AND semantic_score <= 100)
    )
    AND attempt > 0
    AND decision IN (
      'eligible', 'ineligible', 'insufficient_data', 'manual_review'
    )
    AND length(btrim(decision_reason_code)) > 0
    AND score_model_version = 'recommendation-commercial-fit.v4'
    AND (model_version IS NULL OR length(btrim(model_version)) > 0)
    AND (prompt_version IS NULL OR length(btrim(prompt_version)) > 0)
    AND length(btrim(rule_version)) > 0
    AND length(btrim(fact_contract_version)) > 0
    AND length(btrim(worker_contract_version)) > 0
    AND jsonb_typeof(request_fingerprints) = 'object'
    AND jsonb_typeof(evidence) = 'object'
    AND (
      (recommendation_id IS NULL AND prospect_id IS NULL)
      OR (recommendation_id IS NOT NULL AND prospect_id IS NOT NULL)
    )
    AND (
      decision <> 'eligible'
      OR (
        traffic_organic_etv >= 30000
        AND spam_score <= 10
        AND accessibility_decision = 'accessible'
        AND semantic_score >= 60
      )
    )
  ),
  CONSTRAINT backlink_rec_qualification_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id, metric_scope
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, metric_scope
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_rec_qualification_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id
  ) REFERENCES backlink_commercial_candidates (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_rec_qualification_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_id, prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id,
    id, prospect_id, recommendation_context_version_id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_visibility_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  qualification_fact_id uuid NOT NULL,
  recommendation_id uuid,
  prospect_id uuid,
  canonical_domain text NOT NULL,
  decision text NOT NULL,
  decision_reason_code text NOT NULL,
  attempt integer NOT NULL,
  rule_version text NOT NULL,
  fact_contract_version text NOT NULL,
  worker_contract_version text NOT NULL,
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_rec_visibility_attempt_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_domain, attempt
  ),
  CONSTRAINT backlink_rec_visibility_values_ck CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND decision IN ('hidden', 'visible')
    AND length(btrim(decision_reason_code)) > 0
    AND attempt > 0
    AND length(btrim(rule_version)) > 0
    AND length(btrim(fact_contract_version)) > 0
    AND length(btrim(worker_contract_version)) > 0
    AND jsonb_typeof(evidence) = 'object'
    AND (
      (recommendation_id IS NULL AND prospect_id IS NULL)
      OR (recommendation_id IS NOT NULL AND prospect_id IS NOT NULL)
    )
  ),
  CONSTRAINT backlink_rec_visibility_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_rec_visibility_qualification_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, qualification_fact_id
  ) REFERENCES backlink_recommendation_qualification_facts (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_rec_visibility_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_id, prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id,
    id, prospect_id, recommendation_context_version_id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_contact_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  recommendation_id uuid,
  prospect_id uuid,
  canonical_domain text NOT NULL,
  decision text NOT NULL,
  decision_reason_code text NOT NULL,
  attempt integer NOT NULL,
  fact_contract_version text NOT NULL,
  worker_contract_version text NOT NULL,
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_rec_contact_attempt_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_domain, attempt
  ),
  CONSTRAINT backlink_rec_contact_values_ck CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND decision IN ('pending', 'eligible', 'ineligible', 'manual_review')
    AND length(btrim(decision_reason_code)) > 0
    AND attempt > 0
    AND length(btrim(fact_contract_version)) > 0
    AND length(btrim(worker_contract_version)) > 0
    AND jsonb_typeof(evidence) = 'object'
    AND (
      (recommendation_id IS NULL AND prospect_id IS NULL)
      OR (recommendation_id IS NOT NULL AND prospect_id IS NOT NULL)
    )
  ),
  CONSTRAINT backlink_rec_contact_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_rec_contact_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_id, prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id,
    id, prospect_id, recommendation_context_version_id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_cooperation_path_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  recommendation_id uuid,
  prospect_id uuid,
  canonical_domain text NOT NULL,
  decision text NOT NULL,
  decision_reason_code text NOT NULL,
  path_type text,
  attempt integer NOT NULL,
  fact_contract_version text NOT NULL,
  worker_contract_version text NOT NULL,
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_rec_cooperation_attempt_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_domain, attempt
  ),
  CONSTRAINT backlink_rec_cooperation_values_ck CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND decision IN ('pending', 'verified', 'unavailable', 'manual_review')
    AND length(btrim(decision_reason_code)) > 0
    AND (path_type IS NULL OR length(btrim(path_type)) > 0)
    AND attempt > 0
    AND length(btrim(fact_contract_version)) > 0
    AND length(btrim(worker_contract_version)) > 0
    AND jsonb_typeof(evidence) = 'object'
    AND (
      (recommendation_id IS NULL AND prospect_id IS NULL)
      OR (recommendation_id IS NOT NULL AND prospect_id IS NOT NULL)
    )
  ),
  CONSTRAINT backlink_rec_cooperation_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_rec_cooperation_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_id, prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id,
    id, prospect_id, recommendation_context_version_id
  ) ON DELETE RESTRICT
);

DO $facts$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'backlink_recommendation_qualification_facts',
    'backlink_recommendation_visibility_facts',
    'backlink_recommendation_contact_facts',
    'backlink_recommendation_cooperation_path_facts'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I
       BEFORE UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION
         backlink_reject_recommendation_contract_mutation()',
      table_name || '_immutable',
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I
       BEFORE INSERT ON %I
       FOR EACH ROW EXECUTE FUNCTION
         backlink_enforce_generation_fact_contract()',
      table_name || '_contract_guard',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE %I ENABLE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE %I FORCE ROW LEVEL SECURITY',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I
       USING (
         organization_id =
           NULLIF(
             current_setting(''app.current_organization_id'', true),
             ''''
           )::uuid
         AND workspace_id =
           NULLIF(
             current_setting(''app.current_workspace_id'', true),
             ''''
           )::uuid
         AND website_project_id =
           NULLIF(
             current_setting(''app.current_website_project_id'', true),
             ''''
           )::uuid
       )
       WITH CHECK (
         organization_id =
           NULLIF(
             current_setting(''app.current_organization_id'', true),
             ''''
           )::uuid
         AND workspace_id =
           NULLIF(
             current_setting(''app.current_workspace_id'', true),
             ''''
           )::uuid
         AND website_project_id =
           NULLIF(
             current_setting(''app.current_website_project_id'', true),
             ''''
           )::uuid
       )',
      table_name || '_tenant_policy',
      table_name
    );
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', table_name);
    EXECUTE format(
      'REVOKE UPDATE, DELETE ON %I FROM growthos_backlinks_writer',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON %I TO growthos_backlinks_writer',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT ON %I TO growthos_reporting_reader',
      table_name
    );
  END LOOP;
END
$facts$;

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
  SELECT 'BACKLINKS', 'recommendation_generation_contract', item.id::text
    FROM (
      SELECT id FROM backlink_recommendation_generation_contracts
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
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
GRANT EXECUTE
  ON FUNCTION backlink_list_project_retained_dependencies(text, text, text)
  TO growthos_platform_writer;

COMMIT;
