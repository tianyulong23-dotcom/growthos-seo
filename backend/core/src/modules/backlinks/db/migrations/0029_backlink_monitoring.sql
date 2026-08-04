BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_monitor_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  policy_version text NOT NULL,
  normal_interval_seconds integer NOT NULL DEFAULT 86400,
  suspected_recheck_interval_seconds integer NOT NULL DEFAULT 3600,
  jitter_window_seconds integer NOT NULL DEFAULT 3600,
  retry_initial_delay_seconds integer NOT NULL DEFAULT 60,
  retry_max_delay_seconds integer NOT NULL DEFAULT 3600,
  retry_backoff_multiplier integer NOT NULL DEFAULT 2,
  max_retry_attempts integer NOT NULL DEFAULT 3,
  loss_confirmation_count integer NOT NULL DEFAULT 2,
  change_confirmation_count integer NOT NULL DEFAULT 2,
  browser_fallback_enabled boolean NOT NULL DEFAULT false,
  next_check_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_monitor_policy_version_check CHECK (
    length(btrim(policy_version)) > 0
    AND schema_version > 0
    AND version > 0
  ),
  CONSTRAINT backlink_monitor_policy_schedule_check CHECK (
    normal_interval_seconds BETWEEN 300 AND 2592000
    AND suspected_recheck_interval_seconds BETWEEN 60
      AND normal_interval_seconds
    AND jitter_window_seconds BETWEEN 0 AND normal_interval_seconds
  ),
  CONSTRAINT backlink_monitor_policy_retry_check CHECK (
    retry_initial_delay_seconds BETWEEN 1 AND retry_max_delay_seconds
    AND retry_max_delay_seconds <= 86400
    AND retry_backoff_multiplier BETWEEN 2 AND 10
    AND max_retry_attempts BETWEEN 0 AND 10
  ),
  CONSTRAINT backlink_monitor_policy_confirmation_check CHECK (
    loss_confirmation_count BETWEEN 2 AND 10
    AND change_confirmation_count BETWEEN 2 AND 10
  ),
  CONSTRAINT backlink_monitor_policy_audit_check CHECK (
    length(btrim(created_by)) > 0
    AND length(btrim(updated_by)) > 0
  ),
  CONSTRAINT backlink_monitor_policy_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, placement_id,
    policy_version
  ),
  CONSTRAINT backlink_monitor_policy_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, placement_id,
    policy_version
  ),
  CONSTRAINT backlink_monitor_policy_placement_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, placement_id
  ) REFERENCES backlink_placements (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_monitor_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  monitor_policy_id uuid NOT NULL,
  policy_version text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  execution_mode text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  retry_after_seconds integer,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  schema_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_monitor_run_policy_version_check CHECK (
    length(btrim(policy_version)) > 0
    AND schema_version > 0
    AND version > 0
  ),
  CONSTRAINT backlink_monitor_run_execution_mode_check
    CHECK (execution_mode IN ('static', 'browser')),
  CONSTRAINT backlink_monitor_run_status_check CHECK (
    status IN (
      'SCHEDULED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED',
      'CANCELLED'
    )
  ),
  CONSTRAINT backlink_monitor_run_attempt_check CHECK (
    attempt_count >= 0
    AND (retry_after_seconds IS NULL OR retry_after_seconds > 0)
    AND (error_code IS NULL OR length(btrim(error_code)) > 0)
    AND (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
  ),
  CONSTRAINT backlink_monitor_run_state_check CHECK (
    (
      status = 'SCHEDULED'
      AND attempt_count = 0
      AND started_at IS NULL
      AND finished_at IS NULL
      AND next_retry_at IS NULL
      AND retry_after_seconds IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'RUNNING'
      AND attempt_count > 0
      AND started_at IS NOT NULL
      AND finished_at IS NULL
      AND next_retry_at IS NULL
    )
    OR (
      status = 'RETRY_WAIT'
      AND attempt_count > 0
      AND started_at IS NOT NULL
      AND finished_at IS NULL
      AND next_retry_at IS NOT NULL
      AND error_code IS NOT NULL
    )
    OR (
      status = 'SUCCEEDED'
      AND attempt_count > 0
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND next_retry_at IS NULL
      AND retry_after_seconds IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'FAILED'
      AND attempt_count > 0
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND next_retry_at IS NULL
      AND error_code IS NOT NULL
    )
    OR (
      status = 'CANCELLED'
      AND finished_at IS NOT NULL
      AND next_retry_at IS NULL
    )
  ),
  CONSTRAINT backlink_monitor_run_audit_check CHECK (
    length(btrim(created_by)) > 0
    AND length(btrim(updated_by)) > 0
  ),
  CONSTRAINT backlink_monitor_run_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, placement_id,
    monitor_policy_id, policy_version, scheduled_for, execution_mode
  ),
  CONSTRAINT backlink_monitor_run_schedule_uq UNIQUE (
    organization_id, workspace_id, website_project_id, placement_id,
    scheduled_for, policy_version, execution_mode
  ),
  CONSTRAINT backlink_monitor_run_placement_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, placement_id
  ) REFERENCES backlink_placements (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_monitor_run_policy_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, monitor_policy_id,
    placement_id, policy_version
  ) REFERENCES backlink_monitor_policies (
    organization_id, workspace_id, website_project_id, id, placement_id,
    policy_version
  )
);

