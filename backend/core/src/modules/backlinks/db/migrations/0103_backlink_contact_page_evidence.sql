BEGIN;
SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_contact_enrichment_pages
  ADD COLUMN observed_page_url text,
  ADD COLUMN contact_page_kind text,
  ADD CONSTRAINT backlink_contact_page_evidence_pair CHECK (
    (observed_page_url IS NULL AND contact_page_kind IS NULL)
    OR (
      observed_page_url IS NOT NULL
      AND observed_page_url ~ '^https?://[^/@[:space:]]+([/?]|$)'
      AND contact_page_kind IS NOT NULL
      AND contact_page_kind IN (
        'CONTACT_FORM_ONLY', 'LOGIN_REQUIRED',
        'CAPTCHA_OR_BOT_CHALLENGE', 'ACCESS_DENIED'
      )
    )
  );

COMMENT ON COLUMN backlink_contact_enrichment_pages.observed_page_url IS
  'Actual final HTTP/browser page URL, not an inferred contact path; historical unknowns remain NULL.';
COMMENT ON COLUMN backlink_contact_enrichment_pages.contact_page_kind IS
  'Page-specific observed contact form or access barrier; scoped by the existing job FK and forced RLS.';
COMMIT;
