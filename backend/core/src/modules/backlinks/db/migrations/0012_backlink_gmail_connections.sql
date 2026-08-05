BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_secret_references (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  provider text NOT NULL,
  secret_kind text NOT NULL,
  external_secret_id text NOT NULL,
  external_secret_version text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_secret_reference_values_check CHECK (
    length(btrim(provider)) > 0
    AND length(btrim(external_secret_id)) > 0
    AND length(btrim(external_secret_version)) > 0
    AND version > 0
  ),
  CONSTRAINT backlink_secret_reference_kind_check CHECK (
    secret_kind IN ('OAUTH_PKCE_VERIFIER', 'GMAIL_TOKEN_SET')
  ),
  CONSTRAINT backlink_secret_reference_status_check CHECK (
    status IN ('ACTIVE', 'RETIRED', 'DESTROYED')
  ),
  CONSTRAINT backlink_secret_reference_tenant_identity_uq UNIQUE (
    organization_id, id, secret_kind
  ),
  CONSTRAINT backlink_secret_reference_external_uq UNIQUE (
    organization_id, provider, external_secret_id, external_secret_version
  )
);

CREATE TABLE backlink_oauth_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  initiated_by_user_id text NOT NULL,
  state_hash text NOT NULL,
  session_binding_hash text NOT NULL,
  pkce_verifier_secret_reference_id uuid NOT NULL,
  pkce_verifier_secret_kind text NOT NULL DEFAULT 'OAUTH_PKCE_VERIFIER',
  requested_scopes jsonb NOT NULL,
  redirect_uri text NOT NULL,
  return_path text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_oauth_attempt_identity_check CHECK (
    length(btrim(initiated_by_user_id)) > 0
    AND state_hash ~ '^[a-f0-9]{64}$'
    AND session_binding_hash ~ '^[a-f0-9]{64}$'
    AND pkce_verifier_secret_kind = 'OAUTH_PKCE_VERIFIER'
    AND version > 0
  ),
  CONSTRAINT backlink_oauth_attempt_scopes_check CHECK (
    jsonb_typeof(requested_scopes) = 'array'
    AND jsonb_array_length(requested_scopes) = 4
    AND requested_scopes @> '[
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send"
    ]'::jsonb
  ),
  CONSTRAINT backlink_oauth_attempt_redirect_check CHECK (
    length(btrim(redirect_uri)) > 0
    AND (
      return_path IS NULL
      OR (
        left(return_path, 1) = '/'
        AND left(return_path, 2) <> '//'
      )
    )
  ),
  CONSTRAINT backlink_oauth_attempt_expiry_check CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '10 minutes'
    AND (
      consumed_at IS NULL
      OR (
        consumed_at >= created_at
        AND consumed_at <= expires_at
      )
    )
  ),
  CONSTRAINT backlink_oauth_attempt_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_oauth_attempt_state_hash_uq UNIQUE (state_hash),
  CONSTRAINT backlink_oauth_attempt_pkce_secret_fk FOREIGN KEY (
    organization_id, pkce_verifier_secret_reference_id,
    pkce_verifier_secret_kind
  ) REFERENCES backlink_secret_references (
    organization_id, id, secret_kind
  )
);

