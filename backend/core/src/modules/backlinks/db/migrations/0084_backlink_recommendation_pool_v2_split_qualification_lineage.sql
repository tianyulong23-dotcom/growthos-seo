BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
  ADD COLUMN IF NOT EXISTS source_candidate_qualification_fact_id uuid,
  ADD COLUMN IF NOT EXISTS source_visibility_qualification_fact_id uuid;

ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
  DISABLE TRIGGER backlink_legacy_source_lineage_validate_trg;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_legacy_source_lineage_is_valid_in_scope(
    p_lineage backlink_recommendation_legacy_source_lineage_facts
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT COALESCE(
    p_lineage.source_qualification_fact_id =
      p_lineage.source_candidate_qualification_fact_id
    AND EXISTS (
      SELECT 1
        FROM backlink_recommendation_release_batch_items AS item
        JOIN backlink_recommendation_release_batches AS batch
          ON batch.organization_id = item.organization_id
         AND batch.workspace_id = item.workspace_id
         AND batch.website_project_id = item.website_project_id
         AND batch.id = item.batch_id
        JOIN backlink_recommendation_generation_contracts AS generation
          ON generation.organization_id = item.organization_id
         AND generation.workspace_id = item.workspace_id
         AND generation.website_project_id = item.website_project_id
         AND generation.id = item.generation_contract_id
        JOIN LATERAL (
          SELECT snapshot.id, snapshot.project_status
            FROM backlink_project_context_snapshots AS snapshot
           WHERE snapshot.organization_id = item.organization_id
             AND snapshot.workspace_id = item.workspace_id
             AND snapshot.website_project_id = item.website_project_id
           ORDER BY snapshot.snapshot_version DESC,
                    snapshot.created_at DESC,
                    snapshot.id DESC
           LIMIT 1
        ) AS current_context ON true
       WHERE item.organization_id = p_lineage.organization_id
         AND item.workspace_id = p_lineage.workspace_id
         AND item.website_project_id = p_lineage.website_project_id
         AND item.id = p_lineage.target_item_id
         AND item.batch_id = p_lineage.target_batch_id
         AND item.generation_contract_id =
           p_lineage.target_generation_contract_id
         AND item.recommendation_context_version_id =
           p_lineage.target_recommendation_context_version_id
         AND item.visible_pool_generation =
           p_lineage.target_visible_pool_generation
         AND item.input_pin_id = p_lineage.target_input_pin_id
         AND item.pool_contract_version =
           p_lineage.target_pool_contract_version
         AND item.pool_contract_version = 'recommendation-pool.v2'
         AND item.legacy_imported = true
         AND item.candidate_id IS NULL
         AND item.recommendation_id IS NULL
         AND item.prospect_id IS NULL
         AND item.inventory_id IS NULL
         AND item.canonical_domain = p_lineage.canonical_domain
         AND item.contact_terminal_reason_at_release =
           p_lineage.contact_terminal_reason
         AND item.contact_completed_at_release =
           p_lineage.contact_completed_at
         AND batch.state IN ('PREPARING', 'AVAILABLE')
         AND generation.pool_contract_version =
           'recommendation-pool.v2'
         AND generation.recommendation_context_version_id =
           p_lineage.target_recommendation_context_version_id
         AND generation.visible_pool_generation =
           p_lineage.target_visible_pool_generation
         AND generation.input_pin_id = p_lineage.target_input_pin_id
         AND current_context.id =
           p_lineage.target_recommendation_context_version_id
         AND current_context.project_status = 'ACTIVE'
    )
    AND EXISTS (
      SELECT 1
        FROM backlink_recommendation_generation_contracts AS generation
        JOIN backlink_commercial_candidates AS candidate
          ON candidate.organization_id = generation.organization_id
         AND candidate.workspace_id = generation.workspace_id
         AND candidate.website_project_id =
           generation.website_project_id
         AND candidate.id = p_lineage.source_candidate_id
         AND candidate.project_context_version_id =
           generation.recommendation_context_version_id
         AND candidate.visible_pool_generation =
           generation.visible_pool_generation
        JOIN backlink_recommendations AS recommendation
          ON recommendation.organization_id = candidate.organization_id
         AND recommendation.workspace_id = candidate.workspace_id
         AND recommendation.website_project_id =
           candidate.website_project_id
         AND recommendation.id = candidate.recommendation_id
         AND recommendation.prospect_id = candidate.prospect_id
         AND recommendation.recommendation_context_version_id =
           candidate.project_context_version_id
        JOIN backlink_prospects AS prospect
          ON prospect.organization_id = recommendation.organization_id
         AND prospect.workspace_id = recommendation.workspace_id
         AND prospect.website_project_id =
           recommendation.website_project_id
         AND prospect.id = recommendation.prospect_id
         AND prospect.recommendation_context_version_id =
           recommendation.recommendation_context_version_id
        JOIN backlink_recommendation_inventory AS inventory
          ON inventory.organization_id = recommendation.organization_id
         AND inventory.workspace_id = recommendation.workspace_id
         AND inventory.website_project_id =
           recommendation.website_project_id
         AND inventory.id = p_lineage.source_inventory_id
         AND inventory.recommendation_id = recommendation.id
         AND inventory.prospect_id = recommendation.prospect_id
         AND inventory.recommendation_context_version_id =
           recommendation.recommendation_context_version_id
         AND inventory.visible_pool_generation =
           generation.visible_pool_generation
        JOIN backlink_recommendation_qualification_facts
          AS candidate_qualification
          ON candidate_qualification.organization_id =
               generation.organization_id
         AND candidate_qualification.workspace_id =
               generation.workspace_id
         AND candidate_qualification.website_project_id =
               generation.website_project_id
         AND candidate_qualification.id =
               p_lineage.source_candidate_qualification_fact_id
         AND candidate_qualification.generation_contract_id =
               generation.id
         AND candidate_qualification.recommendation_context_version_id =
               generation.recommendation_context_version_id
         AND candidate_qualification.candidate_id = candidate.id
         AND candidate_qualification.canonical_domain =
               candidate.canonical_domain
         AND candidate_qualification.metric_scope =
               generation.metric_scope
         AND candidate_qualification.decision = 'eligible'
         AND (
           (
             candidate_qualification.recommendation_id IS NULL
             AND candidate_qualification.prospect_id IS NULL
           )
           OR (
             candidate_qualification.recommendation_id =
               recommendation.id
             AND candidate_qualification.prospect_id = prospect.id
           )
         )
        JOIN backlink_recommendation_qualification_facts
          AS visibility_qualification
          ON visibility_qualification.organization_id =
               generation.organization_id
         AND visibility_qualification.workspace_id =
               generation.workspace_id
         AND visibility_qualification.website_project_id =
               generation.website_project_id
         AND visibility_qualification.id =
               p_lineage.source_visibility_qualification_fact_id
         AND visibility_qualification.generation_contract_id =
               generation.id
         AND visibility_qualification.recommendation_context_version_id =
               generation.recommendation_context_version_id
         AND (
           visibility_qualification.candidate_id IS NULL
           OR visibility_qualification.candidate_id = candidate.id
         )
         AND visibility_qualification.recommendation_id =
               recommendation.id
         AND visibility_qualification.prospect_id = prospect.id
         AND visibility_qualification.canonical_domain =
               candidate.canonical_domain
         AND visibility_qualification.metric_scope =
               generation.metric_scope
         AND visibility_qualification.decision = 'eligible'
        JOIN backlink_recommendation_visibility_facts AS visibility
          ON visibility.organization_id = generation.organization_id
         AND visibility.workspace_id = generation.workspace_id
         AND visibility.website_project_id =
               generation.website_project_id
         AND visibility.id = p_lineage.source_visibility_fact_id
         AND visibility.generation_contract_id = generation.id
         AND visibility.recommendation_context_version_id =
               generation.recommendation_context_version_id
         AND visibility.qualification_fact_id =
               visibility_qualification.id
         AND visibility.recommendation_id = recommendation.id
         AND visibility.prospect_id = prospect.id
         AND visibility.canonical_domain = candidate.canonical_domain
         AND visibility.decision = 'visible'
        JOIN backlink_contact_enrichment_jobs AS contact_job
          ON contact_job.organization_id = generation.organization_id
         AND contact_job.workspace_id = generation.workspace_id
         AND contact_job.website_project_id =
               generation.website_project_id
         AND contact_job.id =
               p_lineage.source_contact_enrichment_job_id
         AND contact_job.recommendation_id = recommendation.id
         AND contact_job.prospect_id = prospect.id
         AND contact_job.recommendation_context_version_id =
               generation.recommendation_context_version_id
         AND contact_job.status IN (
           'completed', 'partially_completed', 'no_contact_found'
         )
         AND contact_job.terminal_reason_code =
               p_lineage.contact_terminal_reason
         AND contact_job.completed_at = p_lineage.contact_completed_at
       WHERE generation.organization_id = p_lineage.organization_id
         AND generation.workspace_id = p_lineage.workspace_id
         AND generation.website_project_id =
           p_lineage.website_project_id
         AND generation.id = p_lineage.source_generation_contract_id
         AND generation.recommendation_context_version_id =
           p_lineage.source_recommendation_context_version_id
         AND generation.visible_pool_generation =
           p_lineage.source_visible_pool_generation
         AND generation.input_pin_id = p_lineage.source_input_pin_id
         AND generation.pool_contract_version =
           p_lineage.source_pool_contract_version
         AND generation.pool_contract_version =
           'recommendation-pool.v1'
         AND candidate.id = p_lineage.source_candidate_id
         AND candidate.recommendation_id =
           p_lineage.source_recommendation_id
         AND candidate.prospect_id = p_lineage.source_prospect_id
          AND candidate.canonical_domain = p_lineage.canonical_domain
          AND recommendation.id = p_lineage.source_recommendation_id
          AND prospect.id = p_lineage.source_prospect_id
          AND prospect.registrable_domain = p_lineage.canonical_domain
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_legacy_source_lineage_is_valid(
    p_lineage backlink_recommendation_legacy_source_lineage_facts
  )
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  previous_organization_id text;
  previous_workspace_id text;
  previous_website_project_id text;
  lineage_is_valid boolean;
BEGIN
  previous_organization_id :=
    current_setting('app.current_organization_id', true);
  previous_workspace_id :=
    current_setting('app.current_workspace_id', true);
  previous_website_project_id :=
    current_setting('app.current_website_project_id', true);

  PERFORM set_config(
    'app.current_organization_id',
    p_lineage.organization_id::text,
    true
  );
  PERFORM set_config(
    'app.current_workspace_id',
    p_lineage.workspace_id::text,
    true
  );
  PERFORM set_config(
    'app.current_website_project_id',
    p_lineage.website_project_id::text,
    true
  );

  lineage_is_valid :=
    backlink_recommendation_legacy_source_lineage_is_valid_in_scope(
      p_lineage
    );

  PERFORM set_config(
    'app.current_organization_id',
    COALESCE(previous_organization_id, ''),
    true
  );
  PERFORM set_config(
    'app.current_workspace_id',
    COALESCE(previous_workspace_id, ''),
    true
  );
  PERFORM set_config(
    'app.current_website_project_id',
    COALESCE(previous_website_project_id, ''),
    true
  );

  RETURN COALESCE(lineage_is_valid, false);
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config(
      'app.current_organization_id',
      COALESCE(previous_organization_id, ''),
      true
    );
    PERFORM set_config(
      'app.current_workspace_id',
      COALESCE(previous_workspace_id, ''),
      true
    );
    PERFORM set_config(
      'app.current_website_project_id',
      COALESCE(previous_website_project_id, ''),
      true
    );
    RAISE;
END;
$function$;

DO $migration$
DECLARE
  lineage
    backlink_recommendation_legacy_source_lineage_facts%ROWTYPE;
  resolved_visibility_qualification_fact_id uuid;
BEGIN
  FOR lineage IN
    SELECT *
      FROM backlink_recommendation_legacy_source_lineage_facts
     ORDER BY organization_id, workspace_id, website_project_id, id
  LOOP
    PERFORM set_config(
      'app.current_organization_id',
      lineage.organization_id::text,
      true
    );
    PERFORM set_config(
      'app.current_workspace_id',
      lineage.workspace_id::text,
      true
    );
    PERFORM set_config(
      'app.current_website_project_id',
      lineage.website_project_id::text,
      true
    );

    SELECT visibility.qualification_fact_id
      INTO resolved_visibility_qualification_fact_id
      FROM backlink_recommendation_visibility_facts AS visibility
     WHERE visibility.organization_id = lineage.organization_id
       AND visibility.workspace_id = lineage.workspace_id
       AND visibility.website_project_id = lineage.website_project_id
       AND visibility.id = lineage.source_visibility_fact_id;

    IF resolved_visibility_qualification_fact_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Legacy recommendation split qualification lineage cannot be proven.',
        DETAIL = format(
          'lineage_id=%s visibility_fact_id=%s',
          lineage.id,
          lineage.source_visibility_fact_id
        );
    END IF;

    UPDATE backlink_recommendation_legacy_source_lineage_facts AS target
       SET source_candidate_qualification_fact_id =
             COALESCE(
               target.source_candidate_qualification_fact_id,
               target.source_qualification_fact_id
             ),
           source_visibility_qualification_fact_id =
             COALESCE(
               target.source_visibility_qualification_fact_id,
               resolved_visibility_qualification_fact_id
             )
     WHERE target.organization_id = lineage.organization_id
       AND target.workspace_id = lineage.workspace_id
       AND target.website_project_id = lineage.website_project_id
       AND target.id = lineage.id
    RETURNING * INTO lineage;

    IF lineage.source_candidate_qualification_fact_id IS NULL
       OR lineage.source_visibility_qualification_fact_id IS NULL
       OR lineage.source_visibility_qualification_fact_id <>
            resolved_visibility_qualification_fact_id
       OR NOT backlink_recommendation_legacy_source_lineage_is_valid(
         lineage
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Legacy recommendation split qualification lineage cannot be proven.',
        DETAIL = format('lineage_id=%s', lineage.id);
    END IF;
  END LOOP;

  PERFORM set_config('app.current_organization_id', '', true);
  PERFORM set_config('app.current_workspace_id', '', true);
  PERFORM set_config('app.current_website_project_id', '', true);
END;
$migration$;

ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
  ALTER COLUMN source_candidate_qualification_fact_id SET NOT NULL,
  ALTER COLUMN source_visibility_qualification_fact_id SET NOT NULL;

ALTER TABLE backlink_recommendation_qualification_facts
  NO FORCE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname =
       'backlink_legacy_lineage_candidate_qualification_compat_ck'
       AND conrelid =
         'backlink_recommendation_legacy_source_lineage_facts'::regclass
  ) THEN
    ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
      ADD CONSTRAINT
        backlink_legacy_lineage_candidate_qualification_compat_ck
      CHECK (
        source_qualification_fact_id =
          source_candidate_qualification_fact_id
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname =
       'backlink_legacy_lineage_candidate_qualification_fk'
       AND conrelid =
         'backlink_recommendation_legacy_source_lineage_facts'::regclass
  ) THEN
    ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
      ADD CONSTRAINT
        backlink_legacy_lineage_candidate_qualification_fk
      FOREIGN KEY (
        organization_id, workspace_id, website_project_id,
        source_candidate_qualification_fact_id
      ) REFERENCES backlink_recommendation_qualification_facts (
        organization_id, workspace_id, website_project_id, id
      ) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname =
       'backlink_legacy_lineage_visibility_qualification_fk'
       AND conrelid =
         'backlink_recommendation_legacy_source_lineage_facts'::regclass
  ) THEN
    ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
      ADD CONSTRAINT
        backlink_legacy_lineage_visibility_qualification_fk
      FOREIGN KEY (
        organization_id, workspace_id, website_project_id,
        source_visibility_qualification_fact_id
      ) REFERENCES backlink_recommendation_qualification_facts (
        organization_id, workspace_id, website_project_id, id
      ) ON DELETE RESTRICT;
  END IF;
END;
$migration$;

ALTER TABLE backlink_recommendation_qualification_facts
  FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION
  backlink_validate_recommendation_legacy_source_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Legacy recommendation source lineage facts are immutable.';
  END IF;

  IF NOT backlink_recommendation_legacy_source_lineage_is_valid(NEW) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Legacy recommendation split qualification lineage is invalid.';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
  ENABLE TRIGGER backlink_legacy_source_lineage_validate_trg;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_release_item_has_valid_lineage(
    p_item backlink_recommendation_release_batch_items
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT CASE
    WHEN p_item.legacy_imported = false THEN
      p_item.candidate_id IS NOT NULL
      AND p_item.recommendation_id IS NOT NULL
      AND p_item.prospect_id IS NOT NULL
      AND p_item.inventory_id IS NOT NULL
      AND p_item.generation_contract_id IS NOT NULL
      AND p_item.input_pin_id IS NOT NULL
    WHEN p_item.legacy_imported = true THEN
      p_item.candidate_id IS NULL
      AND p_item.recommendation_id IS NULL
      AND p_item.prospect_id IS NULL
      AND p_item.inventory_id IS NULL
      AND p_item.generation_contract_id IS NOT NULL
      AND p_item.input_pin_id IS NOT NULL
      AND p_item.contact_terminal_reason_at_release IS NOT NULL
      AND p_item.contact_terminal_reason_at_release <> 'CONTACT_PENDING'
      AND p_item.contact_completed_at_release IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM backlink_recommendation_legacy_source_lineage_facts AS lineage
         WHERE lineage.organization_id = p_item.organization_id
           AND lineage.workspace_id = p_item.workspace_id
           AND lineage.website_project_id = p_item.website_project_id
           AND lineage.target_item_id = p_item.id
           AND lineage.target_batch_id = p_item.batch_id
           AND lineage.target_generation_contract_id =
             p_item.generation_contract_id
           AND lineage.target_recommendation_context_version_id =
             p_item.recommendation_context_version_id
           AND lineage.target_visible_pool_generation =
             p_item.visible_pool_generation
           AND lineage.target_input_pin_id = p_item.input_pin_id
           AND lineage.target_pool_contract_version =
             p_item.pool_contract_version
           AND lineage.canonical_domain = p_item.canonical_domain
           AND lineage.contact_terminal_reason =
             p_item.contact_terminal_reason_at_release
           AND lineage.contact_completed_at =
             p_item.contact_completed_at_release
           AND backlink_recommendation_legacy_source_lineage_is_valid(
             lineage
           )
      )
    ELSE false
  END;
$function$;

ALTER TABLE backlink_recommendation_pool_v2_cutover_runs
  DROP CONSTRAINT backlink_pool_v2_cutover_run_values_ck;
ALTER TABLE backlink_recommendation_pool_v2_cutover_runs
  ADD CONSTRAINT backlink_pool_v2_cutover_run_values_ck CHECK (
    length(btrim(command_id)) > 0
    AND mode IN ('PLAN', 'EXECUTE', 'VERIFY')
    AND status IN (
      'RUNNING',
      'PLANNED',
      'INPUT_REQUIRED',
      'MIGRATION_BLOCKED',
      'COMPLETED'
    )
    AND eligible_project_count >= 0
    AND v2_active_project_count >= 0
    AND input_required_project_count >= 0
    AND migration_blocked_project_count >= 0
    AND jsonb_typeof(verification) = 'object'
    AND length(btrim(created_by)) > 0
    AND length(btrim(updated_by)) > 0
    AND version > 0
    AND (
      (status = 'RUNNING' AND completed_at IS NULL)
      OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
  p_run_id uuid,
  p_command_id text,
  p_mode text,
  p_actor text
)
RETURNS TABLE (
  id uuid,
  command_id text,
  mode text,
  status text,
  eligible_project_count integer,
  v2_active_project_count integer,
  input_required_project_count integer,
  migration_blocked_project_count integer,
  verification jsonb,
  started_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  existing_mode text;
BEGIN
  IF p_run_id IS NULL
     OR length(btrim(p_command_id)) = 0
     OR p_mode NOT IN ('PLAN', 'EXECUTE', 'VERIFY')
     OR length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid recommendation pool V2 cutover command.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('recommendation-pool-v2-cutover:' || p_command_id, 0)
  );

  SELECT run.mode
    INTO existing_mode
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.command_id = p_command_id;

  IF FOUND AND existing_mode <> p_mode THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Cutover command mode does not match the existing run.';
  END IF;

  INSERT INTO backlink_recommendation_pool_v2_cutover_runs (
    id,
    command_id,
    mode,
    created_by,
    updated_by
  ) VALUES (
    p_run_id,
    p_command_id,
    p_mode,
    p_actor,
    p_actor
  )
  ON CONFLICT ON CONSTRAINT backlink_pool_v2_cutover_run_command_uq
  DO NOTHING;

  RETURN QUERY
  SELECT run.id,
         run.command_id,
         run.mode,
         run.status,
         run.eligible_project_count,
         run.v2_active_project_count,
         run.input_required_project_count,
         run.migration_blocked_project_count,
         run.verification,
         run.started_at,
         run.completed_at
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.command_id = p_command_id;
END;
$function$;

REVOKE ALL
  ON FUNCTION
    backlink_recommendation_legacy_source_lineage_is_valid_in_scope(
      backlink_recommendation_legacy_source_lineage_facts
    )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_legacy_source_lineage_is_valid(
    backlink_recommendation_legacy_source_lineage_facts
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_release_item_has_valid_lineage(
    backlink_recommendation_release_batch_items
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
    uuid,
    text,
    text,
    text
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_recommendation_release_item_has_valid_lineage(
    backlink_recommendation_release_batch_items
  )
  TO growthos_backlinks_writer, growthos_reporting_reader;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
    uuid,
    text,
    text,
    text
  )
  TO growthos_backlinks_writer;

COMMIT;
