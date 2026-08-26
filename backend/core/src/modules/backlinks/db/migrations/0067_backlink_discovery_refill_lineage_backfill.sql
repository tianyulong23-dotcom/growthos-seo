BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_discovery_batches
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_recommendation_refills
  NO FORCE ROW LEVEL SECURITY;

WITH lineage_candidates AS (
  SELECT
    batch.organization_id,
    batch.workspace_id,
    batch.website_project_id,
    batch.id AS batch_id,
    job.id AS job_id,
    count(*) OVER (
      PARTITION BY
        batch.organization_id,
        batch.workspace_id,
        batch.website_project_id,
        batch.id
    ) AS candidate_count
  FROM backlink_commercial_discovery_batches AS batch
  JOIN backlink_jobs AS job
    ON (
      job.organization_id,
      job.workspace_id,
      job.website_project_id,
      job.source_object_id
    )=(
      batch.organization_id,
      batch.workspace_id,
      batch.website_project_id,
      batch.project_context_version_id
    )
   AND job.job_type='recommendation_refill'
   AND job.source_object_type='recommendation_context'
  JOIN backlink_recommendation_refills AS refill
    ON (
      refill.organization_id,
      refill.workspace_id,
      refill.website_project_id,
      refill.job_id
    )=(
      job.organization_id,
      job.workspace_id,
      job.website_project_id,
      job.id
    )
   AND refill.visible_pool_generation=batch.visible_pool_generation
  WHERE batch.refill_job_id IS NULL
    AND job.started_at IS NOT NULL
    AND batch.started_at>=job.started_at
    AND batch.started_at<=COALESCE(job.finished_at,'infinity'::timestamptz)
),
unique_lineage AS (
  SELECT
    organization_id,
    workspace_id,
    website_project_id,
    batch_id,
    job_id
  FROM lineage_candidates
  WHERE candidate_count=1
)
UPDATE backlink_commercial_discovery_batches AS batch
SET refill_job_id=lineage.job_id
FROM unique_lineage AS lineage
WHERE (
  batch.organization_id,
  batch.workspace_id,
  batch.website_project_id,
  batch.id
)=(
  lineage.organization_id,
  lineage.workspace_id,
  lineage.website_project_id,
  lineage.batch_id
);

ALTER TABLE backlink_commercial_discovery_batches
  FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_recommendation_refills
  FORCE ROW LEVEL SECURITY;

CREATE INDEX backlink_commercial_batch_unowned_refill_idx
  ON backlink_commercial_discovery_batches (
    organization_id,
    workspace_id,
    website_project_id,
    project_context_version_id,
    visible_pool_generation,
    started_at
  )
  WHERE refill_job_id IS NULL;

COMMIT;
