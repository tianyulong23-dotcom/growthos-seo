BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_send_snapshots
  ADD COLUMN approval_fact_id uuid,
  ADD COLUMN approval_actor_id text,
  ADD COLUMN approval_recorded_at timestamptz,
  ADD CONSTRAINT backlink_send_snapshot_approval_values_check CHECK (
    (
      approval_fact_id IS NULL
      AND approval_actor_id IS NULL
      AND approval_recorded_at IS NULL
      AND snapshot_schema_version = 1
    )
    OR (
      approval_fact_id IS NOT NULL
      AND length(btrim(approval_actor_id)) > 0
      AND approval_recorded_at IS NOT NULL
      AND snapshot_schema_version >= 2
    )
  ),
  ADD CONSTRAINT backlink_send_snapshot_approval_fact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, approval_fact_id
  ) REFERENCES backlink_lifecycle_events (
    organization_id, workspace_id, website_project_id, id
  );

CREATE TABLE backlink_gmail_connection_sync_cursors (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  history_id text,
  next_page_token text,
  initial_sync_completed_at timestamptz,
  last_synced_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_gmail_connection_sync_cursor_values_check CHECK (
    version > 0
    AND (
      history_id IS NULL
      OR history_id ~ '^[1-9][0-9]*$'
    )
    AND (
      initial_sync_completed_at IS NULL
      OR history_id IS NOT NULL
    )
  ),
  CONSTRAINT backlink_gmail_connection_sync_cursor_identity_uq UNIQUE (
    organization_id, workspace_id, id
  ),
  CONSTRAINT backlink_gmail_connection_sync_cursor_connection_uq UNIQUE (
    organization_id, workspace_id, gmail_connection_id
  ),
  CONSTRAINT backlink_gmail_connection_sync_cursor_binding_fk FOREIGN KEY (
    organization_id, workspace_id, gmail_connection_id
  ) REFERENCES backlink_gmail_workspace_bindings (
    organization_id, workspace_id, gmail_connection_id
  )
);

ALTER TABLE backlink_gmail_connection_sync_cursors
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_connection_sync_cursors
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_gmail_connection_sync_cursor_workspace_policy
  ON backlink_gmail_connection_sync_cursors
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

REVOKE ALL
  ON backlink_gmail_connection_sync_cursors
  FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE
  ON backlink_gmail_connection_sync_cursors
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_gmail_connection_sync_cursors
  TO growthos_reporting_reader;

COMMIT;
