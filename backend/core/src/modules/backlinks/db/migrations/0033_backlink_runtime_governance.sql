BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_project_settings_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  version integer NOT NULL,
  settings_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_project_settings_version_check CHECK (version > 0),
  CONSTRAINT backlink_project_settings_values_check CHECK (
    jsonb_typeof(settings_values) = 'object'
    AND jsonb_typeof(settings_values -> 'reportingTimezone') = 'string'
    AND jsonb_typeof(settings_values -> 'reportLookbackDays') = 'number'
    AND jsonb_typeof(settings_values -> 'exportExpiryHours') = 'number'
  ),
  CONSTRAINT backlink_project_settings_scope_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, version
  )
);

CREATE TABLE backlink_kill_switch_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  layer text NOT NULL,
  capability text NOT NULL,
  provider text,
  version integer NOT NULL,
  blocked boolean NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_kill_switch_layer_check CHECK (
    layer IN ('project', 'provider')
  ),
  CONSTRAINT backlink_kill_switch_provider_check CHECK (
    (layer = 'project' AND provider IS NULL)
    OR (layer = 'provider' AND length(btrim(provider)) > 0)
  ),
  CONSTRAINT backlink_kill_switch_capability_check CHECK (
    length(btrim(capability)) > 0
  ),
  CONSTRAINT backlink_kill_switch_version_check CHECK (version > 0),
  CONSTRAINT backlink_kill_switch_reason_check CHECK (
    length(btrim(reason)) > 0
  ),
  CONSTRAINT backlink_kill_switch_scope_version_uq UNIQUE NULLS NOT DISTINCT (
    organization_id, workspace_id, website_project_id,
    layer, capability, provider, version
  )
);

CREATE TABLE backlink_retention_policy_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  version integer NOT NULL,
  rules jsonb NOT NULL,
  exceptions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_retention_policy_version_check CHECK (version > 0),
  CONSTRAINT backlink_retention_policy_values_check CHECK (
    jsonb_typeof(rules) = 'array'
    AND jsonb_typeof(exceptions) = 'array'
  ),
  CONSTRAINT backlink_retention_policy_scope_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, version
  )
);

CREATE TABLE backlink_report_exports (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  report_key text NOT NULL,
  report_revision_id text NOT NULL,
  format text NOT NULL,
  status text NOT NULL,
  requested_by text NOT NULL,
  correlation_id text NOT NULL,
  object_reference jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  CONSTRAINT backlink_report_export_format_check CHECK (
    format IN ('csv', 'xlsx', 'pdf')
  ),
  CONSTRAINT backlink_report_export_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed')
  ),
  CONSTRAINT backlink_report_export_object_check CHECK (
    object_reference IS NULL OR jsonb_typeof(object_reference) = 'object'
  ),
  CONSTRAINT backlink_report_export_completion_check CHECK (
    (status = 'completed' AND object_reference IS NOT NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL
      AND failure_code IS NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL)
    OR (status IN ('queued', 'running') AND object_reference IS NULL
      AND completed_at IS NULL AND expires_at IS NULL
      AND failure_code IS NULL)
  ),
  CONSTRAINT backlink_report_export_scope_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX backlink_project_settings_latest_idx
  ON backlink_project_settings_versions (
    organization_id, workspace_id, website_project_id, version DESC
  );
CREATE INDEX backlink_kill_switch_latest_idx
  ON backlink_kill_switch_versions (
    organization_id, workspace_id, website_project_id,
    layer, capability, provider, version DESC
  );
CREATE INDEX backlink_retention_policy_latest_idx
  ON backlink_retention_policy_versions (
    organization_id, workspace_id, website_project_id, version DESC
  );
CREATE INDEX backlink_report_export_status_idx
  ON backlink_report_exports (
    organization_id, workspace_id, website_project_id, status, created_at DESC
  );

ALTER TABLE backlink_project_settings_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_project_settings_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_kill_switch_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_kill_switch_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_retention_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_retention_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_report_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_report_exports FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_project_settings_internal_policy
  ON backlink_project_settings_versions TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_kill_switch_internal_policy
  ON backlink_kill_switch_versions TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_retention_policy_internal_policy
  ON backlink_retention_policy_versions TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_report_export_internal_policy
  ON backlink_report_exports TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);

CREATE POLICY backlink_project_settings_tenant_policy
  ON backlink_project_settings_versions
  TO growthos_backlinks_writer, growthos_reporting_reader
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

CREATE POLICY backlink_kill_switch_tenant_policy
  ON backlink_kill_switch_versions
  TO growthos_backlinks_writer, growthos_reporting_reader
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

CREATE POLICY backlink_retention_policy_tenant_policy
  ON backlink_retention_policy_versions
  TO growthos_backlinks_writer, growthos_reporting_reader
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

CREATE POLICY backlink_report_export_tenant_policy
  ON backlink_report_exports
  TO growthos_backlinks_writer, growthos_reporting_reader
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

REVOKE ALL ON
  backlink_project_settings_versions,
  backlink_kill_switch_versions,
  backlink_retention_policy_versions,
  backlink_report_exports
  FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  backlink_project_settings_versions,
  backlink_kill_switch_versions,
  backlink_retention_policy_versions,
  backlink_report_exports
  TO growthos_backlinks_writer;

GRANT SELECT ON
  backlink_project_settings_versions,
  backlink_kill_switch_versions,
  backlink_retention_policy_versions,
  backlink_report_exports
  TO growthos_reporting_reader;

COMMIT;
