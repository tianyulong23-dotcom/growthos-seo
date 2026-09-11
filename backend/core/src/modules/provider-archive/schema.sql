CREATE TABLE IF NOT EXISTS provider_archive_events (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment_id text NOT NULL,
  event_id uuid NOT NULL,
  event_digest text NOT NULL,
  received_at timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  endpoint text NOT NULL,
  event_payload jsonb NOT NULL,
  UNIQUE (deployment_id, event_id)
);
CREATE INDEX IF NOT EXISTS provider_archive_history
  ON provider_archive_events (deployment_id, sequence_id);

CREATE OR REPLACE FUNCTION provider_archive_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ARCHIVE_HISTORY_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS provider_archive_immutable ON provider_archive_events;
CREATE TRIGGER provider_archive_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON provider_archive_events
  FOR EACH STATEMENT EXECUTE FUNCTION provider_archive_deny_mutation();
