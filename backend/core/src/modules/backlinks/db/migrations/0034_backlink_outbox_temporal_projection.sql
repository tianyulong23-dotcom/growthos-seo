BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_outbox_events
  ADD CONSTRAINT backlink_outbox_tenant_event_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_monitor_policies
  ADD COLUMN source_outbox_event_id uuid,
  ADD COLUMN workflow_id text,
  ADD CONSTRAINT backlink_monitor_policy_workflow_trace_check CHECK (
    (
      source_outbox_event_id IS NULL
      AND workflow_id IS NULL
    )
    OR (
      source_outbox_event_id IS NOT NULL
      AND length(btrim(workflow_id)) > 0
    )
  ),
  ADD CONSTRAINT backlink_monitor_policy_source_outbox_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_outbox_event_id
  ) REFERENCES backlink_outbox_events (
    organization_id, workspace_id, website_project_id, id
  );

CREATE UNIQUE INDEX backlink_monitor_policy_source_outbox_uq
  ON backlink_monitor_policies (
    organization_id, workspace_id, website_project_id,
    source_outbox_event_id
  )
  WHERE source_outbox_event_id IS NOT NULL;

CREATE POLICY backlink_outbox_internal_policy
  ON backlink_outbox_events TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);

CREATE FUNCTION backlink_claim_outbox_events(
  p_worker_id text,
  p_limit integer,
  p_event_type text,
  p_stale_claim_before timestamptz
)
RETURNS TABLE (
  event_id uuid,
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  event_type text,
  aggregate_id uuid,
  aggregate_version integer,
  idempotency_key text,
  payload jsonb,
  payload_schema_version integer,
  status text,
  available_at timestamptz,
  attempt_count integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH claimable AS (
    SELECT event.id
      FROM backlink_outbox_events AS event
     WHERE (
             (
               event.status IN ('pending', 'failed')
               AND event.available_at <= now()
             )
             OR (
               p_stale_claim_before IS NOT NULL
               AND event.status = 'processing'
               AND event.claimed_at <= p_stale_claim_before
             )
           )
       AND (p_event_type IS NULL OR event.event_type = p_event_type)
     ORDER BY event.available_at, event.created_at, event.id
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_limit, 0)
  )
  UPDATE backlink_outbox_events AS event
     SET status = 'processing',
         claimed_at = now(),
         claimed_by = p_worker_id,
         attempt_count = event.attempt_count + 1,
         updated_at = now(),
         updated_by = p_worker_id
    FROM claimable
   WHERE event.id = claimable.id
  RETURNING
    event.id,
    event.organization_id,
    event.workspace_id,
    event.website_project_id,
    event.event_type,
    event.aggregate_id,
    event.aggregate_version,
    event.idempotency_key,
    event.payload,
    event.payload_schema_version,
    event.status,
    event.available_at,
    event.attempt_count;
$function$;

CREATE FUNCTION backlink_mark_outbox_event(
  p_event_id uuid,
  p_worker_id text,
  p_outcome text,
  p_retry_at timestamptz
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH updated AS (
    UPDATE backlink_outbox_events
       SET status = p_outcome,
           available_at = CASE
             WHEN p_outcome = 'failed' THEN p_retry_at
             ELSE available_at
           END,
           claimed_at = CASE
             WHEN p_outcome = 'failed' THEN NULL
             ELSE claimed_at
           END,
           claimed_by = CASE
             WHEN p_outcome = 'failed' THEN NULL
             ELSE claimed_by
           END,
           published_at = CASE
             WHEN p_outcome = 'published' THEN now()
             ELSE NULL
           END,
           updated_at = now(),
           updated_by = p_worker_id
     WHERE id = p_event_id
       AND status = 'processing'
       AND claimed_by = p_worker_id
       AND p_outcome IN ('published', 'failed')
       AND (
         p_outcome = 'published'
         OR p_retry_at IS NOT NULL
       )
    RETURNING id
  )
  SELECT EXISTS(SELECT 1 FROM updated);
$function$;

REVOKE ALL
  ON FUNCTION backlink_claim_outbox_events(
    text, integer, text, timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_mark_outbox_event(
    uuid, text, text, timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_claim_outbox_events(
    text, integer, text, timestamptz
  )
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_mark_outbox_event(
    uuid, text, text, timestamptz
  )
  TO growthos_backlinks_writer;

COMMIT;
