BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_mail_sync_cursors (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  history_id text,
  next_page_token text,
  initial_sync_completed_at timestamptz,
  last_synced_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_mail_sync_cursor_values_check CHECK (
    version > 0
    AND (
      history_id IS NULL
      OR history_id ~ '^[1-9][0-9]*$'
    )
    AND (
      next_page_token IS NULL
      OR length(btrim(next_page_token)) > 0
    )
    AND (
      initial_sync_completed_at IS NULL
      OR last_synced_at IS NULL
      OR initial_sync_completed_at <= last_synced_at
    )
  ),
  CONSTRAINT backlink_mail_sync_cursor_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_mail_sync_cursor_connection_uq UNIQUE (
    organization_id, workspace_id, website_project_id, gmail_connection_id
  ),
  CONSTRAINT backlink_mail_sync_cursor_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE TABLE backlink_mail_raw_message_references (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  provider_thread_id text NOT NULL,
  history_id text,
  raw_object_key text,
  raw_content_sha256 text NOT NULL,
  raw_size_bytes integer NOT NULL,
  fetched_at timestamptz NOT NULL,
  retention_expires_at timestamptz NOT NULL,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_mail_raw_message_reference_values_check CHECK (
    length(btrim(provider_message_id)) > 0
    AND length(btrim(provider_thread_id)) > 0
    AND (
      history_id IS NULL
      OR history_id ~ '^[1-9][0-9]*$'
    )
    AND raw_content_sha256 ~ '^[a-f0-9]{64}$'
    AND raw_size_bytes >= 0
    AND retention_expires_at > fetched_at
    AND (
      (
        purged_at IS NULL
        AND length(btrim(raw_object_key)) > 0
      )
      OR (
        purged_at IS NOT NULL
        AND purged_at >= retention_expires_at
        AND raw_object_key IS NULL
      )
    )
  ),
  CONSTRAINT backlink_mail_raw_message_reference_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_mail_raw_message_reference_connection_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, gmail_connection_id
  ),
  CONSTRAINT backlink_mail_raw_message_reference_provider_uq UNIQUE (
    organization_id, workspace_id, website_project_id, gmail_connection_id,
    provider_message_id
  ),
  CONSTRAINT backlink_mail_raw_message_reference_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE TABLE backlink_mail_threads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  provider_thread_id text NOT NULL,
  latest_message_at timestamptz,
  message_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_mail_thread_values_check CHECK (
    length(btrim(provider_thread_id)) > 0
    AND message_count >= 0
    AND version > 0
  ),
  CONSTRAINT backlink_mail_thread_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_mail_thread_connection_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, gmail_connection_id
  ),
  CONSTRAINT backlink_mail_thread_provider_uq UNIQUE (
    organization_id, workspace_id, website_project_id, gmail_connection_id,
    provider_thread_id
  ),
  CONSTRAINT backlink_mail_thread_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE TABLE backlink_mail_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  raw_message_reference_id uuid NOT NULL,
  mail_thread_id uuid NOT NULL,
  rfc_message_id text,
  in_reply_to_message_id text,
  reference_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  from_address text,
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject_text text,
  received_at timestamptz,
  direction text NOT NULL,
  parse_status text NOT NULL DEFAULT 'PENDING',
  parsed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_mail_message_values_check CHECK (
    jsonb_typeof(reference_message_ids) = 'array'
    AND jsonb_typeof(to_addresses) = 'array'
    AND jsonb_typeof(cc_addresses) = 'array'
    AND direction IN ('INBOUND', 'OUTBOUND')
    AND parse_status IN ('PENDING', 'PARSED', 'FAILED')
    AND version > 0
    AND (
      parse_status = 'PENDING'
      OR parsed_at IS NOT NULL
    )
  ),
  CONSTRAINT backlink_mail_message_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_mail_message_connection_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, gmail_connection_id
  ),
  CONSTRAINT backlink_mail_message_raw_reference_uq UNIQUE (
    raw_message_reference_id
  ),
  CONSTRAINT backlink_mail_message_raw_reference_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, raw_message_reference_id,
    gmail_connection_id
  ) REFERENCES backlink_mail_raw_message_references (
    organization_id, workspace_id, website_project_id, id, gmail_connection_id
  ),
  CONSTRAINT backlink_mail_message_thread_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, mail_thread_id,
    gmail_connection_id
  ) REFERENCES backlink_mail_threads (
    organization_id, workspace_id, website_project_id, id, gmail_connection_id
  )
);

