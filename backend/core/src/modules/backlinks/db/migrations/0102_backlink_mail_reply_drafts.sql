BEGIN;
SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_mail_reply_drafts (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  provider_thread_id text NOT NULL,
  in_reply_to text NOT NULL,
  reference_ids jsonb NOT NULL,
  recipient text NOT NULL,
  content_hash text NOT NULL,
  confirmation_mode text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workspace_id, website_project_id, mail_message_id),
  UNIQUE (organization_id, workspace_id, website_project_id, draft_id),
  FOREIGN KEY (organization_id,workspace_id,website_project_id,mail_message_id,gmail_connection_id)
    REFERENCES backlink_mail_messages
      (organization_id,workspace_id,website_project_id,id,gmail_connection_id),
  FOREIGN KEY (organization_id,workspace_id,website_project_id,draft_id,opportunity_id)
    REFERENCES backlink_email_drafts
      (organization_id,workspace_id,website_project_id,id,opportunity_id),
  FOREIGN KEY (organization_id,workspace_id,website_project_id,draft_version_id,draft_id,opportunity_id)
    REFERENCES backlink_draft_versions
      (organization_id,workspace_id,website_project_id,id,draft_id,opportunity_id),
  CHECK (length(provider_thread_id)>0 AND length(in_reply_to)>0),
  CHECK (jsonb_typeof(reference_ids)='array'),
  CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CHECK (confirmation_mode IN ('MANUAL','ONE_REPLY'))
);
ALTER TABLE backlink_mail_reply_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_reply_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_mail_reply_tenant ON backlink_mail_reply_drafts
  USING (
    organization_id=NULLIF(current_setting('app.current_organization_id',true),'')::uuid
    AND workspace_id=NULLIF(current_setting('app.current_workspace_id',true),'')::uuid
    AND website_project_id=NULLIF(current_setting('app.current_website_project_id',true),'')::uuid
  );
CREATE TRIGGER backlink_mail_reply_immutable
  BEFORE UPDATE OR DELETE ON backlink_mail_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION backlink_reject_draft_immutable_mutation();
REVOKE ALL ON backlink_mail_reply_drafts FROM PUBLIC;
GRANT SELECT,INSERT ON backlink_mail_reply_drafts TO growthos_backlinks_writer;
GRANT SELECT ON backlink_mail_reply_drafts TO growthos_reporting_reader;
COMMIT;
