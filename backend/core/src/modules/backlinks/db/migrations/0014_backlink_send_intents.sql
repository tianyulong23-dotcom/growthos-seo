BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_send_intents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  approved_draft_version_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  client_idempotency_key text NOT NULL,
  logical_message_key text NOT NULL,
  message_purpose text NOT NULL,
  follow_up_index integer NOT NULL DEFAULT 0,
  requested_send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'READY',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_send_intent_keys_check CHECK (
    length(btrim(client_idempotency_key)) > 0
    AND logical_message_key ~ '^[a-f0-9]{64}$'
    AND version > 0
  ),
  CONSTRAINT backlink_send_intent_purpose_check CHECK (
    (
      message_purpose IN ('INITIAL_OUTREACH', 'NEGOTIATION_REPLY')
      AND follow_up_index = 0
    )
    OR (
      message_purpose = 'FOLLOW_UP'
      AND follow_up_index BETWEEN 1 AND 2
    )
  ),
  CONSTRAINT backlink_send_intent_status_check CHECK (
    status IN (
      'PENDING_APPROVAL', 'READY', 'SCHEDULED', 'WAITING_RATE_LIMIT',
      'WAITING_MANUAL_APPROVAL', 'PAUSED', 'DISPATCHING',
      'PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'FAILED_RETRYABLE',
      'FAILED_FINAL', 'CANCELLED', 'REJECTED'
    )
  ),
  CONSTRAINT backlink_send_intent_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_intent_connection_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    gmail_connection_id
  ),
  CONSTRAINT backlink_send_intent_client_idempotency_uq UNIQUE (
    workspace_id, website_project_id, client_idempotency_key
  ),
  CONSTRAINT backlink_send_intent_logical_message_uq UNIQUE (
    workspace_id, website_project_id, logical_message_key
  ),
  CONSTRAINT backlink_send_intent_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_intent_draft_version_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    approved_draft_version_id, draft_id, opportunity_id
  ) REFERENCES backlink_draft_versions (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id
  ),
  CONSTRAINT backlink_send_intent_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE TABLE backlink_send_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  send_intent_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  fencing_token integer NOT NULL,
  rfc_message_id text NOT NULL,
  status text NOT NULL,
  provider_message_id text,
  provider_thread_id text,
  provider_error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_send_attempt_identity_check CHECK (
    attempt_no > 0
    AND fencing_token > 0
    AND rfc_message_id ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$'
  ),
  CONSTRAINT backlink_send_attempt_status_check CHECK (
    status IN (
      'DISPATCHING', 'PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN',
      'FAILED_RETRYABLE', 'FAILED_FINAL'
    )
  ),
  CONSTRAINT backlink_send_attempt_result_check CHECK (
    (
      status = 'DISPATCHING'
      AND completed_at IS NULL
      AND provider_message_id IS NULL
      AND provider_thread_id IS NULL
      AND provider_error_code IS NULL
    )
    OR (
      status = 'PROVIDER_ACCEPTED'
      AND completed_at >= started_at
      AND length(btrim(provider_message_id)) > 0
      AND provider_error_code IS NULL
    )
    OR (
      status = 'DELIVERY_UNKNOWN'
      AND completed_at >= started_at
      AND length(btrim(provider_error_code)) > 0
    )
    OR (
      status IN ('FAILED_RETRYABLE', 'FAILED_FINAL')
      AND completed_at >= started_at
      AND provider_message_id IS NULL
      AND provider_thread_id IS NULL
      AND length(btrim(provider_error_code)) > 0
    )
  ),
  CONSTRAINT backlink_send_attempt_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_send_attempt_number_uq UNIQUE (
    send_intent_id, attempt_no
  ),
  CONSTRAINT backlink_send_attempt_rfc_message_id_uq UNIQUE (rfc_message_id),
  CONSTRAINT backlink_send_attempt_intent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, send_intent_id
  ) REFERENCES backlink_send_intents (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_rate_limit_reservations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  send_intent_id uuid NOT NULL,
  gmail_connection_id uuid NOT NULL,
  reservation_key text NOT NULL,
  lane_sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'RESERVED',
  reserved_at timestamptz NOT NULL,
  eligible_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_rate_limit_reservation_values_check CHECK (
    reservation_key ~ '^[a-f0-9]{64}$'
    AND lane_sequence > 0
    AND version > 0
    AND eligible_at >= reserved_at
    AND expires_at > eligible_at
  ),
  CONSTRAINT backlink_rate_limit_reservation_status_check CHECK (
    status IN ('RESERVED', 'CONSUMED', 'RELEASED')
  ),
  CONSTRAINT backlink_rate_limit_reservation_state_check CHECK (
    (
      status = 'RESERVED'
      AND consumed_at IS NULL
      AND released_at IS NULL
      AND release_reason IS NULL
    )
    OR (
      status = 'CONSUMED'
      AND consumed_at IS NOT NULL
      AND consumed_at >= eligible_at
      AND consumed_at <= expires_at
      AND released_at IS NULL
      AND release_reason IS NULL
    )
    OR (
      status = 'RELEASED'
      AND consumed_at IS NULL
      AND released_at IS NOT NULL
      AND released_at >= reserved_at
      AND release_reason IS NOT NULL
      AND length(btrim(release_reason)) > 0
    )
  ),
  CONSTRAINT backlink_rate_limit_reservation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_rate_limit_reservation_intent_uq UNIQUE (
    send_intent_id
  ),
  CONSTRAINT backlink_rate_limit_reservation_key_uq UNIQUE (
    organization_id, gmail_connection_id, reservation_key
  ),
  CONSTRAINT backlink_rate_limit_reservation_lane_uq UNIQUE (
    organization_id, gmail_connection_id, lane_sequence
  ),
  CONSTRAINT backlink_rate_limit_reservation_intent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, send_intent_id,
    gmail_connection_id
  ) REFERENCES backlink_send_intents (
    organization_id, workspace_id, website_project_id, id,
    gmail_connection_id
  ),
  CONSTRAINT backlink_rate_limit_reservation_connection_fk FOREIGN KEY (
    organization_id, gmail_connection_id
  ) REFERENCES backlink_gmail_connections (organization_id, id)
);

CREATE TABLE backlink_suppression_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid,
  website_project_id uuid,
  scope_type text NOT NULL,
  target_type text NOT NULL,
  target_hmac text NOT NULL,
  hash_key_version integer NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  released_at timestamptz,
  release_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_suppression_scope_check CHECK (
    (
      scope_type = 'ORGANIZATION'
      AND workspace_id IS NULL
      AND website_project_id IS NULL
    )
    OR (
      scope_type = 'WEBSITE_PROJECT'
      AND workspace_id IS NOT NULL
      AND website_project_id IS NOT NULL
    )
  ),
  CONSTRAINT backlink_suppression_target_check CHECK (
    target_type IN ('EMAIL', 'DOMAIN', 'CONTACT')
    AND target_hmac ~ '^[a-f0-9]{64}$'
    AND hash_key_version > 0
  ),
  CONSTRAINT backlink_suppression_reason_check CHECK (
    reason IN (
      'REJECTION', 'UNSUBSCRIBE', 'COMPLAINT', 'LEGAL', 'SECURITY',
      'HARD_BOUNCE', 'MANUAL'
    )
  ),
  CONSTRAINT backlink_suppression_state_check CHECK (
    version > 0
    AND (
      (
        status = 'ACTIVE'
        AND released_at IS NULL
        AND release_reason IS NULL
      )
      OR (
        status = 'RELEASED'
        AND released_at IS NOT NULL
        AND released_at >= created_at
        AND release_reason IS NOT NULL
        AND length(btrim(release_reason)) > 0
      )
    )
  ),
  CONSTRAINT backlink_suppression_entry_tenant_identity_uq UNIQUE (
    organization_id, id
  )
);

CREATE UNIQUE INDEX backlink_suppression_organization_active_uq
  ON backlink_suppression_entries (
    organization_id, target_type, target_hmac, hash_key_version
  )
  WHERE scope_type = 'ORGANIZATION' AND status = 'ACTIVE';

CREATE UNIQUE INDEX backlink_suppression_project_active_uq
  ON backlink_suppression_entries (
    organization_id, workspace_id, website_project_id, target_type,
    target_hmac, hash_key_version
  )
  WHERE scope_type = 'WEBSITE_PROJECT' AND status = 'ACTIVE';

CREATE FUNCTION backlink_reject_send_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Send Attempt rows are append-only'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_send_attempt_immutable
BEFORE UPDATE OR DELETE ON backlink_send_attempts
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_send_attempt_mutation();

