BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_inventory_items
  ADD COLUMN direct_health_status text NOT NULL DEFAULT 'pending_verification',
  ADD COLUMN direct_validation_status text NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN last_direct_checked_at timestamptz,
  ADD COLUMN restriction_reason text,
  ADD COLUMN user_notes text,
  ADD CONSTRAINT backlink_inventory_item_direct_status_check CHECK (
    direct_health_status IN (
      'pending_verification', 'active', 'suspected_changed', 'changed',
      'suspected_lost', 'lost'
    )
    AND direct_validation_status IN (
      'UNVERIFIED', 'VALID', 'SUSPECTED_CHANGED', 'CHANGED',
      'SUSPECTED_LOST', 'LOST', 'RECOVERED', 'INACCESSIBLE'
    )
    AND (
      restriction_reason IS NULL
      OR length(btrim(restriction_reason)) > 0
    )
  ),
  ADD CONSTRAINT backlink_inventory_item_canonical_urls_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    normalized_source_url, normalized_target_url
  );

RESET ROLE;
SET LOCAL search_path = backlinks, pg_catalog;

INSERT INTO backlink_inventory_items (
  id, organization_id, workspace_id, website_project_id,
  source_type, provider, provider_identity,
  normalized_source_url, normalized_target_url, source_domain,
  provider_status, first_seen_at, last_seen_at,
  placement_id, opportunity_id, managed,
  direct_health_status, direct_validation_status,
  created_at, updated_at, created_by, updated_by
)
SELECT
  placement.id,
  placement.organization_id,
  placement.workspace_id,
  placement.website_project_id,
  'USER_IMPORTED',
  'user_import',
  'placement:' || placement.id,
  placement.normalized_source_url,
  placement.normalized_target_url,
  lower(split_part(
    regexp_replace(
      placement.normalized_source_url,
      '^https?://',
      '',
      'i'
    ),
    '/',
    1
  )),
  'unknown',
  placement.created_at,
  placement.updated_at,
  placement.id,
  placement.opportunity_id,
  true,
  placement.health_status,
  CASE placement.health_status
    WHEN 'active' THEN 'VALID'
    WHEN 'suspected_changed' THEN 'SUSPECTED_CHANGED'
    WHEN 'changed' THEN 'CHANGED'
    WHEN 'suspected_lost' THEN 'SUSPECTED_LOST'
    WHEN 'lost' THEN 'LOST'
    ELSE 'UNVERIFIED'
  END,
  placement.created_at,
  placement.updated_at,
  placement.created_by,
  placement.updated_by
FROM backlink_placements placement
ON CONFLICT (
  organization_id, workspace_id, website_project_id,
  normalized_source_url, normalized_target_url
) DO UPDATE SET
  placement_id=EXCLUDED.placement_id,
  opportunity_id=COALESCE(
    backlink_inventory_items.opportunity_id,
    EXCLUDED.opportunity_id
  ),
  managed=true,
  direct_health_status=EXCLUDED.direct_health_status,
  direct_validation_status=EXCLUDED.direct_validation_status,
  updated_at=GREATEST(
    backlink_inventory_items.updated_at,
    EXCLUDED.updated_at
  ),
  updated_by=EXCLUDED.updated_by,
  version=backlink_inventory_items.version+1;

SET LOCAL ROLE growthos_backlinks_owner;

