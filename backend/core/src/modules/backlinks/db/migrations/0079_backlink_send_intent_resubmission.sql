BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_send_intents
  DROP CONSTRAINT IF EXISTS backlink_send_intent_logical_message_uq;

DROP INDEX IF EXISTS backlink_send_intent_logical_message_uq;

CREATE UNIQUE INDEX backlink_send_intent_active_logical_message_uq
  ON backlink_send_intents (
    workspace_id,
    website_project_id,
    logical_message_key
  )
  WHERE status <> 'FAILED_FINAL';

COMMIT;
