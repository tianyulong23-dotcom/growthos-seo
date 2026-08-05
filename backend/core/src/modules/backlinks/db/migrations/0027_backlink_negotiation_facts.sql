BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_reply_classification_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  classification_version integer NOT NULL,
  classification_code text NOT NULL,
  classifier_type text NOT NULL,
  classifier_version text NOT NULL,
  confidence_score numeric(5, 4) NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  classified_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_reply_classification_values_check CHECK (
    classification_version > 0
    AND length(btrim(classification_code)) > 0
    AND classifier_type IN ('RULE', 'AI', 'MANUAL')
    AND length(btrim(classifier_version)) > 0
    AND confidence_score >= 0
    AND confidence_score <= 1
    AND jsonb_typeof(evidence) = 'array'
    AND schema_version > 0
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_reply_classification_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_reply_classification_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    inbound_message_id, classification_version
  ),
  CONSTRAINT backlink_reply_classification_inbound_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inbound_message_id
  ) REFERENCES backlink_inbound_messages (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_negotiation_fact_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  inbound_message_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  fact_key text NOT NULL,
  fact_version integer NOT NULL,
  fact_type text NOT NULL,
  raw_value text NOT NULL,
  normalized_value jsonb NOT NULL,
  fact_authority text NOT NULL,
  review_status text NOT NULL,
  extractor_type text NOT NULL,
  extractor_version text NOT NULL,
  confidence_score numeric(5, 4) NOT NULL,
  evidence_text text NOT NULL,
  evidence_start integer NOT NULL,
  evidence_end integer NOT NULL,
  supersedes_fact_version_id uuid,
  decided_by text,
  decided_at timestamptz,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_negotiation_fact_values_check CHECK (
    length(btrim(fact_key)) > 0
    AND fact_version > 0
    AND length(btrim(fact_type)) > 0
    AND length(btrim(raw_value)) > 0
    AND fact_authority IN ('INFERRED', 'MANUAL')
    AND review_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED')
    AND extractor_type IN ('RULE', 'AI', 'MANUAL')
    AND length(btrim(extractor_version)) > 0
    AND confidence_score >= 0
    AND confidence_score <= 1
    AND length(evidence_text) > 0
    AND evidence_start >= 0
    AND evidence_end > evidence_start
    AND evidence_end <= length(evidence_text)
    AND schema_version > 0
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_negotiation_fact_authority_check CHECK (
    (
      fact_authority = 'INFERRED'
      AND review_status = 'PENDING'
      AND extractor_type IN ('RULE', 'AI')
      AND supersedes_fact_version_id IS NULL
      AND decided_by IS NULL
      AND decided_at IS NULL
    )
    OR (
      fact_authority = 'MANUAL'
      AND review_status IN ('CONFIRMED', 'REJECTED')
      AND extractor_type = 'MANUAL'
      AND supersedes_fact_version_id IS NULL
      AND length(btrim(decided_by)) > 0
      AND decided_at IS NOT NULL
    )
    OR (
      fact_authority = 'MANUAL'
      AND review_status = 'SUPERSEDED'
      AND extractor_type = 'MANUAL'
      AND supersedes_fact_version_id IS NOT NULL
      AND length(btrim(decided_by)) > 0
      AND decided_at IS NOT NULL
    )
  ),
  CONSTRAINT backlink_negotiation_fact_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_negotiation_fact_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    opportunity_id, fact_key, fact_version
  ),
  CONSTRAINT backlink_negotiation_fact_inbound_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inbound_message_id
  ) REFERENCES backlink_inbound_messages (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_negotiation_fact_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_negotiation_fact_supersedes_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    supersedes_fact_version_id
  ) REFERENCES backlink_negotiation_fact_versions (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX backlink_reply_classification_latest_idx
  ON backlink_reply_classification_versions (
    organization_id, workspace_id, website_project_id,
    inbound_message_id, classification_version DESC
  );

CREATE INDEX backlink_negotiation_fact_latest_idx
  ON backlink_negotiation_fact_versions (
    organization_id, workspace_id, website_project_id,
    opportunity_id, fact_key, fact_version DESC
  );

CREATE FUNCTION backlink_reject_reply_analysis_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Reply analysis version rows are append-only'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_reply_classification_version_immutable
BEFORE UPDATE OR DELETE ON backlink_reply_classification_versions
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_reply_analysis_version_mutation();

CREATE TRIGGER backlink_negotiation_fact_version_immutable
BEFORE UPDATE OR DELETE ON backlink_negotiation_fact_versions
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_reply_analysis_version_mutation();

ALTER TABLE backlink_reply_classification_versions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_reply_classification_versions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_negotiation_fact_versions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_negotiation_fact_versions
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_reply_classification_tenant_policy
  ON backlink_reply_classification_versions
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

CREATE POLICY backlink_negotiation_fact_tenant_policy
  ON backlink_negotiation_fact_versions
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

REVOKE ALL ON backlink_reply_classification_versions FROM PUBLIC;
REVOKE ALL ON backlink_negotiation_fact_versions FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_reply_analysis_version_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_reply_classification_versions,
    backlink_negotiation_fact_versions
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_reply_classification_versions,
    backlink_negotiation_fact_versions
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_reply_classification_versions,
    backlink_negotiation_fact_versions
  TO growthos_reporting_reader;

COMMIT;