CREATE TABLE backlink_inventory_monitor_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  tier text NOT NULL,
  importance text NOT NULL DEFAULT 'normal',
  monitoring_status text NOT NULL DEFAULT 'enabled',
  policy_version text NOT NULL,
  normal_interval_seconds integer NOT NULL,
  suspected_recheck_interval_seconds integer NOT NULL DEFAULT 3600,
  jitter_window_seconds integer NOT NULL DEFAULT 3600,
  retry_initial_delay_seconds integer NOT NULL DEFAULT 60,
  retry_max_delay_seconds integer NOT NULL DEFAULT 3600,
  retry_backoff_multiplier integer NOT NULL DEFAULT 2,
  max_retry_attempts integer NOT NULL DEFAULT 3,
  loss_confirmation_count integer NOT NULL DEFAULT 2,
  change_confirmation_count integer NOT NULL DEFAULT 2,
  browser_fallback_enabled boolean NOT NULL DEFAULT false,
  next_check_at timestamptz,
  provider_only_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_inventory_monitor_policy_values_check CHECK (
    tier IN ('A', 'B', 'C')
    AND importance IN ('normal', 'important')
    AND monitoring_status IN ('enabled', 'paused', 'provider_only')
    AND policy_version = 'inventory-monitoring-v1'
    AND normal_interval_seconds BETWEEN 300 AND 2592000
    AND suspected_recheck_interval_seconds BETWEEN 60
      AND normal_interval_seconds
    AND jitter_window_seconds BETWEEN 0 AND normal_interval_seconds
    AND retry_initial_delay_seconds BETWEEN 1 AND retry_max_delay_seconds
    AND retry_max_delay_seconds <= 86400
    AND retry_backoff_multiplier BETWEEN 2 AND 10
    AND max_retry_attempts BETWEEN 0 AND 10
    AND loss_confirmation_count BETWEEN 2 AND 10
    AND change_confirmation_count BETWEEN 2 AND 10
    AND version > 0
    AND (
      (
        monitoring_status IN ('enabled', 'paused')
        AND next_check_at IS NOT NULL
        AND provider_only_reason IS NULL
      )
      OR (
        monitoring_status = 'provider_only'
        AND next_check_at IS NULL
        AND length(btrim(provider_only_reason)) > 0
      )
    )
  ),
  CONSTRAINT backlink_inventory_monitor_policy_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    inventory_item_id, policy_version
  ),
  CONSTRAINT backlink_inventory_monitor_policy_item_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, policy_version
  ),
  CONSTRAINT backlink_inventory_monitor_policy_item_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inventory_item_id
  ) REFERENCES backlink_inventory_items (
    organization_id, workspace_id, website_project_id, id
  )
);

RESET ROLE;
SET LOCAL search_path = backlinks, pg_catalog;

INSERT INTO backlink_inventory_monitor_policies (
  id, organization_id, workspace_id, website_project_id,
  inventory_item_id, tier, importance, monitoring_status,
  policy_version, normal_interval_seconds,
  suspected_recheck_interval_seconds, jitter_window_seconds,
  browser_fallback_enabled, next_check_at,
  created_at, updated_at, created_by, updated_by
)
SELECT
  inventory.id,
  inventory.organization_id,
  inventory.workspace_id,
  inventory.website_project_id,
  inventory.id,
  CASE
    WHEN inventory.placement_id IS NOT NULL
      OR inventory.pinned
      OR inventory.managed
      OR inventory.provider_status = 'lost'
      THEN 'A'
    WHEN COALESCE(inventory.rank, 0) >= 60 THEN 'B'
    ELSE 'C'
  END,
  CASE WHEN inventory.pinned THEN 'important' ELSE 'normal' END,
  'enabled',
  'inventory-monitoring-v1',
  CASE
    WHEN inventory.placement_id IS NOT NULL
      OR inventory.pinned
      OR inventory.managed
      OR inventory.provider_status = 'lost'
      THEN 86400
    WHEN COALESCE(inventory.rank, 0) >= 60 THEN 604800
    ELSE 2592000
  END,
  3600,
  CASE
    WHEN inventory.placement_id IS NOT NULL
      OR inventory.pinned
      OR inventory.managed
      OR inventory.provider_status = 'lost'
      THEN 3600
    WHEN COALESCE(inventory.rank, 0) >= 60 THEN 21600
    ELSE 86400
  END,
  false,
  now(),
  now(),
  now(),
  'migration-0051',
  'migration-0051'
FROM backlink_inventory_items inventory
ON CONFLICT (
  organization_id, workspace_id, website_project_id,
  inventory_item_id, policy_version
) DO NOTHING;

SET LOCAL ROLE growthos_backlinks_owner;

