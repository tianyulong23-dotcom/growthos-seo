BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_contact_candidates
  ADD COLUMN observed_role text,
  ADD COLUMN inferred_purpose text NOT NULL DEFAULT 'unknown',
  ADD COLUMN purpose_confidence integer NOT NULL DEFAULT 0,
  ADD COLUMN purpose_rule_version text NOT NULL
    DEFAULT 'contact-purpose-rules.v1',
  ADD COLUMN purpose_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE backlink_contacts
  ADD COLUMN observed_role text,
  ADD COLUMN inferred_purpose text NOT NULL DEFAULT 'unknown',
  ADD COLUMN purpose_confidence integer NOT NULL DEFAULT 0,
  ADD COLUMN purpose_rule_version text NOT NULL
    DEFAULT 'contact-purpose-rules.v1',
  ADD COLUMN purpose_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE backlink_contacts NO FORCE ROW LEVEL SECURITY;

UPDATE backlink_contacts
SET observed_role = NULLIF(lower(btrim(contact_role)), ''),
  inferred_purpose = CASE lower(btrim(contact_role))
    WHEN 'press' THEN 'press'
    WHEN 'editorial' THEN 'editorial'
    WHEN 'partnerships' THEN 'partnerships'
    WHEN 'advertising' THEN 'advertising'
    WHEN 'support' THEN 'support'
    WHEN 'general' THEN 'general'
    ELSE 'unknown'
  END,
  purpose_confidence = CASE
    WHEN lower(btrim(contact_role)) IN (
      'press', 'editorial', 'partnerships', 'advertising', 'support', 'general'
    ) THEN confidence
    ELSE 0
  END,
  purpose_rule_version = 'legacy-contact-role-backfill.v1',
  purpose_evidence = jsonb_build_array(jsonb_build_object(
    'tier', 'legacy',
    'field', 'legacy_contact_role',
    'value', contact_role,
    'matchedToken', lower(btrim(contact_role)),
    'ruleId', 'legacy.contact-role'
  ));

ALTER TABLE backlink_contacts FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_contact_candidates
  ADD CONSTRAINT backlink_contact_candidate_observed_role_check CHECK (
    observed_role IS NULL OR length(btrim(observed_role)) > 0
  ),
  ADD CONSTRAINT backlink_contact_candidate_purpose_check CHECK (
    inferred_purpose IN (
      'press', 'editorial', 'partnerships', 'advertising',
      'support', 'general', 'unknown'
    )
  ),
  ADD CONSTRAINT backlink_contact_candidate_purpose_confidence_check
    CHECK (purpose_confidence >= 0 AND purpose_confidence <= 100),
  ADD CONSTRAINT backlink_contact_candidate_purpose_rule_check
    CHECK (length(btrim(purpose_rule_version)) > 0),
  ADD CONSTRAINT backlink_contact_candidate_purpose_evidence_check
    CHECK (jsonb_typeof(purpose_evidence) = 'array');

ALTER TABLE backlink_contacts
  ADD CONSTRAINT backlink_contact_observed_role_check CHECK (
    observed_role IS NULL OR length(btrim(observed_role)) > 0
  ),
  ADD CONSTRAINT backlink_contact_purpose_check CHECK (
    inferred_purpose IN (
      'press', 'editorial', 'partnerships', 'advertising',
      'support', 'general', 'unknown'
    )
  ),
  ADD CONSTRAINT backlink_contact_purpose_confidence_check
    CHECK (purpose_confidence >= 0 AND purpose_confidence <= 100),
  ADD CONSTRAINT backlink_contact_purpose_rule_check
    CHECK (length(btrim(purpose_rule_version)) > 0),
  ADD CONSTRAINT backlink_contact_purpose_evidence_check
    CHECK (jsonb_typeof(purpose_evidence) = 'array');

COMMIT;
