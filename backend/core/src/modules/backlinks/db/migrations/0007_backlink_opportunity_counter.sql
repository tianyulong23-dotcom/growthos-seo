BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_opportunity_project_counters (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  last_join_sequence integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_opportunity_project_counter_pk PRIMARY KEY (
    organization_id, workspace_id, website_project_id
  ),
  CONSTRAINT backlink_opportunity_project_counter_sequence_check
    CHECK (last_join_sequence >= 0),
  CONSTRAINT backlink_opportunity_project_counter_version_check
    CHECK (version >= 0),
  CONSTRAINT backlink_opportunity_project_counter_actor_check CHECK (
    length(btrim(created_by)) > 0
    AND length(btrim(updated_by)) > 0
  )
);

ALTER TABLE backlink_opportunity_project_counters
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_project_counters
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_opportunity_project_counter_tenant_policy
  ON backlink_opportunity_project_counters
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

CREATE FUNCTION backlink_allocate_opportunity_join_sequence(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_website_project_id uuid,
  p_actor_id text
) RETURNS integer
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  allocated_sequence integer;
BEGIN
  IF length(btrim(p_actor_id)) = 0 THEN
    RAISE EXCEPTION 'Opportunity sequence actor is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO backlink_opportunity_project_counters (
    organization_id,
    workspace_id,
    website_project_id,
    created_by,
    updated_by
  ) VALUES (
    p_organization_id,
    p_workspace_id,
    p_website_project_id,
    p_actor_id,
    p_actor_id
  )
  ON CONFLICT (
    organization_id, workspace_id, website_project_id
  ) DO NOTHING;

  SELECT last_join_sequence
    INTO allocated_sequence
    FROM backlink_opportunity_project_counters
    WHERE (
      organization_id, workspace_id, website_project_id
    ) = (
      p_organization_id, p_workspace_id, p_website_project_id
    )
    FOR UPDATE;

  allocated_sequence := allocated_sequence + 1;

  UPDATE backlink_opportunity_project_counters
    SET last_join_sequence = allocated_sequence,
        version = version + 1,
        updated_at = now(),
        updated_by = p_actor_id
    WHERE (
      organization_id, workspace_id, website_project_id
    ) = (
      p_organization_id, p_workspace_id, p_website_project_id
    );

  RETURN allocated_sequence;
END;
$function$;

REVOKE ALL ON backlink_opportunity_project_counters FROM PUBLIC;
REVOKE ALL ON FUNCTION backlink_allocate_opportunity_join_sequence(
  uuid, uuid, uuid, text
) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_opportunity_project_counters
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_opportunity_project_counters
  TO growthos_reporting_reader;
GRANT EXECUTE ON FUNCTION backlink_allocate_opportunity_join_sequence(
  uuid, uuid, uuid, text
) TO growthos_backlinks_writer;

COMMIT;