CREATE TABLE backlink_gmail_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connected_by_user_id text NOT NULL,
  google_subject text NOT NULL,
  primary_email text NOT NULL,
  display_name text,
  hosted_domain text,
  granted_scopes jsonb NOT NULL,
  token_secret_reference_id uuid,
  token_secret_kind text DEFAULT 'GMAIL_TOKEN_SET',
  token_expires_at timestamptz NOT NULL,
  connection_status text NOT NULL DEFAULT 'CONNECTED',
  reauth_reason text,
  send_availability text NOT NULL DEFAULT 'AVAILABLE',
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  last_api_error_code text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_gmail_connection_identity_check CHECK (
    length(btrim(connected_by_user_id)) > 0
    AND length(btrim(google_subject)) > 0
    AND primary_email = lower(btrim(primary_email))
    AND position('@' IN primary_email) > 1
    AND (
      (
        token_secret_reference_id IS NOT NULL
        AND token_secret_kind = 'GMAIL_TOKEN_SET'
      )
      OR (
        token_secret_reference_id IS NULL
        AND token_secret_kind IS NULL
      )
    )
    AND version > 0
  ),
  CONSTRAINT backlink_gmail_connection_scopes_check CHECK (
    jsonb_typeof(granted_scopes) = 'array'
    AND jsonb_array_length(granted_scopes) = 4
    AND granted_scopes @> '[
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send"
    ]'::jsonb
  ),
  CONSTRAINT backlink_gmail_connection_status_check CHECK (
    connection_status IN (
      'CONNECTED', 'REAUTH_REQUIRED', 'TOKEN_REVOKED', 'DISCONNECTED'
    )
    AND send_availability IN ('AVAILABLE', 'PAUSED')
  ),
  CONSTRAINT backlink_gmail_connection_status_detail_check CHECK (
    (
      connection_status = 'CONNECTED'
      AND send_availability = 'AVAILABLE'
      AND token_secret_reference_id IS NOT NULL
      AND reauth_reason IS NULL
      AND disconnected_at IS NULL
    )
    OR (
      connection_status = 'REAUTH_REQUIRED'
      AND send_availability = 'PAUSED'
      AND token_secret_reference_id IS NOT NULL
      AND length(btrim(reauth_reason)) > 0
      AND disconnected_at IS NULL
    )
    OR (
      connection_status = 'TOKEN_REVOKED'
      AND send_availability = 'PAUSED'
      AND token_secret_reference_id IS NOT NULL
      AND length(btrim(reauth_reason)) > 0
      AND disconnected_at IS NULL
    )
    OR (
      connection_status = 'DISCONNECTED'
      AND send_availability = 'PAUSED'
      AND token_secret_reference_id IS NULL
      AND token_secret_kind IS NULL
      AND reauth_reason IS NULL
      AND disconnected_at IS NOT NULL
      AND disconnected_at >= connected_at
    )
  ),
  CONSTRAINT backlink_gmail_connection_tenant_identity_uq UNIQUE (
    organization_id, id
  ),
  CONSTRAINT backlink_gmail_connection_token_secret_fk FOREIGN KEY (
    organization_id, token_secret_reference_id, token_secret_kind
  ) REFERENCES backlink_secret_references (
    organization_id, id, secret_kind
  )
);

CREATE UNIQUE INDEX backlink_gmail_connection_active_subject_uq
  ON backlink_gmail_connections (organization_id, google_subject)
  WHERE disconnected_at IS NULL;

CREATE TABLE backlink_gmail_workspace_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  binding_status text NOT NULL DEFAULT 'ACTIVE',
  is_primary boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_gmail_workspace_binding_values_check CHECK (
    binding_status IN ('ACTIVE', 'INACTIVE')
    AND version > 0
  ),
  CONSTRAINT backlink_gmail_workspace_binding_identity_uq UNIQUE (
    organization_id, workspace_id, gmail_connection_id
  ),
  CONSTRAINT backlink_gmail_workspace_binding_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE UNIQUE INDEX backlink_gmail_workspace_primary_active_uq
  ON backlink_gmail_workspace_bindings (organization_id, workspace_id)
  WHERE binding_status = 'ACTIVE' AND is_primary = true;

