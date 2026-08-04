BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_suppression_entries
  DROP CONSTRAINT backlink_suppression_reason_check;

ALTER TABLE backlink_suppression_entries
  ADD CONSTRAINT backlink_suppression_reason_check CHECK (
    reason IN (
      'REJECTION', 'UNSUBSCRIBE', 'COMPLAINT', 'LEGAL', 'SECURITY',
      'HARD_BOUNCE', 'SOFT_BOUNCE_THRESHOLD', 'MANUAL'
    )
  );

CREATE TABLE backlink_suppression_feedback_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  source_event_id text NOT NULL,
  target_hmac text NOT NULL,
  hash_key_version integer NOT NULL,
  kind text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  applied_suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_suppression_feedback_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_suppression_feedback_source_event_uq UNIQUE (
    organization_id, source_event_id
  ),
  CONSTRAINT backlink_suppression_feedback_target_check CHECK (
    target_hmac ~ '^[a-f0-9]{64}$'
    AND hash_key_version > 0
  ),
  CONSTRAINT backlink_suppression_feedback_kind_check CHECK (
    kind IN ('HARD_BOUNCE', 'SOFT_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBE')
  ),
  CONSTRAINT backlink_suppression_feedback_timing_check CHECK (
    observed_at <= recorded_at
  ),
  CONSTRAINT backlink_suppression_feedback_source_check CHECK (
    length(btrim(source_event_id)) > 0
    AND length(source_event_id) <= 255
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_suppression_feedback_action_check CHECK (
    (
      kind = 'HARD_BOUNCE'
      AND applied_suppression_reason = 'HARD_BOUNCE'
    )
    OR (
      kind = 'COMPLAINT'
      AND applied_suppression_reason = 'COMPLAINT'
    )
    OR (
      kind = 'UNSUBSCRIBE'
      AND applied_suppression_reason = 'UNSUBSCRIBE'
    )
    OR (
      kind = 'SOFT_BOUNCE'
      AND applied_suppression_reason IS NULL
    )
    OR (
      kind = 'SOFT_BOUNCE'
      AND applied_suppression_reason = 'SOFT_BOUNCE_THRESHOLD'
    )
  )
);

CREATE INDEX backlink_suppression_feedback_soft_bounce_lookup_idx
  ON backlink_suppression_feedback_events (
    organization_id, target_hmac, hash_key_version, observed_at
  )
  WHERE kind = 'SOFT_BOUNCE';

CREATE FUNCTION backlink_reject_suppression_feedback_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Suppression feedback rows are append-only'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_suppression_feedback_immutable
BEFORE UPDATE OR DELETE ON backlink_suppression_feedback_events
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_suppression_feedback_mutation();

ALTER TABLE backlink_suppression_feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_suppression_feedback_events FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_suppression_feedback_tenant_policy
  ON backlink_suppression_feedback_events
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

REVOKE ALL ON backlink_suppression_feedback_events FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_suppression_feedback_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_suppression_feedback_events
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_suppression_feedback_events
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_suppression_feedback_events
  TO growthos_reporting_reader;

COMMIT;
