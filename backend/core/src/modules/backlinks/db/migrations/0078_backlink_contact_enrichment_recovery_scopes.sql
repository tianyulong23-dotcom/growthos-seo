BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE FUNCTION backlink_list_contact_enrichment_recovery_scopes(
  p_limit integer
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'Invalid contact-enrichment recovery scope limit'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH latest_context AS (
    SELECT DISTINCT ON (
      context.organization_id,
      context.workspace_id,
      context.website_project_id
    )
      context.organization_id,
      context.workspace_id,
      context.website_project_id,
      context.id,
      context.project_status
    FROM backlink_project_context_snapshots AS context
    ORDER BY
      context.organization_id,
      context.workspace_id,
      context.website_project_id,
      context.snapshot_version DESC,
      context.created_at DESC,
      context.id DESC
  ),
  missing_jobs AS (
    SELECT DISTINCT
      inventory.organization_id,
      inventory.workspace_id,
      inventory.website_project_id
    FROM backlink_recommendation_inventory AS inventory
    JOIN backlink_recommendations AS recommendation
      ON (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.id,
        recommendation.prospect_id,
        recommendation.recommendation_context_version_id
      ) = (
        inventory.organization_id,
        inventory.workspace_id,
        inventory.website_project_id,
        inventory.recommendation_id,
        inventory.prospect_id,
        inventory.recommendation_context_version_id
      )
    JOIN latest_context AS context
      ON (
        context.organization_id,
        context.workspace_id,
        context.website_project_id,
        context.id
      ) = (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.recommendation_context_version_id
      )
    WHERE context.project_status = 'ACTIVE'
      AND inventory.status IN ('ready', 'shown', 'accepted')
      AND NOT EXISTS (
        SELECT 1
        FROM backlink_contact_enrichment_jobs AS job
        WHERE (
          job.organization_id,
          job.workspace_id,
          job.website_project_id,
          job.recommendation_id,
          job.recommendation_context_version_id
        ) = (
          recommendation.organization_id,
          recommendation.workspace_id,
          recommendation.website_project_id,
          recommendation.id,
          recommendation.recommendation_context_version_id
        )
      )
  ),
  recoverable_jobs AS (
    SELECT DISTINCT
      job.organization_id,
      job.workspace_id,
      job.website_project_id
    FROM backlink_contact_enrichment_jobs AS job
    LEFT JOIN latest_context AS context
      ON (
        context.organization_id,
        context.workspace_id,
        context.website_project_id
      ) = (
        job.organization_id,
        job.workspace_id,
        job.website_project_id
      )
    WHERE job.status IN ('pending', 'running', 'retry_scheduled')
      AND (
        (
          job.status = 'running'
          AND job.updated_at < now() - interval '10 minutes'
        )
        OR (
          job.status = 'retry_scheduled'
          AND (job.retry_after IS NULL OR job.retry_after <= now())
        )
        OR (
          job.recommendation_context_version_id
            IS DISTINCT FROM context.id
        )
        OR (
          job.status IN ('pending', 'retry_scheduled')
          AND job.updated_at < now() - interval '10 minutes'
          AND EXISTS (
            SELECT 1
            FROM backlink_outbox_events AS event
            WHERE (
              event.organization_id,
              event.workspace_id,
              event.website_project_id,
              event.aggregate_id,
              event.aggregate_version
            ) = (
              job.organization_id,
              job.workspace_id,
              job.website_project_id,
              job.id,
              job.version
            )
              AND event.event_type =
                'backlinks.contact-enrichment.requested.v1'
              AND event.status = 'published'
          )
        )
      )
  )
  SELECT scope.organization_id,
         scope.workspace_id,
         scope.website_project_id
  FROM (
    SELECT * FROM missing_jobs
    UNION
    SELECT * FROM recoverable_jobs
  ) AS scope
  ORDER BY
    scope.organization_id,
    scope.workspace_id,
    scope.website_project_id
  LIMIT LEAST(p_limit, 100);
END;
$function$;

REVOKE ALL
  ON FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  TO growthos_backlinks_writer;

COMMIT;
