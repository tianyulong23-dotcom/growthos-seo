BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_send_attempts
  ADD COLUMN retry_eligible_at timestamptz;

ALTER TABLE backlink_send_attempts
  DROP CONSTRAINT backlink_send_attempt_result_check;

ALTER TABLE backlink_send_attempts
  ADD CONSTRAINT backlink_send_attempt_result_check CHECK (
    (
      status = 'DISPATCHING'
      AND completed_at IS NULL
      AND retry_eligible_at IS NULL
      AND provider_message_id IS NULL
      AND provider_thread_id IS NULL
      AND provider_error_code IS NULL
    )
    OR (
      status = 'PROVIDER_ACCEPTED'
      AND completed_at >= started_at
      AND retry_eligible_at IS NULL
      AND length(btrim(provider_message_id)) > 0
      AND provider_error_code IS NULL
    )
    OR (
      status = 'DELIVERY_UNKNOWN'
      AND completed_at >= started_at
      AND retry_eligible_at IS NULL
      AND length(btrim(provider_error_code)) > 0
    )
    OR (
      status = 'FAILED_RETRYABLE'
      AND completed_at >= started_at
      AND retry_eligible_at >= completed_at
      AND provider_message_id IS NULL
      AND provider_thread_id IS NULL
      AND length(btrim(provider_error_code)) > 0
    )
    OR (
      status = 'FAILED_FINAL'
      AND completed_at >= started_at
      AND retry_eligible_at IS NULL
      AND provider_message_id IS NULL
      AND provider_thread_id IS NULL
      AND length(btrim(provider_error_code)) > 0
    )
  );

ALTER TABLE backlink_rate_limit_reservations
  DROP CONSTRAINT backlink_rate_limit_reservation_state_check;

ALTER TABLE backlink_rate_limit_reservations
  ADD CONSTRAINT backlink_rate_limit_reservation_state_check CHECK (
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
  );

CREATE OR REPLACE FUNCTION backlink_reject_send_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Send Attempt rows cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF (
    NEW.id,
    NEW.organization_id,
    NEW.workspace_id,
    NEW.website_project_id,
    NEW.send_intent_id,
    NEW.attempt_no,
    NEW.fencing_token,
    NEW.rfc_message_id,
    NEW.started_at,
    NEW.created_at,
    NEW.created_by
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.organization_id,
    OLD.workspace_id,
    OLD.website_project_id,
    OLD.send_intent_id,
    OLD.attempt_no,
    OLD.fencing_token,
    OLD.rfc_message_id,
    OLD.started_at,
    OLD.created_at,
    OLD.created_by
  ) THEN
    RAISE EXCEPTION 'Send Attempt identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'DISPATCHING'
    OR NEW.status NOT IN (
      'PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN',
      'FAILED_RETRYABLE', 'FAILED_FINAL'
    ) THEN
    RAISE EXCEPTION 'Send Attempt settlement is terminal'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL
  ON FUNCTION backlink_reject_send_attempt_mutation()
  FROM PUBLIC;

GRANT UPDATE
  ON backlink_send_attempts
  TO growthos_backlinks_writer;

COMMIT;
