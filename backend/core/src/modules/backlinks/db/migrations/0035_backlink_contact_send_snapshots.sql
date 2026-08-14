BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_contacts
  ADD CONSTRAINT backlink_contact_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_gmail_send_identities
  ADD CONSTRAINT backlink_gmail_send_identity_tenant_identity_uq UNIQUE (
    organization_id, id, gmail_connection_id
  );

ALTER TABLE backlink_email_drafts
  ADD COLUMN contact_id uuid,
  ADD COLUMN contact_version integer,
  ADD CONSTRAINT backlink_email_draft_contact_binding_check CHECK (
    (
      contact_id IS NULL
      AND contact_version IS NULL
    )
    OR (
      contact_id IS NOT NULL
      AND contact_version > 0
    )
  ),
  ADD CONSTRAINT backlink_email_draft_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_id
  ) REFERENCES backlink_contacts (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_model_runs
  ADD COLUMN contact_id uuid,
  ADD COLUMN contact_version integer,
  ADD CONSTRAINT backlink_model_run_contact_binding_check CHECK (
    (
      contact_id IS NULL
      AND contact_version IS NULL
    )
    OR (
      contact_id IS NOT NULL
      AND contact_version > 0
    )
  ),
  ADD CONSTRAINT backlink_model_run_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_id
  ) REFERENCES backlink_contacts (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_draft_versions
  ADD COLUMN contact_id uuid,
  ADD COLUMN contact_version integer,
  ADD CONSTRAINT backlink_draft_version_contact_binding_check CHECK (
    (
      contact_id IS NULL
      AND contact_version IS NULL
    )
    OR (
      contact_id IS NOT NULL
      AND contact_version > 0
    )
  ),
  ADD CONSTRAINT backlink_draft_version_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_id
  ) REFERENCES backlink_contacts (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_send_intents
  ADD COLUMN contact_id uuid,
  ADD COLUMN contact_version integer,
  ADD COLUMN send_snapshot_id uuid,
  ADD CONSTRAINT backlink_send_intent_contact_snapshot_check CHECK (
    (
      contact_id IS NULL
      AND contact_version IS NULL
      AND send_snapshot_id IS NULL
    )
    OR (
      contact_id IS NOT NULL
      AND contact_version > 0
      AND send_snapshot_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT backlink_send_intent_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_id
  ) REFERENCES backlink_contacts (
    organization_id, workspace_id, website_project_id, id
  );

CREATE UNIQUE INDEX backlink_send_intent_snapshot_uq
  ON backlink_send_intents (
    organization_id, workspace_id, website_project_id, send_snapshot_id
  )
  WHERE send_snapshot_id IS NOT NULL;

CREATE TABLE backlink_send_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  send_intent_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  opportunity_version integer NOT NULL,
  draft_id uuid NOT NULL,
  draft_version_id uuid NOT NULL,
  draft_version_no integer NOT NULL,
  contact_id uuid NOT NULL,
  contact_version integer NOT NULL,
  recipient text NOT NULL,
  recipient_hash text NOT NULL,
  subject_text text NOT NULL,
  body_text text NOT NULL,
  body_document jsonb,
  content_hash text NOT NULL,
  gmail_connection_id uuid NOT NULL,
  gmail_connection_version integer NOT NULL,
  gmail_identity_id uuid NOT NULL,
  gmail_identity_version integer NOT NULL,
  snapshot_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_send_snapshot_values_check CHECK (
    opportunity_version > 0
    AND draft_version_no > 0
    AND contact_version > 0
    AND gmail_connection_version > 0
    AND gmail_identity_version > 0
    AND snapshot_schema_version > 0
    AND recipient = lower(btrim(recipient))
    AND position('@' IN recipient) > 1
    AND recipient_hash ~ '^[a-f0-9]{64}$'
    AND content_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(subject_text)) > 0
    AND length(btrim(body_text)) > 0
  ),
  CONSTRAINT backlink_send_snapshot_body_document_check CHECK (
    body_document IS NULL
    OR (
      jsonb_typeof(body_document) = 'object'
      AND body_document ->> 'type' = 'doc'
      AND jsonb_typeof(body_document -> 'content') = 'array'
    )
  ),
  CONSTRAINT backlink_send_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, send_intent_id
  ),
  CONSTRAINT backlink_send_snapshot_intent_uq UNIQUE (
    organization_id, workspace_id, website_project_id, send_intent_id
  ),
  CONSTRAINT backlink_send_snapshot_intent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, send_intent_id
  ) REFERENCES backlink_send_intents (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_snapshot_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_snapshot_draft_version_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    draft_version_id, draft_id, opportunity_id
  ) REFERENCES backlink_draft_versions (
    organization_id, workspace_id, website_project_id,
    id, draft_id, opportunity_id
  ),
  CONSTRAINT backlink_send_snapshot_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_id
  ) REFERENCES backlink_contacts (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_snapshot_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (
    organization_id, id
  ),
  CONSTRAINT backlink_send_snapshot_identity_fk FOREIGN KEY (
    organization_id, gmail_identity_id, gmail_connection_id
  ) REFERENCES backlink_gmail_send_identities (
    organization_id, id, gmail_connection_id
  )
);

CREATE FUNCTION backlink_reject_send_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'backlink_send_snapshots are immutable';
END;
$function$;

CREATE TRIGGER backlink_send_snapshot_immutable
BEFORE UPDATE OR DELETE ON backlink_send_snapshots
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_send_snapshot_mutation();

CREATE FUNCTION backlink_invalidate_contact_draft_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF (
    NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
    OR NEW.contact_role IS DISTINCT FROM OLD.contact_role
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.guessed IS DISTINCT FROM OLD.guessed
    OR NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at
    OR NEW.version IS DISTINCT FROM OLD.version
  ) THEN
    UPDATE backlink_email_drafts
       SET approved_version_id = NULL,
           status = CASE WHEN status = 'approved' THEN 'draft' ELSE status END,
           version = version + 1,
           updated_at = now(),
           updated_by = NEW.updated_by
     WHERE organization_id = OLD.organization_id
       AND workspace_id = OLD.workspace_id
       AND website_project_id = OLD.website_project_id
       AND contact_id = OLD.id
       AND contact_version = OLD.version
       AND approved_version_id IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_contact_draft_approval_invalidation
AFTER UPDATE ON backlink_contacts
FOR EACH ROW
EXECUTE FUNCTION backlink_invalidate_contact_draft_approval();

ALTER TABLE backlink_send_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_send_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_send_snapshot_tenant_policy
  ON backlink_send_snapshots
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

REVOKE ALL ON backlink_send_snapshots FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_send_snapshot_mutation()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_invalidate_contact_draft_approval()
  FROM PUBLIC;

GRANT SELECT, INSERT
  ON backlink_send_snapshots
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_send_snapshots
  TO growthos_reporting_reader;

COMMIT;
