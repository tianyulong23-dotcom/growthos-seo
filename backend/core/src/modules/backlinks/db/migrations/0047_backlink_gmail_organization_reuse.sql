BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_gmail_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_workspace_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_oauth_attempts NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE gmail_connection_canonical
ON COMMIT DROP AS
SELECT
  id,
  first_value(id) OVER (
    PARTITION BY organization_id, google_subject
    ORDER BY
      (connection_status = 'CONNECTED') DESC,
      updated_at DESC,
      created_at DESC,
      id
  ) AS canonical_id
FROM backlink_gmail_connections
WHERE disconnected_at IS NULL;

CREATE TEMP TABLE gmail_legacy_project_bindings
ON COMMIT DROP AS
SELECT
  binding.id,
  binding.organization_id,
  binding.workspace_id,
  binding.website_project_id,
  coalesce(
    connection_canonical.canonical_id,
    binding.gmail_connection_id
  ) AS gmail_connection_id,
  binding.binding_status,
  binding.is_primary,
  binding.version,
  binding.created_at,
  binding.updated_at,
  binding.created_by,
  binding.updated_by
FROM backlink_gmail_workspace_bindings AS binding
LEFT JOIN gmail_connection_canonical AS connection_canonical
  ON connection_canonical.id = binding.gmail_connection_id;

CREATE TABLE backlink_website_project_mailbox_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gmail_workspace_binding_id uuid NOT NULL,
  binding_status text NOT NULL DEFAULT 'ACTIVE',
  is_selected boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_project_mailbox_binding_values_check CHECK (
    binding_status IN ('ACTIVE', 'INACTIVE')
    AND version > 0
  )
);

ALTER TABLE backlink_gmail_workspace_bindings
  DROP CONSTRAINT backlink_gmail_workspace_binding_identity_uq;

DROP INDEX backlink_gmail_workspace_primary_active_uq;
DROP INDEX backlink_gmail_connection_single_active_binding_uq;

UPDATE backlink_gmail_workspace_bindings AS binding
SET gmail_connection_id = legacy.gmail_connection_id
FROM gmail_legacy_project_bindings AS legacy
WHERE legacy.id = binding.id;

CREATE TEMP TABLE gmail_workspace_binding_canonical
ON COMMIT DROP AS
SELECT
  id,
  first_value(id) OVER (
    PARTITION BY organization_id, workspace_id, gmail_connection_id
    ORDER BY
      (binding_status = 'ACTIVE') DESC,
      created_at,
      id
  ) AS canonical_id
FROM backlink_gmail_workspace_bindings;

INSERT INTO backlink_website_project_mailbox_bindings (
  id,
  organization_id,
  workspace_id,
  website_project_id,
  gmail_workspace_binding_id,
  binding_status,
  is_selected,
  version,
  created_at,
  updated_at,
  created_by,
  updated_by
)
SELECT DISTINCT ON (
  legacy.organization_id,
  legacy.workspace_id,
  legacy.website_project_id,
  workspace_canonical.canonical_id
)
  legacy.id,
  legacy.organization_id,
  legacy.workspace_id,
  legacy.website_project_id,
  workspace_canonical.canonical_id,
  legacy.binding_status,
  legacy.is_primary,
  legacy.version,
  legacy.created_at,
  legacy.updated_at,
  legacy.created_by,
  legacy.updated_by
FROM gmail_legacy_project_bindings AS legacy
JOIN gmail_workspace_binding_canonical AS workspace_canonical
  ON workspace_canonical.id = legacy.id
ORDER BY
  legacy.organization_id,
  legacy.workspace_id,
  legacy.website_project_id,
  workspace_canonical.canonical_id,
  (legacy.binding_status = 'ACTIVE') DESC,
  legacy.is_primary DESC,
  legacy.updated_at DESC,
  legacy.id;

CREATE TEMP TABLE gmail_workspace_binding_state
ON COMMIT DROP AS
SELECT
  workspace_canonical.canonical_id,
  bool_or(legacy.binding_status = 'ACTIVE') AS has_active_binding,
  min(legacy.created_at) AS created_at,
  max(legacy.updated_at) AS updated_at
FROM gmail_legacy_project_bindings AS legacy
JOIN gmail_workspace_binding_canonical AS workspace_canonical
  ON workspace_canonical.id = legacy.id
GROUP BY workspace_canonical.canonical_id;

DELETE FROM backlink_gmail_workspace_bindings AS duplicate
USING gmail_workspace_binding_canonical AS workspace_canonical
WHERE duplicate.id = workspace_canonical.id
  AND workspace_canonical.id <> workspace_canonical.canonical_id;

ALTER TABLE backlink_gmail_workspace_bindings
  ALTER COLUMN website_project_id DROP NOT NULL;

UPDATE backlink_gmail_workspace_bindings AS binding
SET website_project_id = NULL,
    binding_status = CASE
      WHEN state.has_active_binding THEN 'ACTIVE'
      ELSE 'INACTIVE'
    END,
    is_primary = false,
    created_at = state.created_at,
    updated_at = greatest(state.updated_at, now()),
    updated_by = 'migration-0047'
FROM gmail_workspace_binding_state AS state
WHERE binding.id = state.canonical_id;

