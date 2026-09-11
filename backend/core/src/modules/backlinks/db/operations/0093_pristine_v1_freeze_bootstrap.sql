DO $bootstrap$
DECLARE
  v_can_bypass_rls boolean;
  v_table record;
  v_table_name text;
  v_backlinks_tables text[] := ARRAY[]::text[];
  v_nonempty_tables text[] := ARRAY[]::text[];
  v_has_rows boolean;
  v_verification jsonb;
  v_phase9_verification jsonb;
  v_phase9_run jsonb;
  v_observed_at timestamptz := statement_timestamp();
BEGIN
  IF backlinks.backlink_phase9_v1_writes_are_frozen() THEN
    v_phase9_verification :=
      backlinks.backlink_recommendation_pool_v2_phase9_verify();
    IF NOT COALESCE(
      (v_phase9_verification->>'completed')::boolean,
      false
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'BACKLINKS_0093_UPGRADE_REQUIRES_VALID_V1_WRITE_FREEZE',
        DETAIL = v_phase9_verification::text;
    END IF;
  ELSE
    SELECT role.rolsuper OR role.rolbypassrls
      INTO v_can_bypass_rls
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = current_user;

    IF NOT COALESCE(v_can_bypass_rls, false) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE =
          'BACKLINKS_0093_FRESH_BOOTSTRAP_REQUIRES_DATABASE_OPERATOR';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'backlinks-deployment-manifest:0093:fresh-bootstrap',
        0
      )
    );

    IF pg_catalog.to_regclass('platform.projects') IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'BACKLINKS_0093_FRESH_BOOTSTRAP_REQUIRES_PLATFORM_PROJECTS';
    END IF;
    LOCK TABLE platform.projects IN ACCESS EXCLUSIVE MODE;

    FOR v_table IN
      SELECT class.relname
        FROM pg_catalog.pg_class AS class
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'backlinks'
         AND class.relkind IN ('r', 'p')
       ORDER BY class.relname
    LOOP
      EXECUTE pg_catalog.format(
        'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
        'backlinks',
        v_table.relname
      );
      v_backlinks_tables :=
          pg_catalog.array_append(v_backlinks_tables, v_table.relname);
    END LOOP;

    SELECT EXISTS (SELECT 1 FROM platform.projects)
      INTO v_has_rows;
    IF v_has_rows THEN
      v_nonempty_tables :=
        pg_catalog.array_append(v_nonempty_tables, 'platform.projects');
    END IF;

    FOREACH v_table_name IN ARRAY v_backlinks_tables
    LOOP
      EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I)',
        'backlinks',
        v_table_name
      )
      INTO v_has_rows;
      IF v_has_rows THEN
        v_nonempty_tables :=
          pg_catalog.array_append(
            v_nonempty_tables,
            'backlinks.' || v_table_name
          );
      END IF;
    END LOOP;

    IF pg_catalog.cardinality(v_nonempty_tables) > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'BACKLINKS_0093_FRESH_BOOTSTRAP_REQUIRES_PRISTINE_DATABASE',
        DETAIL =
          'Non-empty business tables: ' ||
          pg_catalog.array_to_string(v_nonempty_tables, ', ');
    END IF;

    v_verification :=
      backlinks.backlink_recommendation_pool_v2_verify_cutover();
    IF NOT COALESCE((v_verification->>'completed')::boolean, false)
       OR COALESCE(
            (v_verification->>'eligibleProjectCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'v2ActiveProjectCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'migrationBlockedProjectCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1GenerationCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1RefillCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1RefillJobCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1OutboxCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1ClaimCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1ProviderRequestCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1ProviderReservationCount')::integer,
            -1
          ) <> 0
       OR COALESCE(
            (v_verification->>'activeV1ProviderLeaseCount')::integer,
            -1
          ) <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'BACKLINKS_0093_FRESH_BOOTSTRAP_VERIFICATION_FAILED',
        DETAIL = v_verification::text;
    END IF;

    PERFORM *
      FROM backlinks.backlink_recommendation_pool_v2_start_cutover_run(
        '00000000-0000-7000-8000-000000000093'::uuid,
        'deployment-manifest:0093:pristine-cutover.v1',
        'EXECUTE',
        'backlinks-deployment-manifest'
      );
    PERFORM backlinks.backlink_recommendation_pool_v2_finish_cutover_run(
      '00000000-0000-7000-8000-000000000093'::uuid,
      'COMPLETED',
      0,
      0,
      0,
      0,
      v_verification || pg_catalog.jsonb_build_object(
        'freshInstallBootstrap',
        true,
        'pristineBacklinksTableCount',
        pg_catalog.cardinality(v_backlinks_tables),
        'platformProjectsEmpty',
        true
      ),
      'backlinks-deployment-manifest',
      v_observed_at
    );

    v_phase9_run :=
      backlinks.backlink_recommendation_pool_v2_phase9_run(
        '00000000-0000-7000-8000-000000000193'::uuid,
        'deployment-manifest:0093:pristine-freeze.v1',
        'EXECUTE',
        'backlinks-deployment-manifest',
        v_observed_at
      );
    IF v_phase9_run->>'status' <> 'COMPLETED'
       OR NOT COALESCE(
            (v_phase9_run->'verification'->>'completed')::boolean,
            false
          )
       OR NOT backlinks.backlink_phase9_v1_writes_are_frozen() THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'BACKLINKS_0093_FRESH_BOOTSTRAP_FREEZE_FAILED',
        DETAIL = v_phase9_run::text;
    END IF;
  END IF;
END;
$bootstrap$;
