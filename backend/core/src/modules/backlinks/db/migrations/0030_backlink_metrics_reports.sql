BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_metric_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  metric_key text NOT NULL,
  metric_definition_version text NOT NULL,
  snapshot_version integer NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  workspace_timezone text NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  dimension_hash text NOT NULL,
  numerator numeric(30, 10) NOT NULL,
  denominator numeric(30, 10),
  value_numeric numeric(30, 10),
  source_started_at timestamptz,
  source_ended_at timestamptz,
  source_fact_count integer NOT NULL,
  source_fact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_watermark_at timestamptz,
  source_watermark_id text,
  input_checksum text NOT NULL,
  result_checksum text NOT NULL,
  computed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_metric_snapshot_identity_check CHECK (
    length(btrim(metric_key)) > 0
    AND length(btrim(metric_definition_version)) > 0
    AND snapshot_version > 0
    AND length(btrim(workspace_timezone)) > 0
    AND window_start < window_end
    AND as_of >= window_end
  ),
  CONSTRAINT backlink_metric_snapshot_dimensions_check CHECK (
    jsonb_typeof(dimensions) = 'object'
    AND dimension_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_metric_snapshot_value_check CHECK (
    numerator >= 0
    AND (denominator IS NULL OR denominator >= 0)
    AND (
      (denominator IS NULL AND value_numeric = numerator)
      OR (denominator = 0 AND value_numeric IS NULL)
      OR (denominator > 0 AND value_numeric IS NOT NULL)
    )
  ),
  CONSTRAINT backlink_metric_snapshot_source_check CHECK (
    source_fact_count >= 0
    AND jsonb_typeof(source_fact_ids) = 'array'
    AND jsonb_array_length(source_fact_ids) = source_fact_count
    AND (
      (
        source_fact_count = 0
        AND source_started_at IS NULL
        AND source_ended_at IS NULL
        AND source_watermark_at IS NULL
        AND source_watermark_id IS NULL
      )
      OR (
        source_fact_count > 0
        AND source_started_at IS NOT NULL
        AND source_ended_at IS NOT NULL
        AND source_watermark_at IS NOT NULL
        AND length(btrim(source_watermark_id)) > 0
        AND source_started_at <= source_ended_at
        AND source_ended_at <= source_watermark_at
      )
    )
  ),
  CONSTRAINT backlink_metric_snapshot_checksum_check CHECK (
    input_checksum ~ '^[a-f0-9]{64}$'
    AND result_checksum ~ '^[a-f0-9]{64}$'
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_metric_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_metric_snapshot_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, metric_key,
    metric_definition_version, window_start, window_end, as_of,
    dimension_hash, snapshot_version
  )
);

CREATE INDEX backlink_metric_snapshot_dashboard_idx
  ON backlink_metric_snapshots (
    organization_id, workspace_id, website_project_id, workspace_timezone,
    window_start, window_end, as_of, metric_key, snapshot_version DESC
  );

CREATE TABLE backlink_report_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  report_key text NOT NULL,
  revision integer NOT NULL,
  input_snapshot_ids jsonb NOT NULL,
  metric_definition_versions jsonb NOT NULL,
  query_spec jsonb NOT NULL,
  report_payload jsonb NOT NULL,
  source_started_at timestamptz NOT NULL,
  source_ended_at timestamptz NOT NULL,
  source_watermark_at timestamptz NOT NULL,
  source_watermark_id text NOT NULL,
  input_checksum text NOT NULL,
  result_checksum text NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_report_revision_identity_check CHECK (
    length(btrim(report_key)) > 0
    AND revision > 0
    AND length(btrim(source_watermark_id)) > 0
    AND source_started_at <= source_ended_at
    AND source_ended_at <= source_watermark_at
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_report_revision_payload_check CHECK (
    jsonb_typeof(input_snapshot_ids) = 'array'
    AND jsonb_array_length(input_snapshot_ids) > 0
    AND jsonb_typeof(metric_definition_versions) = 'object'
    AND metric_definition_versions <> '{}'::jsonb
    AND jsonb_typeof(query_spec) = 'object'
    AND jsonb_typeof(report_payload) = 'object'
  ),
  CONSTRAINT backlink_report_revision_checksum_check CHECK (
    input_checksum ~ '^[a-f0-9]{64}$'
    AND result_checksum ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_report_revision_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, report_key,
    revision
  ),
  CONSTRAINT backlink_report_revision_number_uq UNIQUE (
    organization_id, workspace_id, website_project_id, report_key, revision
  )
);

CREATE TABLE backlink_report_publications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  report_key text NOT NULL,
  report_revision_id uuid NOT NULL,
  report_revision integer NOT NULL,
  published_at timestamptz NOT NULL,
  published_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  CONSTRAINT backlink_report_publication_identity_check CHECK (
    length(btrim(report_key)) > 0
    AND report_revision > 0
    AND version > 0
    AND length(btrim(published_by)) > 0
    AND length(btrim(updated_by)) > 0
  ),
  CONSTRAINT backlink_report_publication_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_report_publication_report_uq UNIQUE (
    organization_id, workspace_id, website_project_id, report_key
  ),
  CONSTRAINT backlink_report_publication_revision_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, report_revision_id,
    report_key, report_revision
  ) REFERENCES backlink_report_revisions (
    organization_id, workspace_id, website_project_id, id, report_key,
    revision
  )
);

CREATE FUNCTION backlink_reject_metric_report_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Backlink Metric Snapshots and Report Revisions are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_metric_snapshot_immutable
BEFORE UPDATE OR DELETE ON backlink_metric_snapshots
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_metric_report_mutation();

CREATE TRIGGER backlink_report_revision_immutable
BEFORE UPDATE OR DELETE ON backlink_report_revisions
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_metric_report_mutation();

ALTER TABLE backlink_metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_metric_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_report_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_report_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_report_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_report_publications FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_metric_snapshot_tenant_policy
  ON backlink_metric_snapshots
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

CREATE POLICY backlink_report_revision_tenant_policy
  ON backlink_report_revisions
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

CREATE POLICY backlink_report_publication_tenant_policy
  ON backlink_report_publications
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

REVOKE ALL ON backlink_metric_snapshots FROM PUBLIC;
REVOKE ALL ON backlink_report_revisions FROM PUBLIC;
REVOKE ALL ON backlink_report_publications FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_metric_report_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_metric_snapshots, backlink_report_revisions
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_metric_snapshots, backlink_report_revisions
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_report_publications
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_metric_snapshots, backlink_report_revisions,
    backlink_report_publications
  TO growthos_reporting_reader;

COMMIT;
