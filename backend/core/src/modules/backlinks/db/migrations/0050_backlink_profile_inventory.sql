BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_profile_sync_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  backlink_job_id uuid NOT NULL,
  canonical_domain text NOT NULL,
  sync_mode text NOT NULL,
  trigger_source text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  provider text NOT NULL DEFAULT 'dataforseo',
  requested_cursor text,
  total_count bigint,
  pulled_count integer NOT NULL DEFAULT 0,
  inventory_coverage numeric(7,6),
  estimated_cost_micros bigint NOT NULL DEFAULT 0,
  actual_cost_micros bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  next_sync_at timestamptz,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_profile_sync_job_values_check CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND sync_mode IN ('initial_full', 'incremental', 'page')
    AND trigger_source IN ('manual', 'schedule', 'continuation')
    AND status IN (
      'queued', 'running', 'completed', 'partial',
      'waiting_provider', 'failed'
    )
    AND provider IN ('dataforseo', 'user_import')
    AND pulled_count >= 0
    AND estimated_cost_micros >= 0
    AND actual_cost_micros >= 0
    AND version > 0
    AND (
      inventory_coverage IS NULL
      OR inventory_coverage BETWEEN 0 AND 1
    )
  ),
  CONSTRAINT backlink_profile_sync_job_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_sync_job_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id, idempotency_key
  ),
  CONSTRAINT backlink_profile_sync_job_backlink_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, backlink_job_id
  ) REFERENCES backlink_jobs (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_profile_provider_artifacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  profile_sync_job_id uuid NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  request_intent text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_task_id text,
  page_identity text NOT NULL,
  observed_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  request_payload jsonb NOT NULL,
  response_payload jsonb NOT NULL,
  cost_micros bigint NOT NULL DEFAULT 0,
  schema_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_profile_artifact_values_check CHECK (
    provider = 'dataforseo'
    AND endpoint IN (
      '/v3/backlinks/summary/live',
      '/v3/backlinks/backlinks/live'
    )
    AND request_intent = 'MONITORING'
    AND length(btrim(request_fingerprint)) > 0
    AND length(btrim(page_identity)) > 0
    AND fresh_until >= observed_at
    AND jsonb_typeof(request_payload) = 'object'
    AND jsonb_typeof(response_payload) = 'object'
    AND cost_micros >= 0
    AND length(btrim(schema_version)) > 0
  ),
  CONSTRAINT backlink_profile_artifact_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_artifact_page_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    provider, endpoint, request_fingerprint, page_identity
  ),
  CONSTRAINT backlink_profile_artifact_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, profile_sync_job_id
  ) REFERENCES backlink_profile_sync_jobs (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_profile_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  profile_sync_job_id uuid NOT NULL,
  summary_artifact_id uuid,
  inventory_artifact_id uuid,
  provider text NOT NULL,
  endpoints jsonb NOT NULL,
  provider_task_ids jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  freshness text NOT NULL,
  completeness text NOT NULL,
  total_backlinks bigint,
  referring_domains bigint,
  dofollow bigint,
  nofollow bigint,
  sponsored bigint,
  ugc bigint,
  new_backlinks bigint,
  lost_backlinks bigint,
  inventory_pulled_count integer NOT NULL DEFAULT 0,
  inventory_coverage numeric(7,6),
  distributions jsonb NOT NULL,
  unavailable_metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_micros bigint NOT NULL DEFAULT 0,
  schema_version text NOT NULL,
  next_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_profile_snapshot_values_check CHECK (
    provider IN ('dataforseo', 'user_import')
    AND jsonb_typeof(endpoints) = 'array'
    AND jsonb_typeof(provider_task_ids) = 'array'
    AND freshness IN ('fresh', 'stale', 'unavailable')
    AND completeness IN (
      'full', 'partial', 'summary_only', 'unavailable'
    )
    AND inventory_pulled_count >= 0
    AND (
      inventory_coverage IS NULL
      OR inventory_coverage BETWEEN 0 AND 1
    )
    AND jsonb_typeof(distributions) = 'object'
    AND jsonb_typeof(unavailable_metrics) = 'array'
    AND cost_micros >= 0
    AND fresh_until >= observed_at
    AND length(btrim(schema_version)) > 0
  ),
  CONSTRAINT backlink_profile_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_snapshot_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, profile_sync_job_id
  ) REFERENCES backlink_profile_sync_jobs (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_snapshot_summary_artifact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, summary_artifact_id
  ) REFERENCES backlink_profile_provider_artifacts (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_snapshot_inventory_artifact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inventory_artifact_id
  ) REFERENCES backlink_profile_provider_artifacts (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_inventory_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  latest_snapshot_id uuid,
  latest_artifact_id uuid,
  source_type text NOT NULL,
  provider text NOT NULL,
  provider_identity text NOT NULL,
  normalized_source_url text NOT NULL,
  normalized_target_url text NOT NULL,
  source_domain text,
  anchor_text text NOT NULL DEFAULT '',
  rel_attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_status text NOT NULL,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  rank integer,
  spam_score integer,
  country_code text,
  tld text,
  language_code text,
  source_http_status integer,
  target_http_status integer,
  redirect_url text,
  placement_id uuid,
  opportunity_id uuid,
  pinned boolean NOT NULL DEFAULT false,
  managed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_inventory_item_values_check CHECK (
    source_type IN ('DATAFORSEO', 'USER_IMPORTED')
    AND provider IN ('dataforseo', 'user_import')
    AND length(btrim(provider_identity)) > 0
    AND length(btrim(normalized_source_url)) > 0
    AND length(btrim(normalized_target_url)) > 0
    AND jsonb_typeof(rel_attributes) = 'array'
    AND provider_status IN ('live', 'lost', 'unknown')
    AND (rank IS NULL OR rank BETWEEN 0 AND 100)
    AND (spam_score IS NULL OR spam_score BETWEEN 0 AND 100)
    AND (
      source_http_status IS NULL
      OR source_http_status BETWEEN 100 AND 599
    )
    AND (
      target_http_status IS NULL
      OR target_http_status BETWEEN 100 AND 599
    )
    AND version > 0
  ),
  CONSTRAINT backlink_inventory_item_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_item_provider_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    normalized_source_url, normalized_target_url, provider, provider_identity
  ),
  CONSTRAINT backlink_inventory_item_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, latest_snapshot_id
  ) REFERENCES backlink_profile_snapshots (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_item_artifact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, latest_artifact_id
  ) REFERENCES backlink_profile_provider_artifacts (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_inventory_observations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  snapshot_id uuid,
  artifact_id uuid,
  observation_type text NOT NULL,
  page_identity text NOT NULL,
  provider_status text NOT NULL,
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_inventory_observation_values_check CHECK (
    observation_type IN ('observed', 'new', 'lost', 'recovered', 'imported')
    AND provider_status IN ('live', 'lost', 'unknown')
    AND length(btrim(page_identity)) > 0
    AND jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT backlink_inventory_observation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_observation_page_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, page_identity, observation_type
  ),
  CONSTRAINT backlink_inventory_observation_item_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inventory_item_id
  ) REFERENCES backlink_inventory_items (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_observation_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, snapshot_id
  ) REFERENCES backlink_profile_snapshots (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inventory_observation_artifact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, artifact_id
  ) REFERENCES backlink_profile_provider_artifacts (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_profile_health_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  profile_snapshot_id uuid NOT NULL,
  score integer,
  grade text NOT NULL,
  components jsonb NOT NULL,
  risks jsonb NOT NULL,
  positives jsonb NOT NULL,
  evidence_observed_at timestamptz NOT NULL,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_profile_health_values_check CHECK (
    (score IS NULL OR score BETWEEN 0 AND 100)
    AND grade IN ('A', 'B', 'C', 'D', 'E', 'INSUFFICIENT_DATA')
    AND jsonb_typeof(components) = 'array'
    AND jsonb_typeof(risks) = 'array'
    AND jsonb_typeof(positives) = 'array'
    AND model_version = 'backlink-profile-health.v1'
  ),
  CONSTRAINT backlink_profile_health_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_health_snapshot_uq UNIQUE (
    organization_id, workspace_id, website_project_id, profile_snapshot_id
  ),
  CONSTRAINT backlink_profile_health_profile_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, profile_snapshot_id
  ) REFERENCES backlink_profile_snapshots (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_profile_sync_cursors (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  search_after_token text,
  next_page_number integer NOT NULL DEFAULT 1,
  total_count bigint,
  pulled_count bigint NOT NULL DEFAULT 0,
  last_snapshot_id uuid,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_profile_cursor_values_check CHECK (
    provider = 'dataforseo'
    AND endpoint = '/v3/backlinks/backlinks/live'
    AND next_page_number > 0
    AND pulled_count >= 0
    AND version > 0
  ),
  CONSTRAINT backlink_profile_cursor_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_profile_cursor_endpoint_uq UNIQUE (
    organization_id, workspace_id, website_project_id, provider, endpoint
  ),
  CONSTRAINT backlink_profile_cursor_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, last_snapshot_id
  ) REFERENCES backlink_profile_snapshots (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX backlink_profile_sync_job_schedule_idx
  ON backlink_profile_sync_jobs (
    organization_id, workspace_id, status, next_sync_at, created_at
  );
CREATE INDEX backlink_profile_snapshot_latest_idx
  ON backlink_profile_snapshots (
    organization_id, workspace_id, website_project_id, observed_at DESC
  );
CREATE INDEX backlink_inventory_project_status_idx
  ON backlink_inventory_items (
    organization_id, workspace_id, website_project_id,
    provider_status, updated_at DESC
  );
CREATE INDEX backlink_inventory_source_domain_idx
  ON backlink_inventory_items (
    organization_id, workspace_id, website_project_id, source_domain
  );
CREATE INDEX backlink_inventory_observation_item_idx
  ON backlink_inventory_observations (
    organization_id, workspace_id, website_project_id,
    inventory_item_id, observed_at DESC
  );

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'backlink_profile_sync_jobs',
    'backlink_profile_provider_artifacts',
    'backlink_profile_snapshots',
    'backlink_inventory_items',
    'backlink_inventory_observations',
    'backlink_profile_health_snapshots',
    'backlink_profile_sync_cursors'
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

COMMIT;