CREATE TABLE backlink_inbound_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  match_status text NOT NULL DEFAULT 'UNMATCHED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_inbound_message_status_check CHECK (
    match_status IN ('UNMATCHED', 'CANDIDATES_READY', 'MATCH_CONFIRMED')
  ),
  CONSTRAINT backlink_inbound_message_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_inbound_message_mail_message_uq UNIQUE (
    mail_message_id
  ),
  CONSTRAINT backlink_inbound_message_mail_message_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, mail_message_id,
    gmail_connection_id
  ) REFERENCES backlink_mail_messages (
    organization_id, workspace_id, website_project_id, id, gmail_connection_id
  )
);

CREATE TABLE backlink_reply_match_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  candidate_rank integer NOT NULL,
  confidence_score numeric(5, 4) NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_manual_confirmation boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_reply_match_candidate_values_check CHECK (
    candidate_rank > 0
    AND confidence_score >= 0
    AND confidence_score <= 1
    AND jsonb_typeof(reason_codes) = 'array'
  ),
  CONSTRAINT backlink_reply_match_candidate_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_reply_match_candidate_reply_opportunity_uq UNIQUE (
    inbound_message_id, opportunity_id
  ),
  CONSTRAINT backlink_reply_match_candidate_inbound_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inbound_message_id
  ) REFERENCES backlink_inbound_messages (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_reply_match_candidate_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX backlink_mail_raw_message_reference_retention_idx
  ON backlink_mail_raw_message_references (retention_expires_at)
  WHERE purged_at IS NULL;

CREATE INDEX backlink_mail_message_thread_received_idx
  ON backlink_mail_messages (mail_thread_id, received_at DESC);

CREATE INDEX backlink_inbound_message_match_status_idx
  ON backlink_inbound_messages (
    organization_id, workspace_id, website_project_id, match_status, received_at DESC
  );

CREATE INDEX backlink_reply_match_candidate_rank_idx
  ON backlink_reply_match_candidates (inbound_message_id, candidate_rank);

ALTER TABLE backlink_mail_sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_sync_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_raw_message_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_raw_message_references FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_mail_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_inbound_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_reply_match_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_reply_match_candidates FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_mail_sync_cursor_tenant_policy
  ON backlink_mail_sync_cursors
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
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
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_mail_raw_message_reference_tenant_policy
  ON backlink_mail_raw_message_references
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
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
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_mail_thread_tenant_policy
  ON backlink_mail_threads
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
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
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_mail_message_tenant_policy
  ON backlink_mail_messages
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
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
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_inbound_message_tenant_policy
  ON backlink_inbound_messages
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
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
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_reply_match_candidate_tenant_policy
  ON backlink_reply_match_candidates
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
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
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

REVOKE ALL ON backlink_mail_sync_cursors FROM PUBLIC;
REVOKE ALL ON backlink_mail_raw_message_references FROM PUBLIC;
REVOKE ALL ON backlink_mail_threads FROM PUBLIC;
REVOKE ALL ON backlink_mail_messages FROM PUBLIC;
REVOKE ALL ON backlink_inbound_messages FROM PUBLIC;
REVOKE ALL ON backlink_reply_match_candidates FROM PUBLIC;
REVOKE DELETE ON backlink_mail_sync_cursors,
  backlink_mail_raw_message_references, backlink_mail_threads,
  backlink_mail_messages, backlink_inbound_messages,
  backlink_reply_match_candidates
  FROM growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE
  ON backlink_mail_sync_cursors, backlink_mail_raw_message_references,
    backlink_mail_threads, backlink_mail_messages, backlink_inbound_messages,
    backlink_reply_match_candidates
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_mail_sync_cursors, backlink_mail_raw_message_references,
    backlink_mail_threads, backlink_mail_messages, backlink_inbound_messages,
    backlink_reply_match_candidates
  TO growthos_reporting_reader;

COMMIT;
