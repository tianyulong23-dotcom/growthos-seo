BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_ai_capability_windows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  capability text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  call_limit integer NOT NULL,
  budget_limit_usd numeric(18, 6) NOT NULL,
  reserved_calls integer NOT NULL DEFAULT 0,
  settled_calls integer NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  spent_cost_usd numeric(18, 6) NOT NULL DEFAULT 0,
  concurrency_limit integer NOT NULL,
  active_reservations integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_ai_capability_window_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, capability
  ),
  CONSTRAINT backlink_ai_capability_window_start_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    capability, window_started_at
  ),
  CONSTRAINT backlink_ai_capability_window_values_ck CHECK (
    capability IN ('AI_DISCOVERY', 'AI_OUTREACH_DRAFT')
    AND window_expires_at > window_started_at
    AND call_limit > 0
    AND budget_limit_usd > 0
    AND reserved_calls >= 0
    AND settled_calls >= 0
    AND reserved_calls + settled_calls <= call_limit
    AND reserved_cost_usd >= 0
    AND spent_cost_usd >= 0
    AND reserved_cost_usd + spent_cost_usd <= budget_limit_usd
    AND concurrency_limit > 0
    AND active_reservations >= 0
    AND active_reservations <= concurrency_limit
  )
);

CREATE TABLE backlink_ai_capability_usage_ledger (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  window_id uuid NOT NULL,
  capability text NOT NULL,
  operation_key text NOT NULL,
  reservation_attempt integer NOT NULL,
  status text NOT NULL,
  work_item_count integer NOT NULL,
  max_provider_calls integer NOT NULL,
  provider_call_count integer NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(18, 6) NOT NULL,
  actual_cost_usd numeric(18, 6),
  provider_ref text NOT NULL,
  model_id text NOT NULL,
  reserved_at timestamptz NOT NULL,
  settled_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_ai_capability_usage_operation_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    capability, operation_key, reservation_attempt
  ),
  CONSTRAINT backlink_ai_capability_usage_values_ck CHECK (
    capability IN ('AI_DISCOVERY', 'AI_OUTREACH_DRAFT')
    AND length(btrim(operation_key)) > 0
    AND reservation_attempt > 0
    AND status IN ('RESERVED', 'SETTLED', 'RELEASED')
    AND work_item_count > 0
    AND max_provider_calls > 0
    AND provider_call_count >= 0
    AND provider_call_count <= max_provider_calls
    AND reserved_cost_usd > 0
    AND (actual_cost_usd IS NULL OR actual_cost_usd >= 0)
    AND length(btrim(provider_ref)) > 0
    AND length(btrim(model_id)) > 0
    AND (
      (status = 'RESERVED' AND settled_at IS NULL AND released_at IS NULL)
      OR (
        status = 'SETTLED'
        AND settled_at IS NOT NULL
        AND released_at IS NULL
        AND actual_cost_usd IS NOT NULL
      )
      OR (
        status = 'RELEASED'
        AND settled_at IS NULL
        AND released_at IS NOT NULL
        AND actual_cost_usd IS NULL
        AND provider_call_count = 0
      )
    )
  ),
  CONSTRAINT backlink_ai_capability_usage_window_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, window_id, capability
  ) REFERENCES backlink_ai_capability_windows (
    organization_id, workspace_id, website_project_id, id, capability
  ) ON DELETE RESTRICT
);

CREATE INDEX backlink_ai_capability_window_active_idx
  ON backlink_ai_capability_windows (
    organization_id, workspace_id, website_project_id,
    capability, window_expires_at DESC
  );

CREATE INDEX backlink_ai_capability_usage_window_idx
  ON backlink_ai_capability_usage_ledger (
    organization_id, workspace_id, website_project_id,
    window_id, capability, status
  );

ALTER TABLE backlink_ai_capability_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_ai_capability_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_ai_capability_window_tenant_policy
  ON backlink_ai_capability_windows
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

ALTER TABLE backlink_ai_capability_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_ai_capability_usage_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_ai_capability_usage_tenant_policy
  ON backlink_ai_capability_usage_ledger
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

REVOKE ALL ON backlink_ai_capability_windows FROM PUBLIC;
REVOKE ALL ON backlink_ai_capability_usage_ledger FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE
  ON backlink_ai_capability_windows TO growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE
  ON backlink_ai_capability_usage_ledger TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_ai_capability_windows TO growthos_reporting_reader;
GRANT SELECT
  ON backlink_ai_capability_usage_ledger TO growthos_reporting_reader;

COMMIT;
