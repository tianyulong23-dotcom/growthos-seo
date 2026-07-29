BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_send_reconciliations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  send_intent_id uuid NOT NULL,
  send_attempt_id uuid NOT NULL,
  outcome text NOT NULL,
  provider_message_id text,
  provider_thread_id text,
  evidence_reference text NOT NULL,
  reconciled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_send_reconciliation_outcome_check CHECK (
    (
      outcome = 'PROVIDER_ACCEPTED'
      AND length(btrim(provider_message_id)) > 0
      AND (
        provider_thread_id IS NULL
        OR length(btrim(provider_thread_id)) > 0
      )
    )
    OR (
      outcome = 'CONFIRMED_NOT_SENT'
      AND provider_message_id IS NULL
      AND provider_thread_id IS NULL
    )
  ),
  CONSTRAINT backlink_send_reconciliation_evidence_check CHECK (
    length(btrim(evidence_reference)) > 0
  ),
  CONSTRAINT backlink_send_reconciliation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_reconciliation_intent_uq UNIQUE (send_intent_id),
  CONSTRAINT backlink_send_reconciliation_attempt_uq UNIQUE (send_attempt_id),
  CONSTRAINT backlink_send_reconciliation_intent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, send_intent_id
  ) REFERENCES backlink_send_intents (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_reconciliation_attempt_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, send_attempt_id
  ) REFERENCES backlink_send_attempts (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE FUNCTION backlink_reject_send_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Send reconciliation rows are append-only'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_send_reconciliation_immutable
BEFORE UPDATE OR DELETE ON backlink_send_reconciliations
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_send_reconciliation_mutation();

ALTER TABLE backlink_send_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_send_reconciliations FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_send_reconciliation_tenant_policy
  ON backlink_send_reconciliations
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

REVOKE ALL ON backlink_send_reconciliations FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_send_reconciliation_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_send_reconciliations
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_send_reconciliations
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_send_reconciliations
  TO growthos_reporting_reader;

COMMIT;
