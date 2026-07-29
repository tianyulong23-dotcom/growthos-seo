CREATE TABLE backlink_provider_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  request_fingerprint text NOT NULL,
  active_request_bucket text NOT NULL,
  request_schema_version integer NOT NULL,
  request_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_provider_request_schema_version_check
    CHECK (request_schema_version > 0),
  CONSTRAINT backlink_provider_request_fingerprint_check
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_provider_request_status_check
    CHECK (
      status IN (
        'pending', 'running', 'succeeded', 'failed', 'unknown_charge'
      )
    ),
  CONSTRAINT backlink_provider_request_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, website_project_id, id),
  CONSTRAINT backlink_provider_request_fingerprint_bucket_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, provider, endpoint,
      request_fingerprint, active_request_bucket
    )
);

CREATE TABLE backlink_seo_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  provider_request_id uuid NOT NULL,
  provider text NOT NULL,
  target text NOT NULL,
  target_type text NOT NULL,
  snapshot_type text NOT NULL,
  normalized_payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_seo_snapshot_schema_version_check
    CHECK (schema_version > 0),
  CONSTRAINT backlink_seo_snapshot_payload_hash_check
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_seo_snapshot_target_type_check
    CHECK (target_type IN ('domain', 'page')),
  CONSTRAINT backlink_seo_snapshot_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, website_project_id, id),
  CONSTRAINT backlink_seo_snapshot_provider_request_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, provider_request_id
    )
    REFERENCES backlink_provider_requests (
      organization_id, workspace_id, website_project_id, id
    )
);

CREATE TABLE backlink_provider_cache_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  request_fingerprint text NOT NULL,
  schema_version integer NOT NULL,
  seo_snapshot_id uuid NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_provider_cache_schema_version_check
    CHECK (schema_version > 0),
  CONSTRAINT backlink_provider_cache_fingerprint_check
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_provider_cache_expiry_check
    CHECK (expires_at > fetched_at),
  CONSTRAINT backlink_provider_cache_fingerprint_schema_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, provider, endpoint,
      request_fingerprint, schema_version
    ),
  CONSTRAINT backlink_provider_cache_snapshot_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, seo_snapshot_id
    )
    REFERENCES backlink_seo_snapshots (
      organization_id, workspace_id, website_project_id, id
    )
);

CREATE FUNCTION backlink_reject_seo_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'backlink_seo_snapshots are immutable';
END;
$$;

CREATE TRIGGER backlink_seo_snapshot_immutable
BEFORE UPDATE OR DELETE ON backlink_seo_snapshots
FOR EACH ROW EXECUTE FUNCTION backlink_reject_seo_snapshot_mutation();

ALTER TABLE backlink_provider_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_provider_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_provider_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_provider_cache_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_seo_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_seo_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_provider_request_tenant_policy
  ON backlink_provider_requests
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

CREATE POLICY backlink_provider_cache_tenant_policy
  ON backlink_provider_cache_entries
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

CREATE POLICY backlink_seo_snapshot_tenant_policy
  ON backlink_seo_snapshots
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

CREATE TABLE backlink_provider_budgets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  limit_micros bigint NOT NULL,
  spent_micros bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_provider_budget_provider_check
    CHECK (length(btrim(provider)) > 0),
  CONSTRAINT backlink_provider_budget_period_check
    CHECK (period_end > period_start),
  CONSTRAINT backlink_provider_budget_amounts_check
    CHECK (
      limit_micros >= 0
      AND spent_micros >= 0
      AND reserved_micros >= 0
      AND spent_micros + reserved_micros <= limit_micros
    ),
  CONSTRAINT backlink_provider_budget_version_check CHECK (version > 0),
  CONSTRAINT backlink_provider_budget_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, id),
  CONSTRAINT backlink_provider_budget_period_uq
    UNIQUE (organization_id, workspace_id, provider, period_start)
);