CREATE TABLE backlink_inventory_monitor_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  monitor_policy_id uuid NOT NULL,
  backlink_job_id uuid NOT NULL,
  policy_version text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  execution_mode text NOT NULL DEFAULT 'static',
  status text NOT NULL DEFAULT 'SCHEDULED',
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  retry_after_seconds integer,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_inventory_monitor_run_values_check CHECK (
    policy_version = 'inventory-monitoring-v1'
    AND execution_mode = 'static'
    AND status IN (
      'SCHEDULED', 'RUNNING', 'RETRY_WAIT',
      'SUCCEEDED', 'FAILED', 'CANCELLED'
    )
    AND attempt_count >= 0
    AND (retry_after_seconds IS NULL OR retry_after_seconds > 0)
    AND (error_code IS NULL OR length(btrim(error_code)) > 0)
    AND (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
    AND version > 0
  ),
  CONSTRAINT backlink_inventory_monitor_run_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    inventory_item_id, monitor_policy_id, policy_version,
    scheduled_for, execution_mode
  ),
  CONSTRAINT backlink_inventory_monitor_run_schedule_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, scheduled_for, policy_version, execution_mode
  ),
  CONSTRAINT backlink_inventory_monitor_run_item_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inventory_item_id
  ) REFERENCES backlink_inventory_items (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_monitor_run_policy_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    monitor_policy_id, inventory_item_id, policy_version
  ) REFERENCES backlink_inventory_monitor_policies (
    organization_id, workspace_id, website_project_id,
    id, inventory_item_id, policy_version
  ),
  CONSTRAINT backlink_inventory_monitor_run_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, backlink_job_id
  ) REFERENCES backlink_jobs (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_inventory_monitor_observations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  monitor_run_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  monitor_policy_id uuid NOT NULL,
  policy_version text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  execution_mode text NOT NULL DEFAULT 'static',
  result text NOT NULL,
  direct_validation_status text NOT NULL,
  failure_code text,
  restriction_reason text,
  evidence_snapshot jsonb NOT NULL,
  evidence_snapshot_hash text NOT NULL,
  evidence_fingerprint text NOT NULL,
  evidence_contract_version text NOT NULL,
  evidence_schema_version integer NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_inventory_monitor_observation_values_check CHECK (
    policy_version = 'inventory-monitoring-v1'
    AND execution_mode = 'static'
    AND result IN ('present', 'changed', 'absent', 'inaccessible')
    AND direct_validation_status IN (
      'VALID', 'SUSPECTED_CHANGED', 'CHANGED',
      'SUSPECTED_LOST', 'LOST', 'RECOVERED', 'INACCESSIBLE'
    )
    AND (
      (result = 'inaccessible' AND length(btrim(failure_code)) > 0)
      OR (result <> 'inaccessible' AND failure_code IS NULL)
    )
    AND (
      restriction_reason IS NULL
      OR length(btrim(restriction_reason)) > 0
    )
    AND jsonb_typeof(evidence_snapshot) = 'object'
    AND evidence_snapshot_hash ~ '^[a-f0-9]{64}$'
    AND evidence_fingerprint ~ '^[a-f0-9]{64}$'
    AND length(btrim(evidence_contract_version)) > 0
    AND evidence_schema_version > 0
  ),
  CONSTRAINT backlink_inventory_monitor_observation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_monitor_observation_run_uq UNIQUE (
    organization_id, workspace_id, website_project_id, monitor_run_id
  ),
  CONSTRAINT backlink_inventory_monitor_observation_run_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    monitor_run_id, inventory_item_id, monitor_policy_id,
    policy_version, scheduled_for, execution_mode
  ) REFERENCES backlink_inventory_monitor_runs (
    organization_id, workspace_id, website_project_id,
    id, inventory_item_id, monitor_policy_id,
    policy_version, scheduled_for, execution_mode
  )
);

ALTER TABLE backlink_inventory_items
  ADD COLUMN latest_direct_evidence_id uuid,
  ADD CONSTRAINT backlink_inventory_item_direct_evidence_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    latest_direct_evidence_id
  ) REFERENCES backlink_inventory_monitor_observations (
    organization_id, workspace_id, website_project_id, id
  );