UPDATE backlink_gmail_connections AS connection
SET token_secret_reference_id = NULL,
    token_secret_kind = NULL,
    connection_status = 'DISCONNECTED',
    reauth_reason = NULL,
    send_availability = 'PAUSED',
    disconnected_at = greatest(now(), connection.connected_at),
    last_api_error_code = NULL,
    version = connection.version + 1,
    updated_at = now(),
    updated_by = 'migration-0047'
FROM gmail_connection_canonical AS connection_canonical
WHERE connection.id = connection_canonical.id
  AND connection.id <> connection_canonical.canonical_id;

ALTER TABLE backlink_gmail_workspace_bindings
  ADD CONSTRAINT backlink_gmail_workspace_binding_identity_uq UNIQUE (
    organization_id,
    workspace_id,
    gmail_connection_id
  ),
  ADD CONSTRAINT backlink_gmail_workspace_binding_reference_uq UNIQUE (
    organization_id,
    workspace_id,
    id
  );

DROP INDEX backlink_gmail_connection_subject_idx;

CREATE UNIQUE INDEX backlink_gmail_connection_active_subject_uq
  ON backlink_gmail_connections (organization_id, google_subject)
  WHERE disconnected_at IS NULL;

ALTER TABLE backlink_website_project_mailbox_bindings
  ADD CONSTRAINT backlink_project_mailbox_binding_identity_uq UNIQUE (
    organization_id,
    workspace_id,
    website_project_id,
    gmail_workspace_binding_id
  ),
  ADD CONSTRAINT backlink_project_mailbox_binding_workspace_fk FOREIGN KEY (
    organization_id,
    workspace_id,
    gmail_workspace_binding_id
  ) REFERENCES backlink_gmail_workspace_bindings (
    organization_id,
    workspace_id,
    id
  );

CREATE UNIQUE INDEX backlink_project_mailbox_selected_active_uq
  ON backlink_website_project_mailbox_bindings (
    organization_id,
    workspace_id,
    website_project_id
  )
  WHERE binding_status = 'ACTIVE' AND is_selected = true;

DROP POLICY backlink_gmail_workspace_binding_tenant_policy
  ON backlink_gmail_workspace_bindings;
DROP POLICY backlink_oauth_attempt_tenant_policy
  ON backlink_oauth_attempts;

CREATE POLICY backlink_gmail_workspace_binding_tenant_policy
  ON backlink_gmail_workspace_bindings
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

CREATE POLICY backlink_oauth_attempt_tenant_policy
  ON backlink_oauth_attempts
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

ALTER TABLE backlink_website_project_mailbox_bindings
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_website_project_mailbox_bindings
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_project_mailbox_binding_tenant_policy
  ON backlink_website_project_mailbox_bindings
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

DO $rate_limit_policy$
BEGIN
  IF to_regclass(
    'backlinks.backlink_rate_limit_reservations'
  ) IS NOT NULL THEN
    EXECUTE
      'DROP POLICY IF EXISTS backlink_rate_limit_reservation_select_policy '
      || 'ON backlink_rate_limit_reservations';
    EXECUTE $policy$
      CREATE POLICY backlink_rate_limit_reservation_select_policy
        ON backlink_rate_limit_reservations
        FOR SELECT
        USING (
          organization_id =
            NULLIF(
              current_setting('app.current_organization_id', true),
              ''
            )::uuid
          AND (
            (
              workspace_id =
                NULLIF(
                  current_setting('app.current_workspace_id', true),
                  ''
                )::uuid
              AND website_project_id =
                NULLIF(
                  current_setting('app.current_website_project_id', true),
                  ''
                )::uuid
            )
            OR (
              gmail_connection_id =
                NULLIF(
                  current_setting(
                    'app.current_gmail_connection_id',
                    true
                  ),
                  ''
                )::uuid
              AND EXISTS (
                SELECT 1
                FROM backlink_gmail_workspace_bindings AS binding
                JOIN backlink_website_project_mailbox_bindings AS project_binding
                  ON project_binding.organization_id =
                    binding.organization_id
                 AND project_binding.workspace_id = binding.workspace_id
                 AND project_binding.gmail_workspace_binding_id = binding.id
                WHERE binding.organization_id =
                    backlink_rate_limit_reservations.organization_id
                  AND binding.workspace_id =
                    NULLIF(
                      current_setting('app.current_workspace_id', true),
                      ''
                    )::uuid
                  AND binding.gmail_connection_id =
                    backlink_rate_limit_reservations.gmail_connection_id
                  AND binding.binding_status = 'ACTIVE'
                  AND project_binding.website_project_id =
                    NULLIF(
                      current_setting(
                        'app.current_website_project_id',
                        true
                      ),
                      ''
                    )::uuid
                  AND project_binding.binding_status = 'ACTIVE'
                  AND project_binding.is_selected = true
              )
            )
          )
        )
    $policy$;
  END IF;
END
$rate_limit_policy$;

ALTER TABLE backlink_gmail_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_workspace_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_oauth_attempts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON backlink_website_project_mailbox_bindings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_website_project_mailbox_bindings
  TO growthos_backlinks_writer;

COMMIT;
