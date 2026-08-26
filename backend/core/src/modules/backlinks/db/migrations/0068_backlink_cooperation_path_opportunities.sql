BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_cooperation_path_facts
  ADD CONSTRAINT backlink_rec_cooperation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_opportunities
  ADD COLUMN engagement_channel text NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN source_cooperation_path_fact_id uuid,
  DROP CONSTRAINT backlink_opportunity_contact_gate_check,
  ADD CONSTRAINT backlink_opportunity_engagement_channel_check CHECK (
    engagement_channel IN ('EMAIL', 'COOPERATION_PATH')
  ),
  ADD CONSTRAINT backlink_opportunity_source_gate_check CHECK (
    (
      engagement_channel = 'EMAIL'
      AND source_cooperation_path_fact_id IS NULL
      AND (
        source_contact_candidate_id IS NOT NULL
        OR contact_review_required
      )
    )
    OR
    (
      engagement_channel = 'COOPERATION_PATH'
      AND source_contact_candidate_id IS NULL
      AND contact_review_required = false
      AND source_cooperation_path_fact_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT backlink_opportunity_source_cooperation_path_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id,
      source_cooperation_path_fact_id
    ) REFERENCES backlink_recommendation_cooperation_path_facts (
      organization_id, workspace_id, website_project_id, id
    ) ON DELETE RESTRICT;

CREATE INDEX backlink_opportunity_source_cooperation_path_idx
  ON backlink_opportunities (
    organization_id, workspace_id, website_project_id,
    source_cooperation_path_fact_id
  )
  WHERE source_cooperation_path_fact_id IS NOT NULL;

CREATE TABLE backlink_opportunity_manual_actions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  cooperation_path_fact_id uuid NOT NULL,
  path_type text NOT NULL,
  path_url text NOT NULL,
  content_type text NOT NULL,
  editable_content text NOT NULL,
  state text NOT NULL DEFAULT 'READY_FOR_MANUAL_ACTION',
  next_action text NOT NULL,
  evidence jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_opportunity_manual_action_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_opportunity_manual_action_opportunity_uq UNIQUE (
    opportunity_id
  ),
  CONSTRAINT backlink_opportunity_manual_action_values_ck CHECK (
    path_type IN (
      'contact_form', 'guest_post_submission',
      'resource_submission', 'editor_author_page'
    )
    AND path_url ~ '^https?://[^[:space:]]+$'
    AND path_url !~ '^https?://[^/]*@'
    AND content_type IN ('FORM_MESSAGE', 'SUBMISSION_PITCH')
    AND length(btrim(editable_content)) > 0
    AND state IN (
      'READY_FOR_MANUAL_ACTION', 'IN_PROGRESS', 'SUBMITTED',
      'RESPONSE_RECEIVED', 'BLOCKED', 'ABANDONED'
    )
    AND length(btrim(next_action)) > 0
    AND jsonb_typeof(evidence) = 'object'
    AND version > 0
  ),
  CONSTRAINT backlink_opportunity_manual_action_parent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_opportunity_manual_action_path_fact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    cooperation_path_fact_id
  ) REFERENCES backlink_recommendation_cooperation_path_facts (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_opportunity_manual_action_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  manual_action_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL,
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  path_url text NOT NULL,
  evidence jsonb NOT NULL,
  next_action text NOT NULL,
  idempotency_key text NOT NULL,
  CONSTRAINT backlink_opportunity_manual_event_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_opportunity_manual_event_idempotency_uq UNIQUE (
    manual_action_id, idempotency_key
  ),
  CONSTRAINT backlink_opportunity_manual_event_values_ck CHECK (
    (
      from_state IS NULL OR from_state IN (
        'READY_FOR_MANUAL_ACTION', 'IN_PROGRESS', 'SUBMITTED',
        'RESPONSE_RECEIVED', 'BLOCKED', 'ABANDONED'
      )
    )
    AND to_state IN (
      'READY_FOR_MANUAL_ACTION', 'IN_PROGRESS', 'SUBMITTED',
      'RESPONSE_RECEIVED', 'BLOCKED', 'ABANDONED'
    )
    AND length(btrim(actor_id)) > 0
    AND path_url ~ '^https?://[^[:space:]]+$'
    AND path_url !~ '^https?://[^/]*@'
    AND jsonb_typeof(evidence) = 'object'
    AND length(btrim(next_action)) > 0
    AND length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT backlink_opportunity_manual_event_action_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, manual_action_id
  ) REFERENCES backlink_opportunity_manual_actions (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_opportunity_manual_event_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE FUNCTION backlink_reject_manual_action_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'BACKLINK_MANUAL_ACTION_EVENT_IMMUTABLE';
END;
$function$;

CREATE TRIGGER backlink_opportunity_manual_action_events_immutable
  BEFORE UPDATE OR DELETE ON backlink_opportunity_manual_action_events
  FOR EACH ROW EXECUTE FUNCTION backlink_reject_manual_action_event_mutation();

ALTER TABLE backlink_opportunity_manual_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_manual_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_manual_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_opportunity_manual_action_events FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_opportunity_manual_action_tenant_policy
  ON backlink_opportunity_manual_actions
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true), ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true), ''
      )::uuid
  );

CREATE POLICY backlink_opportunity_manual_event_tenant_policy
  ON backlink_opportunity_manual_action_events
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true), ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true), ''
      )::uuid
  );

REVOKE ALL ON backlink_opportunity_manual_actions FROM PUBLIC;
REVOKE ALL ON backlink_opportunity_manual_action_events FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_opportunity_manual_action_events
  FROM growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE
  ON backlink_opportunity_manual_actions
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_opportunity_manual_action_events
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_opportunity_manual_actions,
     backlink_opportunity_manual_action_events
  TO growthos_reporting_reader;

COMMIT;