CREATE TABLE backlink_inventory_monitor_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  monitor_policy_id uuid NOT NULL,
  run_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  policy_version text NOT NULL DEFAULT 'inventory-monitoring-v1',
  scheduled_for timestamptz NOT NULL,
  requested_at timestamptz NOT NULL,
  requested_by text NOT NULL,
  CONSTRAINT backlink_inventory_monitor_request_values_check CHECK (
    length(btrim(idempotency_key)) > 0
    AND length(btrim(requested_by)) > 0
    AND policy_version = 'inventory-monitoring-v1'
  ),
  CONSTRAINT backlink_inventory_monitor_request_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id, idempotency_key
  ),
  CONSTRAINT backlink_inventory_monitor_request_run_uq UNIQUE (
    organization_id, workspace_id, website_project_id, run_id
  ),
  CONSTRAINT backlink_inventory_monitor_request_policy_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    monitor_policy_id, inventory_item_id, policy_version
  ) REFERENCES backlink_inventory_monitor_policies (
    organization_id, workspace_id, website_project_id,
    id, inventory_item_id, policy_version
  )
);

CREATE FUNCTION backlink_apply_inventory_monitor_policy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  computed_tier text;
  computed_interval integer;
  computed_jitter integer;
BEGIN
  computed_tier := CASE
    WHEN NEW.placement_id IS NOT NULL
      OR NEW.pinned
      OR NEW.managed
      OR NEW.provider_status = 'lost'
      THEN 'A'
    WHEN COALESCE(NEW.rank, 0) >= 60 THEN 'B'
    ELSE 'C'
  END;
  computed_interval := CASE computed_tier
    WHEN 'A' THEN 86400
    WHEN 'B' THEN 604800
    ELSE 2592000
  END;
  computed_jitter := CASE computed_tier
    WHEN 'A' THEN 3600
    WHEN 'B' THEN 21600
    ELSE 86400
  END;

  INSERT INTO backlink_inventory_monitor_policies (
    id, organization_id, workspace_id, website_project_id,
    inventory_item_id, tier, importance, monitoring_status,
    policy_version, normal_interval_seconds,
    suspected_recheck_interval_seconds, jitter_window_seconds,
    browser_fallback_enabled, next_check_at,
    created_at, updated_at, created_by, updated_by
  )
  VALUES (
    NEW.id, NEW.organization_id, NEW.workspace_id, NEW.website_project_id,
    NEW.id, computed_tier,
    CASE WHEN NEW.pinned THEN 'important' ELSE 'normal' END,
    'enabled', 'inventory-monitoring-v1', computed_interval,
    3600, computed_jitter, false, now(),
    now(), now(), NEW.created_by, NEW.updated_by
  )
  ON CONFLICT (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, policy_version
  ) DO UPDATE SET
    tier=CASE
      WHEN backlink_inventory_monitor_policies.importance = 'important'
        THEN 'A'
      ELSE EXCLUDED.tier
    END,
    normal_interval_seconds=CASE
      WHEN backlink_inventory_monitor_policies.importance = 'important'
        THEN 86400
      ELSE EXCLUDED.normal_interval_seconds
    END,
    jitter_window_seconds=CASE
      WHEN backlink_inventory_monitor_policies.importance = 'important'
        THEN 3600
      ELSE EXCLUDED.jitter_window_seconds
    END,
    next_check_at=CASE
      WHEN backlink_inventory_monitor_policies.monitoring_status = 'enabled'
        THEN LEAST(
          backlink_inventory_monitor_policies.next_check_at,
          now()
        )
      ELSE backlink_inventory_monitor_policies.next_check_at
    END,
    updated_at=now(),
    updated_by=EXCLUDED.updated_by,
    version=backlink_inventory_monitor_policies.version+1;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_inventory_monitor_policy_apply
AFTER INSERT OR UPDATE OF placement_id, pinned, managed, provider_status, rank
ON backlink_inventory_items
FOR EACH ROW
EXECUTE FUNCTION backlink_apply_inventory_monitor_policy();

