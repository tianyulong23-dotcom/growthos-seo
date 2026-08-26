BEGIN;

CREATE TEMP TABLE local_project_tenant_target (
  organization_id text NOT NULL,
  workspace_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO local_project_tenant_target (
  organization_id,
  workspace_id
)
VALUES (
  :'canonical_organization_id'::uuid::text,
  :'canonical_workspace_id'::uuid::text
);

DO $reconcile$
DECLARE
  target_organization_id text;
  target_workspace_id text;
  project_record record;
  relation_record record;
  project_column text;
  conflict_count bigint;
  latest_snapshot_version integer;
BEGIN
  SELECT organization_id, workspace_id
    INTO target_organization_id, target_workspace_id
    FROM local_project_tenant_target;

  IF target_organization_id = target_workspace_id THEN
    RAISE EXCEPTION
      'LOCAL_PROJECT_TENANT_CONFIGURATION_INVALID: organization and workspace must differ';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM platform.projects
     WHERE (organization_id = 'local') <> (workspace_id = 'local')
  ) THEN
    RAISE EXCEPTION
      'LOCAL_PROJECT_TENANT_PARTIAL_MISMATCH: project has only one legacy tenant dimension';
  END IF;

  FOR project_record IN
    SELECT id, context_version
      FROM platform.projects
     WHERE organization_id = 'local'
       AND workspace_id = 'local'
     ORDER BY id
     FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1
        FROM backlinks.backlink_project_context_snapshots AS snapshot
       WHERE snapshot.website_project_id::text = project_record.id
         AND (
           snapshot.organization_id::text <> target_organization_id
           OR snapshot.workspace_id::text <> target_workspace_id
         )
    ) THEN
      RAISE EXCEPTION
        'LOCAL_PROJECT_BACKLINKS_TENANT_MISMATCH: project % has conflicting Backlinks snapshots',
        project_record.id;
    END IF;

    SELECT max(snapshot.snapshot_version)
      INTO latest_snapshot_version
      FROM backlinks.backlink_project_context_snapshots AS snapshot
     WHERE snapshot.website_project_id::text = project_record.id;

    IF latest_snapshot_version IS NOT NULL
       AND latest_snapshot_version <> project_record.context_version THEN
      RAISE EXCEPTION
        'LOCAL_PROJECT_CONTEXT_VERSION_MISMATCH: project % has Platform version % and Backlinks version %',
        project_record.id,
        project_record.context_version,
        latest_snapshot_version;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM platform.project_outbox_events AS event
       WHERE event.project_id = project_record.id
         AND (
           (
             event.payload #>> '{context,tenant,organizationId}' IS NOT NULL
             AND event.payload #>> '{context,tenant,organizationId}'
               NOT IN ('local', target_organization_id)
           )
           OR (
             event.payload #>> '{context,tenant,workspaceId}' IS NOT NULL
             AND event.payload #>> '{context,tenant,workspaceId}'
               NOT IN ('local', target_workspace_id)
           )
         )
    ) THEN
      RAISE EXCEPTION
        'LOCAL_PROJECT_OUTBOX_TENANT_MISMATCH: project % has a conflicting event payload',
        project_record.id;
    END IF;

    FOR relation_record IN
      SELECT
        columns.table_schema,
        columns.table_name,
        bool_or(columns.column_name = 'workspace_id') AS has_workspace_id,
        bool_or(columns.column_name = 'project_id') AS has_project_id,
        bool_or(columns.column_name = 'website_project_id')
          AS has_website_project_id
      FROM information_schema.columns AS columns
      JOIN information_schema.tables AS tables
        ON tables.table_schema = columns.table_schema
       AND tables.table_name = columns.table_name
       AND tables.table_type = 'BASE TABLE'
     WHERE columns.table_schema IN ('platform', 'public', 'crawling', 'audit')
     GROUP BY columns.table_schema, columns.table_name
    HAVING bool_or(columns.column_name = 'organization_id')
       AND (
         bool_or(columns.column_name = 'project_id')
         OR bool_or(columns.column_name = 'website_project_id')
       )
     ORDER BY columns.table_schema, columns.table_name
    LOOP
      project_column := CASE
        WHEN relation_record.has_project_id THEN 'project_id'
        ELSE 'website_project_id'
      END;

      EXECUTE format(
        'SELECT count(*) FROM %I.%I'
        || ' WHERE %I::text = $1'
        || ' AND organization_id <> ''local'''
        || ' AND organization_id <> $2',
        relation_record.table_schema,
        relation_record.table_name,
        project_column
      )
      INTO conflict_count
      USING project_record.id, target_organization_id;

      IF conflict_count > 0 THEN
        RAISE EXCEPTION
          'LOCAL_PROJECT_RELATED_TENANT_MISMATCH: project % has conflicting rows in %.%',
          project_record.id,
          relation_record.table_schema,
          relation_record.table_name;
      END IF;

      IF relation_record.has_workspace_id THEN
        EXECUTE format(
          'SELECT count(*) FROM %I.%I'
          || ' WHERE %I::text = $1'
          || ' AND workspace_id <> ''local'''
          || ' AND workspace_id <> $2',
          relation_record.table_schema,
          relation_record.table_name,
          project_column
        )
        INTO conflict_count
        USING project_record.id, target_workspace_id;

        IF conflict_count > 0 THEN
          RAISE EXCEPTION
            'LOCAL_PROJECT_RELATED_WORKSPACE_MISMATCH: project % has conflicting rows in %.%',
            project_record.id,
            relation_record.table_schema,
            relation_record.table_name;
        END IF;

        EXECUTE format(
          'UPDATE %I.%I'
          || ' SET organization_id = CASE'
          || '   WHEN organization_id = ''local'' THEN $2'
          || '   ELSE organization_id END,'
          || ' workspace_id = CASE'
          || '   WHEN workspace_id = ''local'' THEN $3'
          || '   ELSE workspace_id END'
          || ' WHERE %I::text = $1'
          || ' AND (organization_id = ''local'' OR workspace_id = ''local'')',
          relation_record.table_schema,
          relation_record.table_name,
          project_column
        )
        USING
          project_record.id,
          target_organization_id,
          target_workspace_id;
      ELSE
        EXECUTE format(
          'UPDATE %I.%I'
          || ' SET organization_id = $2'
          || ' WHERE %I::text = $1'
          || ' AND organization_id = ''local''',
          relation_record.table_schema,
          relation_record.table_name,
          project_column
        )
        USING project_record.id, target_organization_id;
      END IF;
    END LOOP;

    UPDATE platform.project_outbox_events
       SET payload = jsonb_set(
         jsonb_set(
           payload,
           '{context,tenant,organizationId}',
           to_jsonb(target_organization_id),
           true
         ),
         '{context,tenant,workspaceId}',
         to_jsonb(target_workspace_id),
         true
       )
     WHERE project_id = project_record.id
       AND jsonb_typeof(payload #> '{context,tenant}') = 'object';

    UPDATE platform.projects
       SET organization_id = target_organization_id,
           workspace_id = target_workspace_id
     WHERE id = project_record.id;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM platform.projects
     WHERE organization_id = 'local'
        OR workspace_id = 'local'
  ) THEN
    RAISE EXCEPTION
      'LOCAL_PROJECT_TENANT_RECONCILIATION_INCOMPLETE: legacy tenant markers remain';
  END IF;
END;
$reconcile$;

COMMIT;

SELECT 'LOCAL_PROJECT_TENANT_RECONCILIATION_OK' AS status;
