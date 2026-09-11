import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = {
  rows: Record<string, unknown>[];
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type DeploymentManifest = Readonly<{
  heads: Readonly<{ backlinks: string }>;
  steps: readonly Readonly<{
    migrationId: string;
    path: string;
    sha256: string;
  }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
    import.meta.url,
  );

const organizationId = "98000000-0000-4000-8000-000000000001";
const workspaceId = "98000000-0000-4000-8000-000000000002";
const websiteProjectId = "98000000-0000-4000-8000-000000000003";
const otherProjectId = "98000000-0000-4000-8000-000000000004";
const outreachProfileId = "98000000-0000-4000-8000-000000000010";
const inputPinId = "98000000-0000-4000-8000-000000000011";
const v1GenerationId = "98000000-0000-4000-8000-000000000012";
const v1ContextId = "98000000-0000-4000-8000-000000000013";
const v2GenerationId = "98000000-0000-4000-8000-000000000014";
const v2ContextId = "98000000-0000-4000-8000-000000000015";
const projectContractId = "98000000-0000-4000-8000-000000000016";
const userSeedId = "98000000-0000-4000-8000-000000000017";
const systemSeedId = "98000000-0000-4000-8000-000000000018";
const blueprintId = "98000000-0000-4000-8000-000000000019";
const blueprintSeedId = "98000000-0000-4000-8000-000000000020";
const discoveryBatchId = "98000000-0000-4000-8000-000000000021";
const prospectId = "98000000-0000-4000-8000-000000000022";
const recommendationId = "98000000-0000-4000-8000-000000000023";
const inventoryId = "98000000-0000-4000-8000-000000000024";
const candidateId = "98000000-0000-4000-8000-000000000025";
const releaseBatchId = "98000000-0000-4000-8000-000000000026";
const secondReleaseBatchId = "98000000-0000-4000-8000-000000000039";
const nativeItemId = "98000000-0000-4000-8000-000000000027";
const legacyItemIds = [
  "98000000-0000-4000-8000-000000000028",
  "98000000-0000-4000-8000-000000000029",
  "98000000-0000-4000-8000-000000000030",
] as const;
const secondBatchItemIds = [
  "98000000-0000-4000-8000-000000000040",
  "98000000-0000-4000-8000-000000000041",
] as const;
const publicationId = "98000000-0000-4000-8000-000000000031";
const opportunityId = "98000000-0000-4000-8000-000000000032";
const actionId = "98000000-0000-4000-8000-000000000033";
const unlockId = "98000000-0000-4000-8000-000000000034";
const zeroGenerationId = "98000000-0000-4000-8000-000000000035";
const zeroContextId = "98000000-0000-4000-8000-000000000036";
const invalidZeroGenerationId = "98000000-0000-4000-8000-000000000037";
const invalidZeroContextId = "98000000-0000-4000-8000-000000000038";
const userId = "schema-user-a";
const otherUserId = "schema-user-b";

function metricSnapshot(metric: string, value: number | null): string {
  return JSON.stringify({
    value,
    provider: "fixture",
    endpoint: `fixture/${metric}`,
    market: "US",
    location: "United States",
    language: "en",
    observedAt: "2026-08-28T00:00:00.000Z",
    artifactRef: `schema-fixture:${metric}`,
  });
}

describe("recommendation pool V2 schema migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(rolesUrl, "utf8"));
    await client.query(`
      SET ROLE growthos_platform_owner;
      SET search_path = platform, pg_catalog;
      CREATE FUNCTION backlink_list_active_website_projects(text, text)
      RETURNS TABLE (website_project_id text, context_version integer)
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = platform, pg_catalog
      AS $function$ SELECT NULL::text, NULL::integer WHERE false; $function$;
      REVOKE ALL
        ON FUNCTION backlink_list_active_website_projects(text, text)
        FROM PUBLIC;
      GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
      GRANT EXECUTE
        ON FUNCTION backlink_list_active_website_projects(text, text)
        TO growthos_backlinks_owner;
      RESET ROLE;
      RESET search_path;
    `);

    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    expect(
      manifest.steps.find(({ migrationId }) => migrationId === "backlinks-0080")
        ?.sha256,
    ).toMatch(/^[a-f0-9]{64}$/);

    const migrationSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-") &&
        migrationId !== "backlinks-0001",
    );
    const manifestHeadStep = migrationSteps.at(-1);
    expect(manifestHeadStep).toBeDefined();
    expect(manifest.heads.backlinks).toBe(
      manifestHeadStep?.migrationId.replace(/^backlinks-/, ""),
    );
    const phase1Step = migrationSteps.find(
      ({ migrationId }) => migrationId === "backlinks-0080",
    );
    expect(phase1Step).toBeDefined();
    const phase1Index = migrationSteps.findIndex(
      ({ migrationId }) => migrationId === "backlinks-0080",
    );
    expect(phase1Index).toBeGreaterThanOrEqual(0);
    for (const step of migrationSteps.slice(0, phase1Index)) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    expect(
      (
        await client.query(
          "SELECT to_regclass('backlinks.backlink_recommendation_release_batches') AS relation",
        )
      ).rows,
    ).toEqual([{ relation: null }]);
    await client.query(
      await readFile(migrationUrl(phase1Step?.path ?? ""), "utf8"),
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("creates the additive V2 schema with forced RLS and restricted lineage", async () => {
    const names = [
      "backlink_commercial_blueprint_seeds",
      "backlink_commercial_discovery_seed_provenance_assertions",
      "backlink_commercial_discovery_seeds",
      "backlink_recommendation_pool_project_contracts",
      "backlink_recommendation_release_batch_items",
      "backlink_recommendation_release_batches",
      "backlink_recommendation_user_cursors",
      "backlink_recommendation_user_item_actions",
      "backlink_recommendation_user_publications",
      "backlink_recommendation_user_unlocks",
    ];
    expect(
      (
        await client.query(
          `SELECT relname, relrowsecurity, relforcerowsecurity
             FROM pg_class
            WHERE relnamespace='backlinks'::regnamespace
              AND relname=ANY($1::text[])
            ORDER BY relname`,
          [names],
        )
      ).rows,
    ).toEqual(
      names.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
    expect(
      (
        await client.query(`
          SELECT
            to_regclass(
              'backlinks.backlink_recommendation_pool_v2_cutover_runs'
            ) AS "cutoverRuns",
            to_regclass(
              'backlinks.backlink_recommendation_pool_v2_cutover_control'
            ) AS "cutoverControl"
        `)
      ).rows,
    ).toEqual([{ cutoverRuns: null, cutoverControl: null }]);
    expect(
      (
        await client.query(`
          SELECT count(*)::integer AS count
            FROM pg_proc
           WHERE pronamespace='backlinks'::regnamespace
             AND (
               proname LIKE 'backlink_recommendation_pool_v2_%cutover%'
               OR proname='backlink_reject_v1_write_after_cutover'
             )
        `)
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await client.query(`
          SELECT count(*)::integer AS count
            FROM pg_trigger
           WHERE NOT tgisinternal
             AND tgname LIKE '%v1_freeze_guard'
        `)
      ).rows,
    ).toEqual([{ count: 0 }]);

    expect(
      (
        await client.query(`
          SELECT column_name AS "columnName", is_nullable AS "isNullable"
            FROM information_schema.columns
           WHERE table_schema='backlinks'
             AND table_name='backlink_recommendation_generation_contracts'
             AND column_name IN (
               'effective_unique_candidate_count',
               'canonical_batch_size',
               'canonical_batch_count',
               'canonical_order_fingerprint',
               'discovery_terminal_reason',
               'discovery_completed_at'
             )
           ORDER BY column_name
        `)
      ).rows,
    ).toEqual([
      { columnName: "canonical_batch_count", isNullable: "YES" },
      { columnName: "canonical_batch_size", isNullable: "YES" },
      { columnName: "canonical_order_fingerprint", isNullable: "YES" },
      { columnName: "discovery_completed_at", isNullable: "YES" },
      { columnName: "discovery_terminal_reason", isNullable: "YES" },
      { columnName: "effective_unique_candidate_count", isNullable: "YES" },
    ]);

    expect(
      (
        await client.query(`
          SELECT column_name AS "columnName", is_nullable AS "isNullable"
            FROM information_schema.columns
           WHERE table_schema='backlinks'
             AND table_name='backlink_recommendation_release_batch_items'
             AND column_name IN (
               'traffic_snapshot',
               'rank_snapshot',
               'spam_snapshot'
             )
           ORDER BY column_name
        `)
      ).rows,
    ).toEqual([
      { columnName: "rank_snapshot", isNullable: "NO" },
      { columnName: "spam_snapshot", isNullable: "NO" },
      { columnName: "traffic_snapshot", isNullable: "NO" },
    ]);

    const candidateConstraint = (
      await client.query(`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid='backlinks.backlink_commercial_candidates'::regclass
           AND conname='backlink_v2_candidate_lineage_uq'
      `)
    ).rows[0]?.definition;
    expect(candidateConstraint).toContain("project_context_version_id");
    expect(candidateConstraint).toContain("visible_pool_generation");
    expect(candidateConstraint).toContain("recommendation_id");
    expect(candidateConstraint).toContain("prospect_id");

    const provenanceConstraints = (
      await client.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid=
           'backlinks.backlink_commercial_discovery_seed_provenance_assertions'
             ::regclass
           AND conname IN (
             'backlink_commercial_seed_provenance_assertion_uq',
             'backlink_commercial_seed_provenance_seed_fk'
           )
         ORDER BY conname
      `)
    ).rows;
    expect(provenanceConstraints).toHaveLength(2);
    expect(
      provenanceConstraints.find(
        ({ conname }) =>
          conname === "backlink_commercial_seed_provenance_assertion_uq",
      )?.definition,
    ).toContain("assertion_fingerprint");
    const provenanceSeedForeignKey = provenanceConstraints.find(
      ({ conname }) =>
        conname === "backlink_commercial_seed_provenance_seed_fk",
    )?.definition;
    expect(provenanceSeedForeignKey).toContain(
      "recommendation_context_version_id",
    );
    expect(provenanceSeedForeignKey).toContain("visible_pool_generation");
    expect(provenanceSeedForeignKey).toContain("seed_fingerprint");
    expect(
      (
        await client.query(`
          SELECT pg_get_triggerdef(oid) AS definition
            FROM pg_trigger
           WHERE tgrelid=
             'backlinks.backlink_commercial_discovery_seed_provenance_assertions'
               ::regclass
             AND tgname='backlink_commercial_seed_provenance_immutable'
        `)
      ).rows[0]?.definition,
    ).toContain("BEFORE DELETE OR UPDATE");

    expect(
      (
        await client.query(`
          SELECT count(*)::integer AS count
            FROM information_schema.columns
           WHERE table_schema='backlinks'
             AND table_name='backlink_recommendation_release_batch_items'
             AND column_name='project_context_version'
        `)
      ).rows,
    ).toEqual([{ count: 0 }]);

    const itemConstraints = (
      await client.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid=
           'backlinks.backlink_recommendation_release_batch_items'::regclass
           AND conname IN (
             'backlink_release_item_generation_fk',
             'backlink_release_item_input_pin_fk',
             'backlink_release_item_candidate_fk',
             'backlink_release_item_recommendation_fk',
             'backlink_release_item_prospect_fk',
             'backlink_release_item_inventory_fk'
           )
         ORDER BY conname
      `)
    ).rows;
    expect(itemConstraints).toHaveLength(6);
    expect(
      itemConstraints.find(
        ({ conname }) => conname === "backlink_release_item_generation_fk",
      )?.definition,
    ).toContain("recommendation_context_version_id");
    expect(
      itemConstraints.find(
        ({ conname }) => conname === "backlink_release_item_input_pin_fk",
      )?.definition,
    ).toContain("input_pin_id");
    expect(
      itemConstraints.find(
        ({ conname }) => conname === "backlink_release_item_candidate_fk",
      )?.definition,
    ).toContain("project_context_version_id");

    const restrictedForeignKeys = await client.query(`
      SELECT conname
        FROM pg_constraint
       WHERE connamespace='backlinks'::regnamespace
         AND contype='f'
         AND conrelid IN (
            'backlinks.backlink_recommendation_pool_project_contracts'::regclass,
            'backlinks.backlink_commercial_discovery_seeds'::regclass,
            'backlinks.backlink_commercial_discovery_seed_provenance_assertions'
              ::regclass,
            'backlinks.backlink_commercial_blueprint_seeds'::regclass,
           'backlinks.backlink_recommendation_release_batches'::regclass,
           'backlinks.backlink_recommendation_release_batch_items'::regclass,
           'backlinks.backlink_recommendation_user_publications'::regclass,
           'backlinks.backlink_recommendation_user_cursors'::regclass,
           'backlinks.backlink_recommendation_user_unlocks'::regclass,
           'backlinks.backlink_recommendation_user_item_actions'::regclass
         )
         AND confdeltype <> 'r'
    `);
    expect(restrictedForeignKeys.rows).toEqual([]);

    const unlockDefinition = (
      await client.query(`
        SELECT pg_get_functiondef(
          'backlinks.backlink_recommendation_batch_unlock_status(
             text,text,text,text,text
           )'::regprocedure
        ) AS definition
      `)
    ).rows[0]?.definition;
    expect(unlockDefinition).toContain("(batch.original_batch_size + 3) / 4");
    expect(unlockDefinition).toContain("interval '18 hours'");

    expect(
      (
        await client.query(`
          SELECT pg_get_triggerdef(oid) AS definition
            FROM pg_trigger
           WHERE tgrelid=
             'backlinks.backlink_recommendation_release_batches'::regclass
             AND tgname='backlink_release_batch_available_ck'
        `)
      ).rows[0]?.definition,
    ).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  it("preserves V1 writes and enforces the V2 contract through publication", async () => {
    await client.query(
      `INSERT INTO backlinks.backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, 'profile-v1', 'target-v1',
         '["topic"]'::jsonb, '["product"]'::jsonb, '[]'::jsonb,
         '["audience"]'::jsonb, '["editorial review"]'::jsonb,
         'US', 'United States', 'en',
         '["shared-seo-evidence"]'::jsonb, 'schema-profile-v1',
         'recommendation-pool-v2-schema'
       )`,
      [outreachProfileId, organizationId, workspaceId, websiteProjectId],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_generation_input_pins (
         id, organization_id, workspace_id, website_project_id,
         project_context_version, site_profile_version_id,
         outreach_profile_version_id, promotion_target_version_id,
         keyword_evidence_snapshot_ids, shared_evidence_snapshot_ids,
         market, qualification_contract_version, immutable_fingerprint,
         created_by
       ) VALUES (
         $1, $2, $3, $4, 7, 'site-profile-v1', $5, 'target-v1',
         '[]'::jsonb, '[]'::jsonb, 'US',
         'recommendation-qualification.v1', 'schema-input-pin-v1',
         'recommendation-pool-v2-schema'
       )`,
      [
        inputPinId,
        organizationId,
        workspaceId,
        websiteProjectId,
        outreachProfileId,
      ],
    );

    const insertGeneration = async (
      generationId: string,
      contextId: string,
      visiblePoolGeneration: number,
      poolContractVersion?: string,
    ) =>
      client.query(
        `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
           id, organization_id, workspace_id, website_project_id,
           recommendation_context_version_id, visible_pool_generation,
           input_pin_id, qualification_contract_version,
           visibility_contract_version, score_model_version, metric_scope,
           market, location, language, traffic_location_code,
           traffic_language_code, request_fingerprints,
           creator_worker_contract_version, created_by
           ${
             poolContractVersion === undefined
               ? ""
               : `, pool_contract_version, seed_contract_version,
                    release_contract_version, recommendation_marker_version,
                    discovery_budget_policy_version`
           }
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           'recommendation-qualification.v1',
           'recommendation-visibility.v1',
           'recommendation-commercial-fit.v4', 'TARGET_MARKET',
           'US', 'United States', 'en', 2840, 'en', '{}'::jsonb,
           'recommendation-qualification.v1',
           'recommendation-pool-v2-schema'
           ${
             poolContractVersion === undefined
               ? ""
               : `, 'recommendation-pool.v2', 'recommendation-seed.v1',
                    'recommendation-release.v1', 'recommendation-marker.v1',
                    'recommendation-discovery-budget.v1'`
           }
         )`,
        [
          generationId,
          organizationId,
          workspaceId,
          websiteProjectId,
          contextId,
          visiblePoolGeneration,
          inputPinId,
        ],
      );

    await insertGeneration(v1GenerationId, v1ContextId, 1);
    expect(
      (
        await client.query(
          `SELECT pool_contract_version AS "poolContractVersion",
                  discovery_completed_at AS "completedAt"
             FROM backlinks.backlink_recommendation_generation_contracts
            WHERE id=$1`,
          [v1GenerationId],
        )
      ).rows,
    ).toEqual([
      {
        poolContractVersion: "recommendation-pool.v1",
        completedAt: null,
      },
    ]);
    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_generation_contracts
            SET effective_unique_candidate_count=1
          WHERE id=$1`,
        [v1GenerationId],
      ),
    ).rejects.toThrow(/immutable/i);

    await insertGeneration(zeroGenerationId, zeroContextId, 3, "v2");
    await client.query(
      `UPDATE backlinks.backlink_recommendation_generation_contracts
          SET effective_unique_candidate_count=0,
              canonical_batch_size=0,
              canonical_batch_count=0,
              canonical_order_fingerprint='schema-empty-order-v1',
              discovery_terminal_reason='PATHS_EXHAUSTED',
              discovery_completed_at=statement_timestamp()
        WHERE id=$1`,
      [zeroGenerationId],
    );
    expect(
      (
        await client.query(
          `SELECT effective_unique_candidate_count AS "candidateCount",
                  canonical_batch_size AS "batchSize",
                  canonical_batch_count AS "batchCount"
             FROM backlinks.backlink_recommendation_generation_contracts
            WHERE id=$1`,
          [zeroGenerationId],
        )
      ).rows,
    ).toEqual([{ candidateCount: 0, batchSize: 0, batchCount: 0 }]);

    await insertGeneration(
      invalidZeroGenerationId,
      invalidZeroContextId,
      4,
      "v2",
    );
    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_generation_contracts
            SET effective_unique_candidate_count=0,
                canonical_batch_size=1,
                canonical_batch_count=1,
                canonical_order_fingerprint='schema-invalid-empty-order-v1',
                discovery_terminal_reason='PATHS_EXHAUSTED',
                discovery_completed_at=statement_timestamp()
          WHERE id=$1`,
        [invalidZeroGenerationId],
      ),
    ).rejects.toThrow(/check constraint/i);

    await insertGeneration(v2GenerationId, v2ContextId, 2, "v2");
    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_generation_contracts
            SET effective_unique_candidate_count=4
          WHERE id=$1`,
        [v2GenerationId],
      ),
    ).rejects.toThrow(/immutable|check constraint/i);
    await client.query(
      `UPDATE backlinks.backlink_recommendation_generation_contracts
          SET effective_unique_candidate_count=6,
              canonical_batch_size=4,
              canonical_batch_count=2,
              canonical_order_fingerprint='schema-order-v1',
              discovery_terminal_reason='BUDGET_COMPLETE',
              discovery_completed_at=statement_timestamp()
        WHERE id=$1`,
      [v2GenerationId],
    );
    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_generation_contracts
            SET canonical_order_fingerprint='schema-order-mutated'
          WHERE id=$1`,
        [v2GenerationId],
      ),
    ).rejects.toThrow(/immutable/i);

    await client.query(
      `INSERT INTO backlinks.backlink_project_context_snapshots (
         id, organization_id, workspace_id, website_project_id,
         snapshot_version, project_status, canonical_domain, locale,
         country_code, profile_version_id, promotion_target_version_id,
         products, keywords, target_audiences, created_by
       ) VALUES (
         $1, $2, $3, $4, 7, 'ACTIVE', 'project.example.test', 'en-US',
         'US', 'site-profile-v1', 'target-v1', '["product"]'::jsonb,
         '["project topic"]'::jsonb, '["publisher"]'::jsonb,
         'recommendation-pool-v2-schema'
       )`,
      [v2ContextId, organizationId, workspaceId, websiteProjectId],
    );

    await client.query(
      `SELECT set_config('app.current_organization_id',$1,false),
              set_config('app.current_workspace_id',$2,false),
              set_config('app.current_website_project_id',$3,false)`,
      [organizationId, workspaceId, websiteProjectId],
    );
    expect(
      (
        await client.query(
          `SELECT backlinks.backlink_recommendation_pool_contract_guard(
             $1,$2,$3,'recommendation-pool.v1'
           ) AS status`,
          [organizationId, workspaceId, websiteProjectId],
        )
      ).rows,
    ).toEqual([{ status: "applicable" }]);

    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, activated_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, 'recommendation-pool.v2', 'V2_READY',
         $5, $6, 2, $7, NULL,
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [
        projectContractId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2GenerationId,
        v2ContextId,
        inputPinId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_seeds (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, seed_kind, raw_value,
         normalized_value, source, validation_status, confidence_band,
         seed_fingerprint, created_by
       ) VALUES (
         '98000000-0000-4000-8000-000000000042',
         $1, $2, $3, $4, $5, 2, $6, 'KEYWORD', 'preactivation seed',
         'preactivation seed', 'USER_INPUT', 'VERIFIED', 'HIGH',
         'schema-preactivation-seed-v1', 'recommendation-pool-v2-schema'
       )`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        v2GenerationId,
        v2ContextId,
        inputPinId,
      ],
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_commercial_discovery_seeds
            WHERE generation_contract_id=$1
              AND normalized_value='preactivation seed'`,
          [v2GenerationId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    await client.query(
      `UPDATE backlinks.backlink_recommendation_pool_project_contracts
          SET migration_state='V2_ACTIVE',
              activated_at=statement_timestamp(),
              updated_at=statement_timestamp(),
              updated_by='recommendation-pool-v2-schema',
              version=version+1
        WHERE id=$1`,
      [projectContractId],
    );
    expect(
      (
        await client.query(
          `SELECT
             backlinks.backlink_recommendation_pool_contract_guard(
               $1,$2,$3,'recommendation-pool.v1'
             ) AS "v1Status",
             backlinks.backlink_recommendation_pool_contract_guard(
               $1,$2,$3,'recommendation-pool.v2'
             ) AS "v2Status"`,
          [organizationId, workspaceId, websiteProjectId],
        )
      ).rows,
    ).toEqual([
      {
        v1Status: "contract_not_applicable",
        v2Status: "applicable",
      },
    ]);

    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_seeds (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, seed_kind, raw_value,
         normalized_value, source, validation_status, confidence_band,
         seed_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, 'KEYWORD', 'Technical SEO',
         'technical seo', 'USER_INPUT', 'VERIFIED', 'HIGH',
         'schema-seed-user-v1', 'recommendation-pool-v2-schema'
       )`,
      [
        userSeedId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2GenerationId,
        v2ContextId,
        inputPinId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
         id, organization_id, workspace_id, website_project_id,
         project_context_version_id, blueprint_version, generator,
         schema_version, prompt_version, rule_version, blueprint,
         evidence_refs, generated_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 1, 'DETERMINISTIC_FALLBACK',
         'recommendation-blueprint.v2', 'recommendation-seed.v2',
         'recommendation-discovery.v2', '{}'::jsonb, '[]'::jsonb,
         statement_timestamp(), 'recommendation-pool-v2-schema'
       )`,
      [blueprintId, organizationId, workspaceId, websiteProjectId, v2ContextId],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_blueprint_seeds (
         id, organization_id, workspace_id, website_project_id,
         blueprint_id, seed_id, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         seed_ordinal, seed_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 2, 1,
         'schema-seed-user-v1', 'recommendation-pool-v2-schema'
       )`,
      [
        blueprintSeedId,
        organizationId,
        workspaceId,
        websiteProjectId,
        blueprintId,
        userSeedId,
        v2GenerationId,
        v2ContextId,
      ],
    );
    await expect(
      client.query(
        `INSERT INTO backlinks.backlink_commercial_discovery_seeds (
           id, organization_id, workspace_id, website_project_id,
           generation_contract_id, recommendation_context_version_id,
           visible_pool_generation, input_pin_id, seed_kind, raw_value,
           normalized_value, source, validation_status, confidence_band,
           seed_fingerprint, supersedes_seed_id, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 2, $7, 'CATEGORY', 'SEO',
           'seo', 'SYSTEM_SUPPLEMENT', 'VERIFIED', 'MEDIUM',
           'schema-seed-system-v1', $8, 'recommendation-pool-v2-schema'
         )`,
        [
          systemSeedId,
          organizationId,
          workspaceId,
          websiteProjectId,
          v2GenerationId,
          v2ContextId,
          inputPinId,
          userSeedId,
        ],
      ),
    ).rejects.toThrow(/cannot supersede user input/i);

    await client.query(
      `INSERT INTO backlinks.backlink_prospects (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, hostname_ascii,
         registrable_domain, normalization_version, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'native.example.test',
         'example.test', 'tldts-v1',
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [prospectId, organizationId, workspaceId, websiteProjectId, v2ContextId],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendations (
         id, organization_id, workspace_id, website_project_id, prospect_id,
         recommendation_context_version_id, status, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'shown',
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        v2ContextId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_inventory (
         id, organization_id, workspace_id, website_project_id,
         recommendation_id, prospect_id, recommendation_context_version_id,
         visible_pool_generation, status, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 2, 'shown',
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [
        inventoryId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        v2ContextId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_batches (
         id, organization_id, workspace_id, website_project_id, blueprint_id,
         project_context_version_id, status, idempotency_key, request_intent,
         source_types, provider_request_fingerprints, paid_cost_micros,
         started_at, finished_at, created_by, visible_pool_generation
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'completed', 'schema-discovery-batch-v1',
         'DISCOVERY', '["EXISTING_HISTORY"]'::jsonb, '[]'::jsonb, 0,
         statement_timestamp(), statement_timestamp(),
         'recommendation-pool-v2-schema', 2
       )`,
      [
        discoveryBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        blueprintId,
        v2ContextId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_candidates (
         id, organization_id, workspace_id, website_project_id, blueprint_id,
         discovery_batch_id, recommendation_id, prospect_id,
         project_context_version_id, canonical_domain, source_types,
         static_assessment, gate_decision, commercial_score,
         score_model_version, state, provider_collected_at,
         created_by, updated_by, visible_pool_generation
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'native.example.test', '["EXISTING_HISTORY"]'::jsonb, '{}'::jsonb,
         '{"decision":"eligible","hitGates":[],"missingEvidence":[]}'::jsonb,
         '{
           "decision":"eligible",
           "total":72,
           "scoreModelVersion":"recommendation-commercial-fit.v4",
           "ruleVersion":"recommendation-commercial-fit-rules.v4.2",
           "admission":{"appliedThreshold":50}
         }'::jsonb,
         'recommendation-commercial-fit.v4', 'candidate_ready',
         statement_timestamp(), 'recommendation-pool-v2-schema',
         'recommendation-pool-v2-schema', 2
       )`,
      [
        candidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        blueprintId,
        discoveryBatchId,
        recommendationId,
        prospectId,
        v2ContextId,
      ],
    );

    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batches (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, batch_ordinal, state,
         original_batch_size, selection_policy_version, order_fingerprint,
         contact_total_count, preparation_started_at, deadline_at,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, 1, 'PREPARING', 4,
         'recommendation-release-selection.v2', 'schema-release-order-v1',
         4, statement_timestamp(), statement_timestamp() + interval '18 hours',
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [
        releaseBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2GenerationId,
        v2ContextId,
        inputPinId,
      ],
    );

    await expect(
      client.query(
        `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
           id, organization_id, workspace_id, website_project_id, batch_id,
           recommendation_context_version_id, visible_pool_generation,
           candidate_id, recommendation_id, prospect_id,
           generation_contract_id, input_pin_id, canonical_domain, position,
           recommended, recommendation_marker_version, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10, $11,
           'incomplete-native.example.test', 1, true,
           'recommendation-marker.v1', 'recommendation-pool-v2-schema'
         )`,
        [
          nativeItemId,
          organizationId,
          workspaceId,
          websiteProjectId,
          releaseBatchId,
          v2ContextId,
          candidateId,
          recommendationId,
          prospectId,
          v2GenerationId,
          inputPinId,
        ],
      ),
    ).rejects.toThrow(/not-null|check constraint/i);

    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
         id, organization_id, workspace_id, website_project_id, batch_id,
         recommendation_context_version_id, visible_pool_generation,
         candidate_id, recommendation_id, prospect_id, inventory_id,
         generation_contract_id, input_pin_id, canonical_domain, position,
         recommended, recommendation_reason_codes,
         recommendation_marker_version,
         traffic_snapshot, rank_snapshot, spam_snapshot,
         traffic_organic_etv, authority_rank, spam_score, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10, $11, $12,
         'native.example.test', 1, true, '["COMMERCIAL_FIT"]'::jsonb,
         'recommendation-marker.v1', $13::jsonb, $14::jsonb, $15::jsonb,
         120, 45, 7, 'recommendation-pool-v2-schema'
       )`,
      [
        nativeItemId,
        organizationId,
        workspaceId,
        websiteProjectId,
        releaseBatchId,
        v2ContextId,
        candidateId,
        recommendationId,
        prospectId,
        inventoryId,
        v2GenerationId,
        inputPinId,
        metricSnapshot("traffic", 120),
        metricSnapshot("rank", 45),
        metricSnapshot("spam", 7),
      ],
    );

    for (const [index, legacyItemId] of legacyItemIds.entries()) {
      await client.query(
        `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
           id, organization_id, workspace_id, website_project_id, batch_id,
           recommendation_context_version_id, visible_pool_generation,
           generation_contract_id, input_pin_id, canonical_domain, position,
           recommended, recommendation_marker_version,
           traffic_snapshot, rank_snapshot, spam_snapshot,
           contact_terminal_reason_at_release, contact_completed_at_release,
           legacy_imported, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10, false,
           'recommendation-marker.v1', $11::jsonb, $12::jsonb, $13::jsonb,
           'NO_PUBLIC_CONTACT',
           statement_timestamp(), true, 'recommendation-pool-v2-schema'
         )`,
        [
          legacyItemId,
          organizationId,
          workspaceId,
          websiteProjectId,
          releaseBatchId,
          v2ContextId,
          v2GenerationId,
          inputPinId,
          `legacy-${index + 1}.example.test`,
          index + 2,
          metricSnapshot("traffic", null),
          metricSnapshot("rank", null),
          metricSnapshot("spam", null),
        ],
      );
    }

    await expect(
      client.query(
        `UPDATE backlinks.backlink_recommendation_release_batches
            SET state='AVAILABLE',
                contact_terminal_count=4,
                available_at=statement_timestamp(),
                updated_at=statement_timestamp(),
                updated_by='recommendation-pool-v2-schema',
                version=2
          WHERE id=$1`,
        [releaseBatchId],
      ),
    ).rejects.toThrow(/terminal contacts/i);

    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batch_items
          SET contact_terminal_reason_at_release='NO_PUBLIC_CONTACT',
              contact_completed_at_release=statement_timestamp()
        WHERE id=$1`,
      [nativeItemId],
    );
    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=4,
              available_at=statement_timestamp(),
              updated_at=statement_timestamp(),
              updated_by='recommendation-pool-v2-schema',
              version=2
        WHERE id=$1`,
      [releaseBatchId],
    );

    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batches (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, batch_ordinal, state,
         original_batch_size, selection_policy_version, order_fingerprint,
         contact_total_count, preparation_started_at, deadline_at,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, 2, 'PREPARING', 2,
         'recommendation-release-selection.v2', 'schema-release-order-v2',
         2, statement_timestamp(), statement_timestamp() + interval '18 hours',
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [
        secondReleaseBatchId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2GenerationId,
        v2ContextId,
        inputPinId,
      ],
    );
    for (const [index, itemId] of secondBatchItemIds.entries()) {
      const traffic = index === 0 ? 80 : null;
      const rank = index === 0 ? 35 : null;
      const spam = index === 0 ? 12 : null;
      await client.query(
        `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
           id, organization_id, workspace_id, website_project_id, batch_id,
           recommendation_context_version_id, visible_pool_generation,
           generation_contract_id, input_pin_id, canonical_domain, position,
           recommended, recommendation_reason_codes,
           recommendation_marker_version,
           traffic_snapshot, rank_snapshot, spam_snapshot,
           traffic_organic_etv, authority_rank, spam_score, primary_category,
           contact_terminal_reason_at_release, contact_completed_at_release,
           legacy_imported, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 2, $7, $8, $9, $10, $11,
           $12::jsonb, 'recommendation-marker.v1',
           $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19,
           'NO_PUBLIC_CONTACT', statement_timestamp(), true,
           'recommendation-pool-v2-schema'
         )`,
        [
          itemId,
          organizationId,
          workspaceId,
          websiteProjectId,
          secondReleaseBatchId,
          v2ContextId,
          v2GenerationId,
          inputPinId,
          `next-${index + 1}.example.test`,
          index + 1,
          index === 0,
          JSON.stringify(index === 0 ? ["EDITORIAL_MATCH"] : []),
          metricSnapshot("traffic", traffic),
          metricSnapshot("rank", rank),
          metricSnapshot("spam", spam),
          traffic,
          rank,
          spam,
          index === 0 ? "Editorial" : null,
        ],
      );
    }
    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=2,
              available_at=statement_timestamp(),
              updated_at=statement_timestamp(),
              updated_by='recommendation-pool-v2-schema',
              version=2
        WHERE id=$1`,
      [secondReleaseBatchId],
    );

    expect(
      (
        await client.query(
          `SELECT status, publication_status AS "publicationStatus"
             FROM backlinks.backlink_recommendation_inventory
            WHERE id=$1`,
          [inventoryId],
        )
      ).rows,
    ).toEqual([{ status: "shown", publicationStatus: "CONTACT_PENDING" }]);

    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_user_publications (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         user_id, batch_id, first_visible_at, published_by_command_id,
         created_at, updated_at, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, 2, $6, $7, '2000-01-01T00:00:00Z',
         'schema-publish-command-v1', '2000-01-01T00:00:00Z',
         '2000-01-01T00:00:00Z', 'recommendation-pool-v2-schema',
         'recommendation-pool-v2-schema'
       )`,
      [
        publicationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2ContextId,
        userId,
        releaseBatchId,
      ],
    );
    expect(
      (
        await client.query(
          `SELECT first_visible_at > '2026-01-01T00:00:00Z'::timestamptz
                    AS "databaseStamped"
             FROM backlinks.backlink_recommendation_user_publications
            WHERE id=$1`,
          [publicationId],
        )
      ).rows,
    ).toEqual([{ databaseStamped: true }]);

    await expect(
      client.query(
        `INSERT INTO backlinks.backlink_recommendation_user_cursors (
           organization_id, workspace_id, website_project_id,
           recommendation_context_version_id, visible_pool_generation,
           user_id, highest_published_batch_ordinal, current_batch_id,
           updated_by
         ) VALUES ($1, $2, $3, $4, 2, $5, 1, $6, 'schema-user-b')`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          v2ContextId,
          otherUserId,
          releaseBatchId,
        ],
      ),
    ).rejects.toThrow(/active publication/i);
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_user_cursors (
         organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         user_id, highest_published_batch_ordinal, current_batch_id,
         updated_by
       ) VALUES ($1, $2, $3, $4, 2, $5, 1, $6, 'schema-user-a')`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        v2ContextId,
        userId,
        releaseBatchId,
      ],
    );
    await expect(
      client.query(
        `INSERT INTO backlinks.backlink_recommendation_user_cursors (
           organization_id, workspace_id, website_project_id,
           recommendation_context_version_id, visible_pool_generation,
           user_id, highest_published_batch_ordinal, current_batch_id,
           updated_by
         ) VALUES ($1, $2, $3, $4, 2, $5, 1, $6, 'schema-user-a')`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          v2ContextId,
          userId,
          releaseBatchId,
        ],
      ),
    ).rejects.toThrow(/duplicate key/i);

    await client.query(
      `INSERT INTO backlinks.backlink_opportunities (
         id, organization_id, workspace_id, website_project_id,
         recommendation_id, prospect_id, recommendation_context_version_id,
         target_site_key, target_host_ascii, target_identity_rule_version,
         join_sequence, contact_review_required, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'example.test',
         'native.example.test', 'tldts-v1', 1, true,
         'recommendation-pool-v2-schema', 'recommendation-pool-v2-schema'
       )`,
      [
        opportunityId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        v2ContextId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_user_item_actions (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         user_id, batch_id, batch_item_id, action_type, opportunity_id,
         idempotency_key, request_hash, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 2, $6, $7, $8,
         'OPPORTUNITY_CREATED', $9, 'schema-opportunity-action-v1',
         'schema-opportunity-request-v1', 'recommendation-pool-v2-schema'
       )`,
      [
        actionId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2ContextId,
        userId,
        releaseBatchId,
        nativeItemId,
        opportunityId,
      ],
    );
    await expect(
      client.query(
        `INSERT INTO backlinks.backlink_recommendation_user_item_actions (
           id, organization_id, workspace_id, website_project_id,
           recommendation_context_version_id, visible_pool_generation,
           user_id, batch_id, batch_item_id, action_type, opportunity_id,
           idempotency_key, request_hash, created_by
         ) VALUES (
           '98000000-0000-4000-8000-000000000035',
           $1, $2, $3, $4, 2, $5, $6, $7, 'OPPORTUNITY_CREATED', $8,
           'schema-opportunity-action-v1', 'schema-opportunity-request-v1',
           'recommendation-pool-v2-schema'
         )`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          v2ContextId,
          userId,
          releaseBatchId,
          nativeItemId,
          opportunityId,
        ],
      ),
    ).rejects.toThrow(/duplicate key/i);

    expect(
      (
        await client.query(
          `SELECT original_batch_size AS "originalBatchSize",
                  required_opportunity_count AS "requiredCount",
                  successful_opportunity_count AS "successfulCount",
                  unlock_by_ratio AS "unlockByRatio",
                  eligible,
                  reason
             FROM backlinks.backlink_recommendation_batch_unlock_status(
               $1,$2,$3,$4,$5
             )`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            userId,
            releaseBatchId,
          ],
        )
      ).rows,
    ).toEqual([
      {
        originalBatchSize: 4,
        requiredCount: 1,
        successfulCount: 1,
        unlockByRatio: true,
        eligible: true,
        reason: "OPPORTUNITY_RATIO",
      },
    ]);
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_user_unlocks (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         user_id, batch_id, original_batch_size,
         required_opportunity_count, successful_opportunity_count,
         unlocked_at, reason, evaluated_at, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, 2, $6, $7, 99, 99, 99,
         '2000-01-01T00:00:00Z', 'ELAPSED_18H',
         '2000-01-01T00:00:00Z', 'recommendation-pool-v2-schema'
       )`,
      [
        unlockId,
        organizationId,
        workspaceId,
        websiteProjectId,
        v2ContextId,
        userId,
        releaseBatchId,
      ],
    );
    expect(
      (
        await client.query(
          `SELECT original_batch_size AS "originalBatchSize",
                  required_opportunity_count AS "requiredCount",
                  successful_opportunity_count AS "successfulCount",
                  reason, evaluated_at=unlocked_at AS "sameTimestamp"
             FROM backlinks.backlink_recommendation_user_unlocks
            WHERE id=$1`,
          [unlockId],
        )
      ).rows,
    ).toEqual([
      {
        originalBatchSize: 4,
        requiredCount: 1,
        successfulCount: 1,
        reason: "OPPORTUNITY_RATIO",
        sameTimestamp: true,
      },
    ]);

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query(
        `SELECT set_config('app.current_organization_id',$1,true),
                set_config('app.current_workspace_id',$2,true),
                set_config('app.current_website_project_id',$3,true)`,
        [organizationId, workspaceId, websiteProjectId],
      );
      expect(
        (
          await client.query(`
            SELECT count(*)::integer AS count
              FROM backlinks.backlink_recommendation_user_publications
             WHERE user_id='schema-user-a'
          `)
        ).rows,
      ).toEqual([{ count: 1 }]);
      await client.query(
        "SELECT set_config('app.current_website_project_id',$1,true)",
        [otherProjectId],
      );
      expect(
        (
          await client.query(`
            SELECT count(*)::integer AS count
              FROM backlinks.backlink_recommendation_user_publications
          `)
        ).rows,
      ).toEqual([{ count: 0 }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }, 30_000);

  /*
   * Repository feed behavior belongs to Phase 5/6 and is intentionally
   * deferred. Phase 1 verifies only schema-enforced facts and pure policies.
   *
  it("serves the V2 feed with actor isolation and atomic batch unlocks", async () => {
    const scope = {
      organizationId,
      workspaceId,
      websiteProjectId,
    };
    const transact = <T>(
      actorId: string,
      work: (
        repository: ReturnType<typeof createRecommendationFeedRepository>,
      ) => Promise<T>,
    ) =>
      withBacklinkTenantTransaction(pool, scope, (transaction) =>
        work(createRecommendationFeedRepository(transaction)),
      );

    const firstPage = await transact(userId, (repository) =>
      repository.list({
        ...scope,
        actorId: userId,
        sort: "domain_asc",
        limit: 2,
      }),
    );
    expect(firstPage.items.map(({ domain }) => domain)).toEqual([
      "legacy-1.example.test",
      "legacy-2.example.test",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(Object.keys(firstPage.items[0] ?? {}).sort()).toEqual([
      "archived",
      "category",
      "contact",
      "displayUrl",
      "domain",
      "itemId",
      "metrics",
      "opportunity",
      "recommendationReasons",
      "recommended",
      "releasedAt",
    ]);

    const archived = await transact(userId, (repository) =>
      repository.setArchived({
        ...scope,
        actorId: userId,
        itemId: legacyItemIds[0],
        archived: true,
        idempotencyKey: "schema-archive-user-a-v1",
        requestHash: "schema-archive-user-a-hash-v1",
        requestId: "schema-archive-user-a-request-v1",
      }),
    );
    expect(archived).toMatchObject({ archived: true, replayed: false });

    const secondPage = await transact(userId, (repository) =>
      repository.list({
        ...scope,
        actorId: userId,
        sort: "domain_asc",
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      }),
    );
    expect(secondPage.items.map(({ domain }) => domain)).toEqual([
      "legacy-3.example.test",
      "native.example.test",
    ]);

    const actorBPage = await transact(otherUserId, (repository) =>
      repository.list({
        ...scope,
        actorId: otherUserId,
        sort: "domain_asc",
        limit: 10,
      }),
    );
    expect(actorBPage.items).toHaveLength(4);
    expect(
      actorBPage.items.find(({ itemId }) => itemId === legacyItemIds[0])
        ?.archived,
    ).toBe(false);

    const filtered = await transact(userId, (repository) =>
      repository.list({
        ...scope,
        actorId: userId,
        trafficMin: 100,
        sort: "traffic_desc",
        limit: 10,
      }),
    );
    expect(filtered.items.map(({ domain }) => domain)).toEqual([
      "native.example.test",
    ]);

    const exported = await transact(userId, (repository) =>
      repository.export({
        ...scope,
        actorId: userId,
        sort: "domain_asc",
        archived: false,
        selectedItemIds: [nativeItemId],
      }),
    );
    expect(exported.contentType).toBe("text/csv");
    expect(exported.content).toContain("native.example.test");
    expect(exported.content).not.toContain("legacy-2.example.test");
    expect(exported.content).not.toContain("commercial_score");

    const getMore = (
      actorId: string,
      idempotencyKey: string,
      requestHash: string,
    ) =>
      transact(actorId, (repository) =>
        repository.getMore({
          ...scope,
          actorId,
          idempotencyKey,
          requestHash,
          requestId: `${idempotencyKey}-request`,
        }),
      );
    const concurrent = await Promise.all([
      getMore(userId, "schema-get-more-user-a-v1", "schema-get-more-hash-a"),
      getMore(userId, "schema-get-more-user-a-v2", "schema-get-more-hash-b"),
    ]);
    expect(concurrent.filter(({ state }) => state === "RELEASED")).toHaveLength(
      1,
    );
    expect(
      concurrent.filter(({ state }) => state === "NOT_UNLOCKED"),
    ).toHaveLength(1);
    const released = concurrent.find(({ state }) => state === "RELEASED");
    expect(released).toMatchObject({
      currentBatchOrdinal: 1,
      releasedBatchOrdinal: 2,
      replayed: false,
    });
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_recommendation_user_publications
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND user_id=$4 AND batch_id=$5`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            userId,
            secondReleaseBatchId,
          ],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    expect(
      await transact(otherUserId, (repository) =>
        repository.getStatus({
          ...scope,
          actorId: otherUserId,
        }),
      ),
    ).toMatchObject({
      currentBatchOriginalSize: 4,
      successfulOpportunityCount: 0,
      requiredOpportunityCount: 1,
      unlockReason: null,
      canGetMore: false,
      nextBatchState: "AVAILABLE",
    });

    const actorAAfterRelease = await transact(userId, (repository) =>
      repository.list({
        ...scope,
        actorId: userId,
        sort: "domain_asc",
        limit: 20,
      }),
    );
    expect(actorAAfterRelease.items.map(({ domain }) => domain)).toEqual([
      "legacy-2.example.test",
      "legacy-3.example.test",
      "native.example.test",
      "next-1.example.test",
      "next-2.example.test",
    ]);
  });
  */
});
