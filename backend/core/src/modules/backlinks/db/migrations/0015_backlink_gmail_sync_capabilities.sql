BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_oauth_attempts
  DROP CONSTRAINT backlink_oauth_attempt_scopes_check;

ALTER TABLE backlink_oauth_attempts
  ADD CONSTRAINT backlink_oauth_attempt_scopes_check CHECK (
    jsonb_typeof(requested_scopes) = 'array'
    AND jsonb_array_length(requested_scopes) IN (4, 5)
    AND requested_scopes @> '[
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send"
    ]'::jsonb
    AND requested_scopes <@ '[
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly"
    ]'::jsonb
    AND (
      jsonb_array_length(requested_scopes) = 4
      OR requested_scopes @> '[
        "https://www.googleapis.com/auth/gmail.readonly"
      ]'::jsonb
    )
  );

ALTER TABLE backlink_gmail_connections
  DROP CONSTRAINT backlink_gmail_connection_scopes_check;

ALTER TABLE backlink_gmail_connections
  ADD CONSTRAINT backlink_gmail_connection_scopes_check CHECK (
    jsonb_typeof(granted_scopes) = 'array'
    AND jsonb_array_length(granted_scopes) IN (4, 5)
    AND granted_scopes @> '[
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send"
    ]'::jsonb
    AND granted_scopes <@ '[
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly"
    ]'::jsonb
    AND (
      jsonb_array_length(granted_scopes) = 4
      OR granted_scopes @> '[
        "https://www.googleapis.com/auth/gmail.readonly"
      ]'::jsonb
    )
  );

ALTER TABLE backlink_gmail_connections
  ADD COLUMN mail_sync_capability boolean
  GENERATED ALWAYS AS (
    granted_scopes @> '[
      "https://www.googleapis.com/auth/gmail.readonly"
    ]'::jsonb
  ) STORED;

COMMIT;