CREATE TABLE backlink_monitor_observations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  monitor_run_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  monitor_policy_id uuid NOT NULL,
  policy_version text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  execution_mode text NOT NULL,
  result text NOT NULL,
  failure_code text,
  evidence_snapshot jsonb NOT NULL,
  evidence_snapshot_hash text NOT NULL,
  evidence_fingerprint text NOT NULL,
  evidence_contract_version text NOT NULL,
  evidence_schema_version integer NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_monitor_observation_result_check CHECK (
    result IN ('present', 'changed', 'absent', 'inaccessible')
  ),
  CONSTRAINT backlink_monitor_observation_failure_check CHECK (
    (
      result = 'inaccessible'
      AND length(btrim(failure_code)) > 0
    )
    OR (
      result <> 'inaccessible'
      AND failure_code IS NULL
    )
  ),
  CONSTRAINT backlink_monitor_observation_evidence_check CHECK (
    jsonb_typeof(evidence_snapshot) = 'object'
    AND evidence_snapshot_hash ~ '^[a-f0-9]{64}$'
    AND evidence_fingerprint ~ '^[a-f0-9]{64}$'
    AND length(btrim(evidence_contract_version)) > 0
    AND evidence_schema_version > 0
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_monitor_observation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_monitor_observation_run_uq UNIQUE (
    organization_id, workspace_id, website_project_id, monitor_run_id
  ),
  CONSTRAINT backlink_monitor_observation_run_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, monitor_run_id,
    placement_id, monitor_policy_id, policy_version, scheduled_for,
    execution_mode
  ) REFERENCES backlink_monitor_runs (
    organization_id, workspace_id, website_project_id, id, placement_id,
    monitor_policy_id, policy_version, scheduled_for, execution_mode
  )
);

CREATE FUNCTION backlink_reject_monitor_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Backlink monitoring observations are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_monitor_observation_immutable
BEFORE UPDATE OR DELETE ON backlink_monitor_observations
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_monitor_observation_mutation();

ALTER TABLE backlink_monitor_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_monitor_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_monitor_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_monitor_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_monitor_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_monitor_observations FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_monitor_policy_tenant_policy
  ON backlink_monitor_policies
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
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
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_monitor_run_tenant_policy
  ON backlink_monitor_runs
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
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
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_monitor_observation_tenant_policy
  ON backlink_monitor_observations
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
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
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

REVOKE ALL ON backlink_monitor_policies FROM PUBLIC;
REVOKE ALL ON backlink_monitor_runs FROM PUBLIC;
REVOKE ALL ON backlink_monitor_observations FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_monitor_observation_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_monitor_observations
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_monitor_policies, backlink_monitor_runs
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_monitor_observations
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_monitor_policies, backlink_monitor_runs,
    backlink_monitor_observations
  TO growthos_reporting_reader;

COMMIT;
