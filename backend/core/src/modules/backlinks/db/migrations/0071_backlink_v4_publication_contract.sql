BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_inventory
  DROP CONSTRAINT backlink_rec_inventory_fit_version_check,
  DROP CONSTRAINT backlink_rec_inventory_publication_gate_check,
  ADD CONSTRAINT backlink_rec_inventory_fit_version_check CHECK (
    (
      fit_decision = 'unassessed'
      AND fit_score_model_version IS NULL
    )
    OR (
      fit_decision <> 'unassessed'
      AND fit_score_model_version IN (
        'recommendation-commercial-fit.v3',
        'recommendation-commercial-fit.v4'
      )
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_publication_gate_check CHECK (
    publication_status <> 'PUBLISHED'
    OR (
      fit_decision = 'eligible'
      AND fit_score_model_version IN (
        'recommendation-commercial-fit.v3',
        'recommendation-commercial-fit.v4'
      )
    )
  );

CREATE OR REPLACE FUNCTION backlink_guard_legacy_v3_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF NEW.publication_status = 'PUBLISHED'
     AND NEW.fit_score_model_version = 'recommendation-commercial-fit.v3'
     AND (
       TG_OP = 'INSERT'
       OR OLD.publication_status IS DISTINCT FROM 'PUBLISHED'
       OR OLD.fit_score_model_version IS DISTINCT FROM
         'recommendation-commercial-fit.v3'
       OR NEW IS DISTINCT FROM OLD
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Legacy V3 recommendation publications are read-only during V4 recalculation.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS backlink_rec_inventory_legacy_v3_publication_guard
ON backlink_recommendation_inventory;

CREATE TRIGGER backlink_rec_inventory_legacy_v3_publication_guard
BEFORE INSERT OR UPDATE ON backlink_recommendation_inventory
FOR EACH ROW EXECUTE FUNCTION backlink_guard_legacy_v3_publication();

COMMIT;