CREATE FUNCTION backlink_merge_placement_into_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  INSERT INTO backlink_inventory_items (
    id, organization_id, workspace_id, website_project_id,
    source_type, provider, provider_identity,
    normalized_source_url, normalized_target_url, source_domain,
    provider_status, first_seen_at, last_seen_at,
    placement_id, opportunity_id, managed,
    direct_health_status, direct_validation_status,
    created_at, updated_at, created_by, updated_by
  )
  VALUES (
    NEW.id, NEW.organization_id, NEW.workspace_id, NEW.website_project_id,
    'USER_IMPORTED', 'user_import', 'placement:' || NEW.id,
    NEW.normalized_source_url, NEW.normalized_target_url,
    lower(split_part(
      regexp_replace(NEW.normalized_source_url, '^https?://', '', 'i'),
      '/',
      1
    )),
    'unknown', NEW.created_at, NEW.updated_at,
    NEW.id, NEW.opportunity_id, true,
    NEW.health_status,
    CASE NEW.health_status
      WHEN 'active' THEN 'VALID'
      WHEN 'suspected_changed' THEN 'SUSPECTED_CHANGED'
      WHEN 'changed' THEN 'CHANGED'
      WHEN 'suspected_lost' THEN 'SUSPECTED_LOST'
      WHEN 'lost' THEN 'LOST'
      ELSE 'UNVERIFIED'
    END,
    NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by
  )
  ON CONFLICT (
    organization_id, workspace_id, website_project_id,
    normalized_source_url, normalized_target_url
  ) DO UPDATE SET
    placement_id=EXCLUDED.placement_id,
    opportunity_id=COALESCE(
      backlink_inventory_items.opportunity_id,
      EXCLUDED.opportunity_id
    ),
    managed=true,
    direct_health_status=EXCLUDED.direct_health_status,
    direct_validation_status=EXCLUDED.direct_validation_status,
    updated_at=GREATEST(
      backlink_inventory_items.updated_at,
      EXCLUDED.updated_at
    ),
    updated_by=EXCLUDED.updated_by,
    version=backlink_inventory_items.version+1;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_placement_inventory_merge
AFTER INSERT OR UPDATE OF
  normalized_source_url, normalized_target_url, health_status, opportunity_id
ON backlink_placements
FOR EACH ROW
EXECUTE FUNCTION backlink_merge_placement_into_inventory();

CREATE FUNCTION backlink_reject_inventory_monitor_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Backlink inventory monitoring observations are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_inventory_monitor_observation_immutable
BEFORE UPDATE OR DELETE ON backlink_inventory_monitor_observations
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_inventory_monitor_observation_mutation();

CREATE INDEX backlink_inventory_monitor_policy_due_idx
  ON backlink_inventory_monitor_policies (
    organization_id, workspace_id, website_project_id,
    monitoring_status, next_check_at
  );
CREATE INDEX backlink_inventory_monitor_observation_item_idx
  ON backlink_inventory_monitor_observations (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, observed_at DESC
  );

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'backlink_inventory_monitor_policies',
    'backlink_inventory_monitor_runs',
    'backlink_inventory_monitor_observations',
    'backlink_inventory_monitor_requests'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (
         organization_id =
           NULLIF(current_setting(''app.current_organization_id'', true), '''')::uuid
         AND workspace_id =
           NULLIF(current_setting(''app.current_workspace_id'', true), '''')::uuid
         AND website_project_id =
           NULLIF(current_setting(''app.current_website_project_id'', true), '''')::uuid
       ) WITH CHECK (
         organization_id =
           NULLIF(current_setting(''app.current_organization_id'', true), '''')::uuid
         AND workspace_id =
           NULLIF(current_setting(''app.current_workspace_id'', true), '''')::uuid
         AND website_project_id =
           NULLIF(current_setting(''app.current_website_project_id'', true), '''')::uuid
       )',
      table_name || '_tenant_policy',
      table_name
    );
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', table_name);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON %I TO growthos_backlinks_writer',
      table_name
    );
    EXECUTE format(
      'GRANT SELECT ON %I TO growthos_reporting_reader',
      table_name
    );
  END LOOP;
END
$$;

REVOKE UPDATE, DELETE
  ON backlink_inventory_monitor_observations
  FROM growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_inventory_monitor_observations
  TO growthos_backlinks_writer;

COMMIT;
