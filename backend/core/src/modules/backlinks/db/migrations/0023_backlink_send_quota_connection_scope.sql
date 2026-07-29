BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

DROP POLICY backlink_rate_limit_reservation_tenant_policy
  ON backlink_rate_limit_reservations;

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
          NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
        AND website_project_id =
          NULLIF(
            current_setting('app.current_website_project_id', true),
            ''
          )::uuid
      )
      OR (
        gmail_connection_id =
          NULLIF(
            current_setting('app.current_gmail_connection_id', true),
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
            AND binding.gmail_connection_id =
              backlink_rate_limit_reservations.gmail_connection_id
            AND binding.binding_status = 'ACTIVE'
        )
      )
    )
  );

CREATE POLICY backlink_rate_limit_reservation_insert_policy
  ON backlink_rate_limit_reservations
  FOR INSERT
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

CREATE POLICY backlink_rate_limit_reservation_update_policy
  ON backlink_rate_limit_reservations
  FOR UPDATE
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

COMMIT;
