BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_gmail_connections
  ADD COLUMN affected_project_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT backlink_gmail_connection_affected_project_count_check
    CHECK (affected_project_count >= 0);

ALTER TABLE backlink_gmail_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_workspace_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_website_project_mailbox_bindings
  NO FORCE ROW LEVEL SECURITY;

UPDATE backlink_gmail_connections AS connection
   SET affected_project_count = counts.affected_project_count
  FROM (
    SELECT
      binding.organization_id,
      binding.gmail_connection_id,
      count(DISTINCT project_binding.website_project_id)::integer
        AS affected_project_count
      FROM backlink_gmail_workspace_bindings AS binding
      JOIN backlink_website_project_mailbox_bindings AS project_binding
        ON project_binding.organization_id = binding.organization_id
       AND project_binding.workspace_id = binding.workspace_id
       AND project_binding.gmail_workspace_binding_id = binding.id
     WHERE binding.binding_status = 'ACTIVE'
       AND project_binding.binding_status = 'ACTIVE'
       AND project_binding.is_selected = true
     GROUP BY binding.organization_id, binding.gmail_connection_id
  ) AS counts
 WHERE connection.organization_id = counts.organization_id
   AND connection.id = counts.gmail_connection_id;

ALTER TABLE backlink_gmail_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_workspace_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_website_project_mailbox_bindings
  FORCE ROW LEVEL SECURITY;

CREATE FUNCTION backlink_adjust_gmail_affected_project_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  old_connection_id uuid;
  new_connection_id uuid;
BEGIN
  IF TG_OP <> 'INSERT'
     AND OLD.binding_status = 'ACTIVE'
     AND OLD.is_selected = true THEN
    SELECT binding.gmail_connection_id
      INTO old_connection_id
      FROM backlink_gmail_workspace_bindings AS binding
     WHERE binding.organization_id = OLD.organization_id
       AND binding.workspace_id = OLD.workspace_id
       AND binding.id = OLD.gmail_workspace_binding_id;
  END IF;

  IF TG_OP <> 'DELETE'
     AND NEW.binding_status = 'ACTIVE'
     AND NEW.is_selected = true THEN
    SELECT binding.gmail_connection_id
      INTO new_connection_id
      FROM backlink_gmail_workspace_bindings AS binding
     WHERE binding.organization_id = NEW.organization_id
       AND binding.workspace_id = NEW.workspace_id
       AND binding.id = NEW.gmail_workspace_binding_id;
  END IF;

  IF old_connection_id IS NOT NULL
     AND old_connection_id IS DISTINCT FROM new_connection_id THEN
    UPDATE backlink_gmail_connections
       SET affected_project_count =
         greatest(affected_project_count - 1, 0)
     WHERE organization_id = OLD.organization_id
       AND id = old_connection_id;
  END IF;

  IF new_connection_id IS NOT NULL
     AND new_connection_id IS DISTINCT FROM old_connection_id THEN
    UPDATE backlink_gmail_connections
       SET affected_project_count = affected_project_count + 1
     WHERE organization_id = NEW.organization_id
       AND id = new_connection_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_project_mailbox_binding_count_trigger
AFTER INSERT OR UPDATE OR DELETE
ON backlink_website_project_mailbox_bindings
FOR EACH ROW
EXECUTE FUNCTION backlink_adjust_gmail_affected_project_count();

CREATE FUNCTION backlink_count_selected_gmail_projects(
  p_organization_id uuid,
  p_gmail_connection_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT connection.affected_project_count
    FROM backlink_gmail_connections AS connection
   WHERE connection.organization_id = p_organization_id
     AND connection.organization_id =
       NULLIF(
         current_setting('app.current_organization_id', true),
         ''
       )::uuid
     AND connection.id = p_gmail_connection_id
     AND EXISTS (
       SELECT 1
         FROM backlink_gmail_workspace_bindings AS current_binding
        WHERE current_binding.organization_id = p_organization_id
          AND current_binding.workspace_id =
            NULLIF(
              current_setting('app.current_workspace_id', true),
              ''
            )::uuid
          AND current_binding.gmail_connection_id =
            p_gmail_connection_id
          AND current_binding.binding_status = 'ACTIVE'
     );
$function$;

REVOKE ALL
  ON FUNCTION backlink_adjust_gmail_affected_project_count()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_count_selected_gmail_projects(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION backlink_count_selected_gmail_projects(uuid, uuid)
  TO growthos_backlinks_writer;

COMMIT;
