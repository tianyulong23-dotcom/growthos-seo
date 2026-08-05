BEGIN;

ALTER TABLE public.backlink_idempotency_records SET SCHEMA backlinks;
ALTER TABLE public.backlink_outbox_events SET SCHEMA backlinks;
ALTER TABLE public.backlink_jobs SET SCHEMA backlinks;
ALTER TABLE public.backlink_lifecycle_events SET SCHEMA backlinks;
ALTER TABLE public.backlink_audit_events SET SCHEMA backlinks;
ALTER TABLE public.backlink_project_context_snapshots SET SCHEMA backlinks;
ALTER TABLE public.backlink_provider_requests SET SCHEMA backlinks;
ALTER TABLE public.backlink_seo_snapshots SET SCHEMA backlinks;
ALTER TABLE public.backlink_provider_cache_entries SET SCHEMA backlinks;
ALTER TABLE public.backlink_provider_budgets SET SCHEMA backlinks;
ALTER TABLE public.backlink_provider_usage_ledger SET SCHEMA backlinks;
ALTER TABLE public.backlink_prospects SET SCHEMA backlinks;
ALTER TABLE public.backlink_recommendations SET SCHEMA backlinks;
ALTER TABLE public.backlink_recommendation_scores SET SCHEMA backlinks;
ALTER TABLE public.backlink_recommendation_inventory SET SCHEMA backlinks;
ALTER TABLE public.backlink_recommendation_claims SET SCHEMA backlinks;
ALTER TABLE public.backlink_recommendation_rejections SET SCHEMA backlinks;
ALTER TABLE public.backlink_recommendation_refills SET SCHEMA backlinks;
ALTER TABLE public.backlink_contact_candidates SET SCHEMA backlinks;
ALTER TABLE public.backlink_contact_evidence SET SCHEMA backlinks;
ALTER TABLE public.backlink_contacts SET SCHEMA backlinks;

ALTER FUNCTION public.backlink_reject_seo_snapshot_mutation()
  SET SCHEMA backlinks;
ALTER FUNCTION public.backlink_reserve_provider_cost(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, bigint, text
) SET SCHEMA backlinks;
ALTER FUNCTION public.backlink_reject_recommendation_score_mutation()
  SET SCHEMA backlinks;

ALTER TABLE backlinks.backlink_idempotency_records
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_outbox_events
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_jobs OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_lifecycle_events
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_audit_events
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_project_context_snapshots
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_provider_requests
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_seo_snapshots
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_provider_cache_entries
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_provider_budgets
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_provider_usage_ledger
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_prospects OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_recommendations
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_recommendation_scores
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_recommendation_inventory
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_recommendation_claims
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_recommendation_rejections
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_recommendation_refills
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_contact_candidates
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_contact_evidence
  OWNER TO growthos_backlinks_owner;
ALTER TABLE backlinks.backlink_contacts OWNER TO growthos_backlinks_owner;

ALTER FUNCTION backlinks.backlink_reject_seo_snapshot_mutation()
  OWNER TO growthos_backlinks_owner;
ALTER FUNCTION backlinks.backlink_reserve_provider_cost(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, bigint, text
) OWNER TO growthos_backlinks_owner;
ALTER FUNCTION backlinks.backlink_reject_recommendation_score_mutation()
  OWNER TO growthos_backlinks_owner;

ALTER FUNCTION backlinks.backlink_reject_seo_snapshot_mutation()
  SET search_path = backlinks, pg_catalog;
ALTER FUNCTION backlinks.backlink_reserve_provider_cost(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, bigint, text
) SET search_path = backlinks, pg_catalog;
ALTER FUNCTION backlinks.backlink_reject_recommendation_score_mutation()
  SET search_path = backlinks, pg_catalog;

REVOKE ALL ON ALL TABLES IN SCHEMA backlinks FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA backlinks FROM PUBLIC;

GRANT USAGE ON SCHEMA backlinks TO growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA backlinks
  TO growthos_backlinks_writer;
GRANT EXECUTE ON FUNCTION backlinks.backlink_reserve_provider_cost(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, bigint, text
) TO growthos_backlinks_writer;

GRANT USAGE ON SCHEMA backlinks TO growthos_reporting_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA backlinks
  TO growthos_reporting_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE growthos_backlinks_owner
  IN SCHEMA backlinks REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE growthos_backlinks_owner
  IN SCHEMA backlinks REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE growthos_backlinks_owner
  IN SCHEMA backlinks
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO growthos_backlinks_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE growthos_backlinks_owner
  IN SCHEMA backlinks
  GRANT SELECT ON TABLES TO growthos_reporting_reader;

COMMIT;
