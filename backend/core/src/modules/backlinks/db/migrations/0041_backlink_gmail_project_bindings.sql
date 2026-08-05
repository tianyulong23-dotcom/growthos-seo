BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_gmail_workspace_bindings
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_project_context_snapshots
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_gmail_workspace_bindings
  ADD COLUMN website_project_id uuid;

WITH project_binding AS (
  SELECT
    binding.id AS binding_id,
    (
      SELECT snapshot.website_project_id
      FROM backlink_project_context_snapshots AS snapshot
      WHERE snapshot.organization_id = binding.organization_id
        AND snapshot.workspace_id = binding.workspace_id
      ORDER BY
        (snapshot.created_at > binding.created_at),
        CASE
          WHEN snapshot.created_at <= binding.created_at
          THEN snapshot.created_at
        END DESC,
        CASE
          WHEN snapshot.created_at > binding.created_at
          THEN snapshot.created_at
        END,
        snapshot.snapshot_version DESC
      LIMIT 1
    ) AS website_project_id
  FROM backlink_gmail_workspace_bindings AS binding
)
UPDATE backlink_gmail_workspace_bindings AS binding
SET website_project_id = project_binding.website_project_id
FROM project_binding
WHERE binding.id = project_binding.binding_id;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM backlink_gmail_workspace_bindings
    WHERE website_project_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot assign existing Gmail binding to a Website Project';
  END IF;
END
$migration$;

ALTER TABLE backlink_gmail_workspace_bindings
  ALTER COLUMN website_project_id SET NOT NULL,
  DROP CONSTRAINT backlink_gmail_workspace_binding_identity_uq,
  ADD CONSTRAINT backlink_gmail_workspace_binding_identity_uq UNIQUE (
    organization_id,
    workspace_id,
    website_project_id,
    gmail_connection_id
  );

UPDATE backlink_gmail_workspace_bindings AS older
SET binding_status = 'INACTIVE',
    version = older.version + 1,
    updated_at = now(),
    updated_by = 'migration-0041'
WHERE older.binding_status = 'ACTIVE'
  AND EXISTS (
    SELECT 1
    FROM backlink_gmail_workspace_bindings AS newer
    WHERE newer.organization_id = older.organization_id
      AND newer.gmail_connection_id = older.gmail_connection_id
      AND newer.binding_status = 'ACTIVE'
      AND (newer.created_at, newer.id) > (older.created_at, older.id)
  );

DROP INDEX backlink_gmail_workspace_primary_active_uq;
CREATE UNIQUE INDEX backlink_gmail_workspace_primary_active_uq
  ON backlink_gmail_workspace_bindings (
    organization_id,
    workspace_id,
    website_project_id
  )
  WHERE binding_status = 'ACTIVE' AND is_primary = true;

CREATE UNIQUE INDEX backlink_gmail_connection_single_active_binding_uq
  ON backlink_gmail_workspace_bindings (
    organization_id,
    gmail_connection_id
  )
  WHERE binding_status = 'ACTIVE';

DROP INDEX backlink_gmail_connection_active_subject_uq;
CREATE INDEX backlink_gmail_connection_subject_idx
  ON backlink_gmail_connections (organization_id, google_subject);

DROP POLICY backlink_gmail_workspace_binding_tenant_policy
  ON backlink_gmail_workspace_bindings;

CREATE POLICY backlink_gmail_workspace_binding_tenant_policy
  ON backlink_gmail_workspace_bindings
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

ALTER TABLE backlink_gmail_workspace_bindings
  FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_project_context_snapshots
  FORCE ROW LEVEL SECURITY;

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
                WHERE binding.organization_id =
                    backlink_rate_limit_reservations.organization_id
                  AND binding.workspace_id =
                    NULLIF(
                      current_setting('app.current_workspace_id', true),
                      ''
                    )::uuid
                  AND binding.website_project_id =
                    NULLIF(
                      current_setting(
                        'app.current_website_project_id',
                        true
                      ),
                      ''
                    )::uuid
                  AND binding.gmail_connection_id =
                    backlink_rate_limit_reservations.gmail_connection_id
                  AND binding.binding_status = 'ACTIVE'
              )
            )
          )
        )
    $policy$;
  END IF;
END
$rate_limit_policy$;

COMMIT;