CREATE TABLE backlink_provider_usage_ledger (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  provider_request_id uuid NOT NULL,
  provider text NOT NULL,
  reservation_key text NOT NULL,
  estimated_cost_micros bigint NOT NULL,
  actual_cost_micros bigint,
  status text NOT NULL DEFAULT 'reserved',
  settled_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_provider_usage_provider_check
    CHECK (length(btrim(provider)) > 0),
  CONSTRAINT backlink_provider_usage_reservation_key_check
    CHECK (length(btrim(reservation_key)) > 0),
  CONSTRAINT backlink_provider_usage_cost_check
    CHECK (
      estimated_cost_micros >= 0
      AND (actual_cost_micros IS NULL OR actual_cost_micros >= 0)
    ),
  CONSTRAINT backlink_provider_usage_state_check
    CHECK (
      (
        status = 'reserved'
        AND actual_cost_micros IS NULL
        AND settled_at IS NULL
        AND released_at IS NULL
      )
      OR (
        status = 'settled'
        AND actual_cost_micros IS NOT NULL
        AND settled_at IS NOT NULL
        AND released_at IS NULL
      )
      OR (
        status = 'released'
        AND actual_cost_micros IS NULL
        AND settled_at IS NULL
        AND released_at IS NOT NULL
      )
    ),
  CONSTRAINT backlink_provider_usage_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, website_project_id, id),
  CONSTRAINT backlink_provider_usage_reservation_uq
    UNIQUE (workspace_id, provider, reservation_key),
  CONSTRAINT backlink_provider_usage_budget_fk
    FOREIGN KEY (organization_id, workspace_id, budget_id)
    REFERENCES backlink_provider_budgets (
      organization_id, workspace_id, id
    ),
  CONSTRAINT backlink_provider_usage_request_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, provider_request_id
    )
    REFERENCES backlink_provider_requests (
      organization_id, workspace_id, website_project_id, id
    )
);

CREATE FUNCTION backlink_reserve_provider_cost(
  p_ledger_id uuid,
  p_budget_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_website_project_id uuid,
  p_provider_request_id uuid,
  p_provider text,
  p_reservation_key text,
  p_estimated_cost_micros bigint,
  p_created_by text
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  existing_usage backlink_provider_usage_ledger%ROWTYPE;
  reserved_budget_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_workspace_id::text || ':' || p_provider || ':' || p_reservation_key,
      0
    )
  );

  SELECT *
    INTO existing_usage
    FROM backlink_provider_usage_ledger
   WHERE workspace_id = p_workspace_id
     AND provider = p_provider
     AND reservation_key = p_reservation_key;
  IF existing_usage.id IS NOT NULL THEN
    IF existing_usage.id <> p_ledger_id
       OR existing_usage.organization_id <> p_organization_id
       OR existing_usage.website_project_id <> p_website_project_id
       OR existing_usage.budget_id <> p_budget_id
       OR existing_usage.provider_request_id <> p_provider_request_id
       OR existing_usage.estimated_cost_micros <> p_estimated_cost_micros THEN
      RAISE EXCEPTION 'BACKLINK_PROVIDER_RESERVATION_CONFLICT'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN existing_usage.id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM backlink_provider_requests
     WHERE id = p_provider_request_id
       AND organization_id = p_organization_id
       AND workspace_id = p_workspace_id
       AND website_project_id = p_website_project_id
       AND provider = p_provider
  ) THEN
    RAISE EXCEPTION 'BACKLINK_PROVIDER_REQUEST_MISMATCH'
      USING ERRCODE = '23503';
  END IF;

  UPDATE backlink_provider_budgets
     SET reserved_micros = reserved_micros + p_estimated_cost_micros,
         version = version + 1
   WHERE id = p_budget_id
     AND organization_id = p_organization_id
     AND workspace_id = p_workspace_id
     AND provider = p_provider
     AND p_estimated_cost_micros >= 0
     AND spent_micros + reserved_micros + p_estimated_cost_micros
         <= limit_micros
  RETURNING id INTO reserved_budget_id;
  IF reserved_budget_id IS NULL THEN
    RAISE EXCEPTION 'BACKLINK_PROVIDER_BUDGET_EXCEEDED'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO backlink_provider_usage_ledger (
    id, organization_id, workspace_id, website_project_id, budget_id,
    provider_request_id, provider, reservation_key, estimated_cost_micros,
    created_by
  ) VALUES (
    p_ledger_id, p_organization_id, p_workspace_id, p_website_project_id,
    p_budget_id, p_provider_request_id, p_provider, p_reservation_key,
    p_estimated_cost_micros, p_created_by
  );
  RETURN p_ledger_id;
END;
$$;

ALTER TABLE backlink_provider_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_provider_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_provider_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_provider_usage_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_provider_budget_workspace_policy
  ON backlink_provider_budgets
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

CREATE POLICY backlink_provider_usage_tenant_policy
  ON backlink_provider_usage_ledger
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
