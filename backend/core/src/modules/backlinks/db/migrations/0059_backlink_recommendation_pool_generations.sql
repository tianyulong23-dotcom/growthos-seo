BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_inventory_policies
  ADD COLUMN visible_pool_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN visible_pool_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN visible_pool_target_count integer NOT NULL DEFAULT 20,
  ADD COLUMN archived_visible_pool_count integer NOT NULL DEFAULT 0,
  ADD COLUMN visible_pool_archived_at timestamptz,
  ADD COLUMN visible_pool_archived_by text,
  ADD CONSTRAINT backlink_commercial_visible_pool_generation_check CHECK (
    visible_pool_generation >= 1
  ),
  ADD CONSTRAINT backlink_commercial_visible_pool_state_check CHECK (
    visible_pool_state IN (
      'idle', 'building', 'active', 'awaiting_refresh'
    )
  ),
  ADD CONSTRAINT backlink_commercial_visible_pool_target_check CHECK (
    visible_pool_target_count = 20
    AND archived_visible_pool_count >= 0
  );

ALTER TABLE backlink_recommendation_inventory
  ADD COLUMN visible_pool_generation integer NOT NULL DEFAULT 1,
  DROP CONSTRAINT backlink_rec_inventory_recommendation_context_uq,
  DROP CONSTRAINT backlink_rec_inventory_status_check,
  ADD CONSTRAINT backlink_rec_inventory_status_check CHECK (
    status IN (
      'ready', 'claimed', 'shown', 'rejected', 'stale_context', 'accepted',
      'archived'
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_pool_generation_check CHECK (
    visible_pool_generation >= 1
  ),
  ADD CONSTRAINT backlink_rec_inventory_recommendation_context_uq UNIQUE (
    organization_id, workspace_id, website_project_id, recommendation_id,
    recommendation_context_version_id, visible_pool_generation
  );

ALTER TABLE backlink_recommendation_refills
  ADD COLUMN visible_pool_generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT backlink_rec_refill_pool_generation_check CHECK (
    visible_pool_generation >= 1
  );

ALTER TABLE backlink_commercial_discovery_batches
  ADD COLUMN visible_pool_generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT backlink_commercial_batch_pool_generation_check CHECK (
    visible_pool_generation >= 1
  );

ALTER TABLE backlink_commercial_candidates
  DROP CONSTRAINT backlink_commercial_candidate_context_domain_model_uq,
  ADD COLUMN visible_pool_generation integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT backlink_commercial_candidate_pool_generation_check CHECK (
    visible_pool_generation >= 1
  ),
  ADD CONSTRAINT backlink_commercial_candidate_context_domain_model_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, visible_pool_generation,
    canonical_domain, score_model_version
  );

ALTER TABLE backlink_commercial_inventory_policies
  NO FORCE ROW LEVEL SECURITY;

WITH published AS (
  SELECT inventory.organization_id,
         inventory.workspace_id,
         inventory.website_project_id,
         inventory.recommendation_context_version_id,
         count(*) FILTER (
           WHERE inventory.publication_status='PUBLISHED'
             AND inventory.fit_decision='eligible'
             AND inventory.fit_score_model_version=
               'recommendation-commercial-fit.v3'
             AND inventory.contact_decision='eligible'
             AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
             AND inventory.verified_public_email_count>=1
             AND inventory.status IN ('ready','shown','accepted')
         )::integer AS published_count
    FROM backlink_recommendation_inventory AS inventory
   GROUP BY inventory.organization_id,
            inventory.workspace_id,
            inventory.website_project_id,
            inventory.recommendation_context_version_id
)
UPDATE backlink_commercial_inventory_policies AS policy
   SET visible_pool_state=CASE
         WHEN COALESCE(published.published_count,0)>=20
           THEN 'active'
         WHEN policy.refill_state IN ('running','waiting_contact')
           THEN 'building'
         ELSE 'idle'
       END
  FROM published
 WHERE (
   policy.organization_id,
   policy.workspace_id,
   policy.website_project_id,
   policy.project_context_version_id
 )=(
   published.organization_id,
   published.workspace_id,
   published.website_project_id,
   published.recommendation_context_version_id
 );

UPDATE backlink_commercial_inventory_policies
   SET visible_pool_state='building'
 WHERE visible_pool_state='idle'
   AND refill_state IN ('running','waiting_contact');

ALTER TABLE backlink_commercial_inventory_policies
  FORCE ROW LEVEL SECURITY;

CREATE INDEX backlink_rec_inventory_visible_pool_idx
  ON backlink_recommendation_inventory (
    organization_id,workspace_id,website_project_id,
    recommendation_context_version_id,visible_pool_generation,
    publication_status,status
  );

CREATE INDEX backlink_rec_refill_visible_pool_idx
  ON backlink_recommendation_refills (
    organization_id,workspace_id,website_project_id,
    recommendation_context_version_id,visible_pool_generation,created_at
  );

CREATE INDEX backlink_commercial_batch_visible_pool_idx
  ON backlink_commercial_discovery_batches (
    organization_id,workspace_id,website_project_id,
    project_context_version_id,visible_pool_generation,status
  );

CREATE INDEX backlink_commercial_candidate_visible_pool_idx
  ON backlink_commercial_candidates (
    organization_id,workspace_id,website_project_id,
    project_context_version_id,visible_pool_generation,state
  );

COMMIT;
