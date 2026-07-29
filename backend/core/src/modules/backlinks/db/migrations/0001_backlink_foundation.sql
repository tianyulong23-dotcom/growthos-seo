CREATE TABLE backlink_idempotency_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  response_schema_version integer,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_idempotency_response_status_check
    CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  CONSTRAINT backlink_idempotency_response_schema_version_check
    CHECK (
      response_schema_version IS NULL OR response_schema_version > 0
    ),
  CONSTRAINT backlink_idempotency_workspace_key_command_uq
    UNIQUE (workspace_id, idempotency_key, command_type)
);

CREATE TABLE backlink_outbox_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  payload_schema_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_outbox_aggregate_version_check
    CHECK (aggregate_version > 0),
  CONSTRAINT backlink_outbox_payload_schema_version_check
    CHECK (payload_schema_version > 0),
  CONSTRAINT backlink_outbox_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT backlink_outbox_status_check
    CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  CONSTRAINT backlink_outbox_event_aggregate_version_uq
    UNIQUE (event_type, aggregate_id, aggregate_version),
  CONSTRAINT backlink_outbox_workspace_idempotency_uq
    UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE backlink_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  job_type text NOT NULL,
  source_object_type text NOT NULL,
  source_object_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  step text,
  progress integer NOT NULL DEFAULT 0,
  workflow_id text NOT NULL,
  correlation_id text NOT NULL,
  result_summary jsonb,
  error jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_job_status_check
    CHECK (
      status IN (
        'queued', 'running', 'waiting_provider', 'partial_success',
        'success', 'failed', 'cancelled'
      )
    ),
  CONSTRAINT backlink_job_progress_check
    CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT backlink_job_retry_count_check
    CHECK (retry_count >= 0),
  CONSTRAINT backlink_job_version_check
    CHECK (version > 0),
  CONSTRAINT backlink_job_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, website_project_id, id),
  CONSTRAINT backlink_job_workspace_workflow_uq
    UNIQUE (workspace_id, workflow_id)
);

CREATE TABLE backlink_lifecycle_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  job_id uuid,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  sequence integer NOT NULL,
  aggregate_version integer NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id text NOT NULL,
  causation_id uuid,
  idempotency_key text NOT NULL,
  event_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_lifecycle_job_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, job_id
    )
    REFERENCES backlink_jobs (
      organization_id, workspace_id, website_project_id, id
    ),
  CONSTRAINT backlink_lifecycle_sequence_check
    CHECK (sequence > 0),
  CONSTRAINT backlink_lifecycle_aggregate_version_check
    CHECK (aggregate_version > 0),
  CONSTRAINT backlink_lifecycle_event_schema_version_check
    CHECK (event_schema_version > 0),
  CONSTRAINT backlink_lifecycle_tenant_identity_uq
    UNIQUE (organization_id, workspace_id, website_project_id, id),
  CONSTRAINT backlink_lifecycle_aggregate_sequence_uq
    UNIQUE (workspace_id, aggregate_type, aggregate_id, sequence),
  CONSTRAINT backlink_lifecycle_workspace_idempotency_uq
    UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE backlink_audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  job_id uuid,
  lifecycle_event_id uuid,
  actor_id text,
  actor_kind text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  outcome text NOT NULL,
  reason text,
  before_redacted jsonb,
  after_redacted jsonb,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  previous_integrity_hash text,
  integrity_hash text NOT NULL,
  event_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_audit_job_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, job_id
    )
    REFERENCES backlink_jobs (
      organization_id, workspace_id, website_project_id, id
    ),
  CONSTRAINT backlink_audit_lifecycle_event_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id, lifecycle_event_id
    )
    REFERENCES backlink_lifecycle_events (
      organization_id, workspace_id, website_project_id, id
    ),
  CONSTRAINT backlink_audit_event_schema_version_check
    CHECK (event_schema_version > 0)
);

CREATE TABLE backlink_project_context_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  snapshot_version integer NOT NULL,
  project_status text NOT NULL,
  canonical_domain text NOT NULL,
  locale text NOT NULL,
  country_code text NOT NULL,
  profile_version_id text NOT NULL,
  promotion_target_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_project_context_snapshot_version_check
    CHECK (snapshot_version > 0),
  CONSTRAINT backlink_project_context_snapshot_status_check
    CHECK (
      project_status IN (
        'ACTIVE', 'PAUSED', 'DELETION_REQUESTED', 'DELETED'
      )
    ),
  CONSTRAINT backlink_project_context_snapshot_version_uq
    UNIQUE (
      organization_id, workspace_id, website_project_id, snapshot_version
    )
);

ALTER TABLE backlink_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_lifecycle_events FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_project_context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_project_context_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_idempotency_tenant_policy
  ON backlink_idempotency_records
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_outbox_tenant_policy
  ON backlink_outbox_events
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_job_tenant_policy
  ON backlink_jobs
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_lifecycle_tenant_policy
  ON backlink_lifecycle_events
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_audit_tenant_policy
  ON backlink_audit_events
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_project_context_snapshot_tenant_policy
  ON backlink_project_context_snapshots
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );
