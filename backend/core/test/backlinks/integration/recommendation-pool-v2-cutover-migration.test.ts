import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

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
const phase9MigrationRunnerPath = fileURLToPath(
  new URL(
    "../../../scripts/apply-recommendation-pool-v2-phase9-migration.ts",
    import.meta.url,
  ),
);
const tsxCliPath = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

describe("recommendation pool V2 cutover migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let migration0082: string;
  let migration0083: string;
  let migration0084: string;
  let migration0085: string;
  let step0082: DeploymentManifest["steps"][number];
  let step0083: DeploymentManifest["steps"][number];
  let step0084: DeploymentManifest["steps"][number];
  let step0085: DeploymentManifest["steps"][number];

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
    const steps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-") &&
        migrationId !== "backlinks-0001",
    );
    const manifestHeadStep = steps.at(-1);
    expect(manifestHeadStep).toBeDefined();
    expect(manifest.heads.backlinks).toBe(
      manifestHeadStep?.migrationId.replace(/^backlinks-/, ""),
    );
    step0082 = steps.find(
      ({ migrationId }) => migrationId === "backlinks-0082",
    ) as DeploymentManifest["steps"][number];
    step0083 = steps.find(
      ({ migrationId }) => migrationId === "backlinks-0083",
    ) as DeploymentManifest["steps"][number];
    step0084 = steps.find(
      ({ migrationId }) => migrationId === "backlinks-0084",
    ) as DeploymentManifest["steps"][number];
    step0085 = steps.find(
      ({ migrationId }) => migrationId === "backlinks-0085",
    ) as DeploymentManifest["steps"][number];
    expect(step0082).toBeDefined();
    expect(step0083).toBeDefined();
    expect(step0084).toBeDefined();
    expect(step0085).toBeDefined();

    const step0082Index = steps.findIndex(
      ({ migrationId }) => migrationId === "backlinks-0082",
    );
    expect(step0082Index).toBeGreaterThanOrEqual(0);
    for (const step of steps.slice(0, step0082Index)) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }

    expect(
      (
        await client.query(
          `SELECT
             to_regclass(
               'backlinks.backlink_recommendation_pool_v2_cutover_runs'
             ) AS runs,
             to_regclass(
               'backlinks.backlink_recommendation_pool_v2_cutover_project_facts'
             ) AS facts,
             to_regclass(
               'backlinks.backlink_recommendation_legacy_source_lineage_facts'
             ) AS lineage`,
        )
      ).rows,
    ).toEqual([{ runs: null, facts: null, lineage: null }]);

    migration0082 = await readFile(migrationUrl(step0082.path), "utf8");
    expect(createHash("sha256").update(migration0082).digest("hex")).toBe(
      step0082.sha256,
    );
    await client.query(migration0082);
    migration0083 = await readFile(migrationUrl(step0083.path), "utf8");
    expect(createHash("sha256").update(migration0083).digest("hex")).toBe(
      step0083.sha256,
    );
    await client.query(migration0083);
    migration0084 = await readFile(migrationUrl(step0084.path), "utf8");
    expect(createHash("sha256").update(migration0084).digest("hex")).toBe(
      step0084.sha256,
    );

    await client.query("SET session_replication_role = replica");
    await client.query(`
      INSERT INTO backlinks.
        backlink_recommendation_legacy_source_lineage_facts (
          id, organization_id, workspace_id, website_project_id,
          target_generation_contract_id,
          target_recommendation_context_version_id,
          target_visible_pool_generation, target_input_pin_id,
          target_batch_id, target_item_id, target_pool_contract_version,
          source_generation_contract_id,
          source_recommendation_context_version_id,
          source_visible_pool_generation, source_input_pin_id,
          source_pool_contract_version, source_candidate_id,
          source_recommendation_id, source_prospect_id,
          source_inventory_id, source_qualification_fact_id,
          source_visibility_fact_id,
          source_contact_enrichment_job_id, canonical_domain,
          contact_terminal_reason, contact_completed_at,
          created_at, created_by
        ) VALUES (
          '018f0000-0000-7000-8000-000000008401',
          '018f0000-0000-7000-8000-000000008402',
          '018f0000-0000-7000-8000-000000008403',
          '018f0000-0000-7000-8000-000000008404',
          '018f0000-0000-7000-8000-000000008405',
          '018f0000-0000-7000-8000-000000008406',
          1,
          '018f0000-0000-7000-8000-000000008407',
          '018f0000-0000-7000-8000-000000008408',
          '018f0000-0000-7000-8000-000000008409',
          'recommendation-pool.v2',
          '018f0000-0000-7000-8000-000000008410',
          '018f0000-0000-7000-8000-000000008411',
          1,
          '018f0000-0000-7000-8000-000000008412',
          'recommendation-pool.v1',
          '018f0000-0000-7000-8000-000000008413',
          '018f0000-0000-7000-8000-000000008414',
          '018f0000-0000-7000-8000-000000008415',
          '018f0000-0000-7000-8000-000000008416',
          '018f0000-0000-7000-8000-000000008417',
          '018f0000-0000-7000-8000-000000008418',
          '018f0000-0000-7000-8000-000000008419',
          'unmapped.example',
          'NO_PUBLIC_EMAIL',
          '2026-08-28T00:00:00.000Z',
          '2026-08-28T00:00:00.000Z',
          'cutover-migration-test'
        )
    `);
    await client.query("SET session_replication_role = origin");

    await expect(client.query(migration0084)).rejects.toMatchObject({
      code: "23514",
      message:
        "Legacy recommendation split qualification lineage cannot be proven.",
    });
    await client.query("ROLLBACK");
    await client.query("SET session_replication_role = replica");
    await client.query(`
      DELETE FROM backlinks.
        backlink_recommendation_legacy_source_lineage_facts
       WHERE id = '018f0000-0000-7000-8000-000000008401'
    `);
    await client.query("SET session_replication_role = origin");
    await client.query(migration0084);
    migration0085 = await readFile(migrationUrl(step0085.path), "utf8");
    expect(createHash("sha256").update(migration0085).digest("hex")).toBe(
      step0085.sha256,
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("adds isolated Phase 8 run and project facts with forced RLS", async () => {
    const relations = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'backlinks'
        AND c.relname IN (
          'backlink_recommendation_pool_v2_cutover_runs',
          'backlink_recommendation_pool_v2_cutover_project_facts',
          'backlink_recommendation_legacy_source_lineage_facts'
        )
      ORDER BY c.relname
    `);
    expect(relations.rows).toEqual([
      {
        relname: "backlink_recommendation_legacy_source_lineage_facts",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "backlink_recommendation_pool_v2_cutover_project_facts",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "backlink_recommendation_pool_v2_cutover_runs",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);

    const legacyQualificationLineageColumns = await client.query(`
      SELECT a.attname, a.attnotnull
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'backlinks'
        AND c.relname =
          'backlink_recommendation_legacy_source_lineage_facts'
        AND a.attname IN (
          'source_qualification_fact_id',
          'source_candidate_qualification_fact_id',
          'source_visibility_qualification_fact_id',
          'source_visibility_fact_id'
        )
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attname
    `);
    expect(legacyQualificationLineageColumns.rows).toEqual([
      {
        attname: "source_candidate_qualification_fact_id",
        attnotnull: true,
      },
      { attname: "source_qualification_fact_id", attnotnull: true },
      {
        attname: "source_visibility_fact_id",
        attnotnull: true,
      },
      {
        attname: "source_visibility_qualification_fact_id",
        attnotnull: true,
      },
    ]);

    const qualificationConstraints = await client.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid =
        'backlinks.backlink_recommendation_legacy_source_lineage_facts'
          ::regclass
        AND conname IN (
          'backlink_legacy_lineage_candidate_qualification_compat_ck',
          'backlink_legacy_lineage_candidate_qualification_fk',
          'backlink_legacy_lineage_visibility_qualification_fk'
        )
      ORDER BY conname
    `);
    expect(qualificationConstraints.rows).toEqual([
      {
        conname: "backlink_legacy_lineage_candidate_qualification_compat_ck",
        contype: "c",
      },
      {
        conname: "backlink_legacy_lineage_candidate_qualification_fk",
        contype: "f",
      },
      {
        conname: "backlink_legacy_lineage_visibility_qualification_fk",
        contype: "f",
      },
    ]);

    const procedures = await client.query(`
      SELECT p.proname,
        pg_get_function_result(p.oid) AS result,
        p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'backlinks'
        AND p.proname IN (
          'backlink_recommendation_pool_v2_start_cutover_run',
          'backlink_recommendation_pool_v2_list_cutover_projects',
          'backlink_recommendation_pool_v2_record_cutover_fact',
          'backlink_recommendation_pool_v2_list_cutover_facts',
          'backlink_recommendation_pool_v2_verify_cutover',
          'backlink_recommendation_pool_v2_finish_cutover_run',
          'backlink_recommendation_legacy_source_lineage_is_valid',
          'backlink_recommendation_release_item_has_valid_lineage'
        )
      ORDER BY p.proname
    `);
    expect(procedures.rows).toHaveLength(8);
    expect(
      procedures.rows.every(({ proconfig }) =>
        Array.isArray(proconfig)
          ? proconfig.includes("search_path=backlinks, pg_catalog")
          : false,
      ),
    ).toBe(true);

    expect(
      (
        await client.query(
          `SELECT to_regprocedure(
             'backlinks.backlink_recommendation_pool_v2_freeze_v1_writes(uuid,text)'
           ) AS procedure`,
        )
      ).rows,
    ).toEqual([{ procedure: null }]);

    const runConstraint = await client.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid =
        'backlinks.backlink_recommendation_pool_v2_cutover_runs'::regclass
        AND conname = 'backlink_pool_v2_cutover_run_values_ck'
    `);
    expect(runConstraint.rows).toHaveLength(1);
    expect(String(runConstraint.rows[0]?.definition)).toContain("'VERIFY'");
  });

  it("is forward-only, idempotent, and does not expose cutover writes to PUBLIC", async () => {
    await client.query(migration0084);

    const publicPrivileges = await client.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'backlinks'
        AND p.proname LIKE 'backlink_recommendation_pool_v2_%cutover%'
        AND has_function_privilege('public', p.oid, 'EXECUTE')
      ORDER BY p.proname
    `);
    expect(publicPrivileges.rows).toEqual([]);

    const lineageHelperPublicPrivileges = await client.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'backlinks'
        AND p.proname =
          'backlink_recommendation_legacy_source_lineage_is_valid'
        AND has_function_privilege('public', p.oid, 'EXECUTE')
    `);
    expect(lineageHelperPublicPrivileges.rows).toEqual([]);

    const phase9Triggers = await client.query(`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname LIKE '%freeze_v1%'
      ORDER BY tgname
    `);
    expect(phase9Triggers.rows).toEqual([]);
  });

  it("upgrades 0084 through 0085 idempotently with scoped Phase 9 guards", async () => {
    const runMigration = () => {
      const result = spawnSync(
        process.execPath,
        [tsxCliPath, phase9MigrationRunnerPath],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: harness.connectionString,
          },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout.trim()) as {
        migrationId: string;
        prerequisite: string;
        applied: boolean;
        verified: boolean;
      };
    };

    expect(runMigration()).toEqual({
      migrationId: "backlinks-0085",
      prerequisite: "backlinks-0084",
      applied: true,
      verified: true,
    });
    expect(runMigration()).toEqual({
      migrationId: "backlinks-0085",
      prerequisite: "backlinks-0084",
      applied: false,
      verified: true,
    });

    const relations = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'backlinks'
        AND c.relname =
          'backlink_recommendation_pool_v2_phase9_runs'
    `);
    expect(relations.rows).toEqual([
      {
        relname: "backlink_recommendation_pool_v2_phase9_runs",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);

    const freezeTriggers = await client.query(`
      SELECT trigger.tgname, relation.relname
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'backlinks'
        AND NOT trigger.tgisinternal
        AND trigger.tgfoid =
          'backlinks.backlink_reject_v1_write_after_phase9()'
            ::regprocedure
      ORDER BY trigger.tgname
    `);
    expect(freezeTriggers.rows).toHaveLength(18);
    expect(freezeTriggers.rows).toContainEqual({
      tgname: "backlink_generation_v1_freeze_guard",
      relname: "backlink_recommendation_generation_contracts",
    });
    expect(freezeTriggers.rows).toContainEqual({
      tgname: "backlink_outbox_v1_freeze_guard",
      relname: "backlink_outbox_events",
    });
    expect(freezeTriggers.rows).toContainEqual({
      tgname: "backlink_provider_request_v1_freeze_guard",
      relname: "backlink_provider_requests",
    });

    const procedures = await client.query(`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'backlinks'
        AND (
          p.proname LIKE 'backlink_phase9_%'
          OR p.proname LIKE
            'backlink_recommendation_pool_v2_phase9_%'
          OR p.proname = 'backlink_reject_v1_write_after_phase9'
        )
      ORDER BY p.proname
    `);
    expect(procedures.rows.length).toBeGreaterThanOrEqual(16);
    expect(
      procedures.rows.every(({ proconfig }) =>
        Array.isArray(proconfig)
          ? proconfig.includes("search_path=backlinks, pg_catalog")
          : false,
      ),
    ).toBe(true);

    const publicPrivileges = await client.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'backlinks'
        AND (
          p.proname LIKE 'backlink_phase9_%'
          OR p.proname LIKE
            'backlink_recommendation_pool_v2_phase9_%'
          OR p.proname = 'backlink_reject_v1_write_after_phase9'
        )
        AND has_function_privilege('public', p.oid, 'EXECUTE')
      ORDER BY p.proname
    `);
    expect(publicPrivileges.rows).toEqual([]);

    const rolePrivileges = await client.query(`
      SELECT
        has_function_privilege(
          'growthos_backlinks_writer',
          'backlinks.backlink_recommendation_pool_v2_phase9_run(
            uuid,text,text,text,timestamptz
          )',
          'EXECUTE'
        ) AS writer_run,
        has_function_privilege(
          'growthos_backlinks_writer',
          'backlinks.backlink_recommendation_pool_v2_phase9_verify()',
          'EXECUTE'
        ) AS writer_verify,
        has_function_privilege(
          'growthos_reporting_reader',
          'backlinks.backlink_recommendation_pool_v2_phase9_verify()',
          'EXECUTE'
        ) AS reporting_verify
    `);
    expect(rolePrivileges.rows).toEqual([
      {
        writer_run: true,
        writer_verify: true,
        reporting_verify: true,
      },
    ]);

    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_recommendation_pool_v2_cutover_control`,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
});