CREATE TABLE backlink_gmail_send_identities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  normalized_email text NOT NULL,
  display_name text,
  is_primary boolean NOT NULL,
  is_default boolean NOT NULL,
  verification_status text NOT NULL,
  treat_as_alias boolean NOT NULL,
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_gmail_send_identity_values_check CHECK (
    normalized_email = lower(btrim(normalized_email))
    AND position('@' IN normalized_email) > 1
    AND verification_status IN ('accepted', 'pending')
    AND source IN ('OIDC_PRIMARY', 'GMAIL_SEND_AS')
    AND version > 0
  ),
  CONSTRAINT backlink_gmail_oidc_primary_identity_check CHECK (
    source <> 'OIDC_PRIMARY'
    OR (
      is_primary = true
      AND is_default = true
      AND verification_status = 'accepted'
      AND treat_as_alias = false
    )
  ),
  CONSTRAINT backlink_gmail_send_identity_email_uq UNIQUE (
    organization_id, gmail_connection_id, normalized_email
  ),
  CONSTRAINT backlink_gmail_send_identity_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE TABLE backlink_gmail_connection_revocations (
  gmail_connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  token_secret_reference_id uuid NOT NULL,
  token_secret_kind text NOT NULL DEFAULT 'GMAIL_TOKEN_SET',
  google_revoked boolean NOT NULL DEFAULT false,
  failure_code text,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_gmail_revocation_values_check CHECK (
    token_secret_kind = 'GMAIL_TOKEN_SET'
    AND attempt_count >= 0
    AND (
      failure_code IS NULL
      OR failure_code IN (
        'GOOGLE_REVOKE_UNCONFIRMED',
        'LOCAL_SECRET_DELETE_UNCONFIRMED'
      )
    )
  ),
  CONSTRAINT backlink_gmail_revocation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, gmail_connection_id
  ),
  CONSTRAINT backlink_gmail_revocation_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id),
  CONSTRAINT backlink_gmail_revocation_token_secret_fk FOREIGN KEY (
    organization_id, token_secret_reference_id, token_secret_kind
  ) REFERENCES backlink_secret_references (
    organization_id, id, secret_kind
  )
);

CREATE FUNCTION backlink_guard_oauth_attempt_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF (
    NEW.id,
    NEW.organization_id,
    NEW.workspace_id,
    NEW.website_project_id,
    NEW.initiated_by_user_id,
    NEW.state_hash,
    NEW.session_binding_hash,
    NEW.pkce_verifier_secret_reference_id,
    NEW.pkce_verifier_secret_kind,
    NEW.requested_scopes,
    NEW.redirect_uri,
    NEW.return_path,
    NEW.expires_at,
    NEW.created_at,
    NEW.created_by
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.organization_id,
    OLD.workspace_id,
    OLD.website_project_id,
    OLD.initiated_by_user_id,
    OLD.state_hash,
    OLD.session_binding_hash,
    OLD.pkce_verifier_secret_reference_id,
    OLD.pkce_verifier_secret_kind,
    OLD.requested_scopes,
    OLD.redirect_uri,
    OLD.return_path,
    OLD.expires_at,
    OLD.created_at,
    OLD.created_by
  ) THEN
    RAISE EXCEPTION 'OAuth attempt identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.consumed_at IS NOT NULL
    AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'OAuth attempt is already consumed'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_oauth_attempt_update_guard
BEFORE UPDATE ON backlink_oauth_attempts
FOR EACH ROW
EXECUTE FUNCTION backlink_guard_oauth_attempt_update();

ALTER TABLE backlink_secret_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_secret_references FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_oauth_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_workspace_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_workspace_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_send_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_send_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_connection_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_gmail_connection_revocations FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_secret_reference_organization_policy
  ON backlink_secret_references
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_oauth_attempt_tenant_policy
  ON backlink_oauth_attempts
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

CREATE POLICY backlink_gmail_connection_organization_policy
  ON backlink_gmail_connections
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_gmail_workspace_binding_tenant_policy
  ON backlink_gmail_workspace_bindings
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

CREATE POLICY backlink_gmail_send_identity_organization_policy
  ON backlink_gmail_send_identities
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_gmail_revocation_tenant_policy
  ON backlink_gmail_connection_revocations
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

REVOKE ALL ON backlink_secret_references FROM PUBLIC;
REVOKE ALL ON backlink_oauth_attempts FROM PUBLIC;
REVOKE ALL ON backlink_gmail_connections FROM PUBLIC;
REVOKE ALL ON backlink_gmail_workspace_bindings FROM PUBLIC;
REVOKE ALL ON backlink_gmail_send_identities FROM PUBLIC;
REVOKE ALL ON backlink_gmail_connection_revocations FROM PUBLIC;
REVOKE ALL ON FUNCTION backlink_guard_oauth_attempt_update() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_secret_references, backlink_oauth_attempts,
    backlink_gmail_connections, backlink_gmail_workspace_bindings,
    backlink_gmail_send_identities, backlink_gmail_connection_revocations
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_secret_references, backlink_oauth_attempts,
    backlink_gmail_connections, backlink_gmail_workspace_bindings,
    backlink_gmail_send_identities, backlink_gmail_connection_revocations
  TO growthos_reporting_reader;

COMMIT;