CREATE FUNCTION backlink_guard_rate_limit_reservation_update()
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
    NEW.send_intent_id,
    NEW.gmail_connection_id,
    NEW.reservation_key,
    NEW.lane_sequence,
    NEW.reserved_at,
    NEW.eligible_at,
    NEW.expires_at,
    NEW.created_at,
    NEW.created_by
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.organization_id,
    OLD.workspace_id,
    OLD.website_project_id,
    OLD.send_intent_id,
    OLD.gmail_connection_id,
    OLD.reservation_key,
    OLD.lane_sequence,
    OLD.reserved_at,
    OLD.eligible_at,
    OLD.expires_at,
    OLD.created_at,
    OLD.created_by
  ) THEN
    RAISE EXCEPTION 'Rate limit reservation identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'RESERVED'
    OR NEW.status NOT IN ('CONSUMED', 'RELEASED') THEN
    RAISE EXCEPTION 'Rate limit reservation transition is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Rate limit reservation version must advance once'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_rate_limit_reservation_update_guard
BEFORE UPDATE ON backlink_rate_limit_reservations
FOR EACH ROW
EXECUTE FUNCTION backlink_guard_rate_limit_reservation_update();

CREATE FUNCTION backlink_guard_suppression_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Suppression entries cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF (
    NEW.id,
    NEW.organization_id,
    NEW.workspace_id,
    NEW.website_project_id,
    NEW.scope_type,
    NEW.target_type,
    NEW.target_hmac,
    NEW.hash_key_version,
    NEW.reason,
    NEW.created_at,
    NEW.created_by
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.organization_id,
    OLD.workspace_id,
    OLD.website_project_id,
    OLD.scope_type,
    OLD.target_type,
    OLD.target_hmac,
    OLD.hash_key_version,
    OLD.reason,
    OLD.created_at,
    OLD.created_by
  ) THEN
    RAISE EXCEPTION 'Suppression identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED' THEN
    RAISE EXCEPTION 'Suppression release is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Suppression version must advance once'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_suppression_mutation_guard
BEFORE UPDATE OR DELETE ON backlink_suppression_entries
FOR EACH ROW
EXECUTE FUNCTION backlink_guard_suppression_mutation();

ALTER TABLE backlink_send_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_send_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_send_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_send_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_rate_limit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_rate_limit_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_suppression_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_suppression_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_send_intent_tenant_policy
  ON backlink_send_intents
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

CREATE POLICY backlink_send_attempt_tenant_policy
  ON backlink_send_attempts
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

CREATE POLICY backlink_rate_limit_reservation_tenant_policy
  ON backlink_rate_limit_reservations
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

CREATE POLICY backlink_suppression_tenant_policy
  ON backlink_suppression_entries
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND (
      scope_type = 'ORGANIZATION'
      OR (
        workspace_id =
          NULLIF(
            current_setting('app.current_workspace_id', true),
            ''
          )::uuid
        AND website_project_id =
          NULLIF(
            current_setting('app.current_website_project_id', true),
            ''
          )::uuid
      )
    )
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND (
      scope_type = 'ORGANIZATION'
      OR (
        workspace_id =
          NULLIF(
            current_setting('app.current_workspace_id', true),
            ''
          )::uuid
        AND website_project_id =
          NULLIF(
            current_setting('app.current_website_project_id', true),
            ''
          )::uuid
      )
    )
  );

REVOKE ALL ON backlink_send_intents FROM PUBLIC;
REVOKE ALL ON backlink_send_attempts FROM PUBLIC;
REVOKE ALL ON backlink_rate_limit_reservations FROM PUBLIC;
REVOKE ALL ON backlink_suppression_entries FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_send_attempt_mutation()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_guard_rate_limit_reservation_update()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_guard_suppression_mutation()
  FROM PUBLIC;
REVOKE DELETE
  ON backlink_send_intents, backlink_rate_limit_reservations,
    backlink_suppression_entries
  FROM growthos_backlinks_writer;
REVOKE UPDATE, DELETE
  ON backlink_send_attempts
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT, UPDATE
  ON backlink_send_intents, backlink_rate_limit_reservations,
    backlink_suppression_entries
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_send_attempts
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_send_intents, backlink_send_attempts,
    backlink_rate_limit_reservations, backlink_suppression_entries
  TO growthos_reporting_reader;

COMMIT;
