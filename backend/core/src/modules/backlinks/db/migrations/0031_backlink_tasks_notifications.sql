BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_task_projections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  occurrence_key text NOT NULL,
  source_event_id text NOT NULL,
  source_event_type text NOT NULL,
  rule_key text NOT NULL,
  rule_version integer NOT NULL,
  task_type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  occurred_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL,
  projection_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_task_projection_values_check CHECK (
    length(btrim(occurrence_key)) > 0
    AND length(btrim(source_event_id)) > 0
    AND length(btrim(source_event_type)) > 0
    AND length(btrim(rule_key)) > 0
    AND rule_version > 0
    AND length(btrim(task_type)) > 0
    AND length(btrim(title)) > 0
    AND status IN ('open', 'completed', 'dismissed')
    AND projection_version > 0
  ),
  CONSTRAINT backlink_task_projection_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_task_projection_occurrence_uq UNIQUE (
    organization_id, workspace_id, website_project_id, occurrence_key
  )
);

CREATE INDEX backlink_task_projection_status_idx
  ON backlink_task_projections (
    organization_id, workspace_id, website_project_id, status,
    occurred_at DESC, occurrence_key
  );

CREATE TABLE backlink_notification_projections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  occurrence_key text NOT NULL,
  source_event_id text NOT NULL,
  source_event_type text NOT NULL,
  rule_key text NOT NULL,
  rule_version integer NOT NULL,
  notification_type text NOT NULL,
  title text NOT NULL,
  occurred_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL,
  projection_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_notification_projection_values_check CHECK (
    length(btrim(occurrence_key)) > 0
    AND length(btrim(source_event_id)) > 0
    AND length(btrim(source_event_type)) > 0
    AND length(btrim(rule_key)) > 0
    AND rule_version > 0
    AND length(btrim(notification_type)) > 0
    AND length(btrim(title)) > 0
    AND projection_version > 0
  ),
  CONSTRAINT backlink_notification_projection_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_notification_projection_occurrence_uq UNIQUE (
    organization_id, workspace_id, website_project_id, occurrence_key
  )
);

CREATE INDEX backlink_notification_projection_time_idx
  ON backlink_notification_projections (
    organization_id, workspace_id, website_project_id,
    occurred_at DESC, occurrence_key
  );

CREATE TABLE backlink_notification_read_states (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  notification_occurrence_key text NOT NULL,
  user_id text NOT NULL,
  read_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_notification_read_state_values_check CHECK (
    length(btrim(notification_occurrence_key)) > 0
    AND length(btrim(user_id)) > 0
    AND version > 0
  ),
  CONSTRAINT backlink_notification_read_state_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_notification_read_state_user_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    notification_occurrence_key, user_id
  ),
  CONSTRAINT backlink_notification_read_state_notification_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    notification_occurrence_key
  ) REFERENCES backlink_notification_projections (
    organization_id, workspace_id, website_project_id, occurrence_key
  )
);

ALTER TABLE backlink_task_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_task_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_notification_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_notification_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_notification_read_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_notification_read_states FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_task_projection_tenant_policy
  ON backlink_task_projections
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

CREATE POLICY backlink_notification_projection_tenant_policy
  ON backlink_notification_projections
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

CREATE POLICY backlink_notification_read_state_tenant_policy
  ON backlink_notification_read_states
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

REVOKE ALL ON backlink_task_projections FROM PUBLIC;
REVOKE ALL ON backlink_notification_projections FROM PUBLIC;
REVOKE ALL ON backlink_notification_read_states FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_task_projections, backlink_notification_projections,
    backlink_notification_read_states
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_task_projections, backlink_notification_projections
  TO growthos_reporting_reader;

COMMIT;
