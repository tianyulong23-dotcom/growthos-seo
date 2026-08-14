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
  rowCount: number | null;
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{ migrationId: string; path: string }>[];
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
const migrationUrl = (path: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
  import.meta.url,
);
const organizationId = "85000000-0000-4000-8000-000000000001";
const workspaceId = "85000000-0000-4000-8000-000000000002";
const projectIds = [
  "85000000-0000-4000-8000-000000000011",
  "85000000-0000-4000-8000-000000000012",
  "85000000-0000-4000-8000-000000000013",
] as const;
const contextIds = [
  "85000000-0000-4000-8000-000000000021",
  "85000000-0000-4000-8000-000000000022",
  "85000000-0000-4000-8000-000000000023",
] as const;

describe("LOCAL-PRODUCT-035 reassessment cursor migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let migration0058: string;

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
    const backlinkSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-")
        && migrationId !== "backlinks-0001",
    );
    for (const step of backlinkSteps.filter(
      ({ migrationId }) => migrationId !== "backlinks-0058",
    )) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    const step0058 = backlinkSteps.find(
      ({ migrationId }) => migrationId === "backlinks-0058",
    );
    if (step0058 === undefined) {
      throw new Error("BACKLINKS_MIGRATION_0058_MISSING");
    }
    migration0058 = await readFile(migrationUrl(step0058.path), "utf8");
    await client.query(`
      INSERT INTO backlinks.backlink_commercial_inventory_policies (
        organization_id,workspace_id,website_project_id,
        project_context_version_id,current_refill_tier,
        current_refill_round,attempted_refill_tiers,refill_state,
        termination_reason,updated_at,updated_by,version
      ) VALUES
      (
        $1,$2,$3,$6,'exact_product_target_market',2,
        '[{"tier":"exact_product_target_market","round":1},
          {"tier":"exact_product_target_market","round":2}]'::jsonb,
        'paused','BUDGET','2026-08-01T00:00:00Z',
        'local-product-035-fixture',7
      ),
      (
        $1,$2,$4,$7,'curated_resource_library',1,
        '[{"tier":"same_language_expansion","round":3},
          {"tier":"curated_resource_library","round":1}]'::jsonb,
        'exhausted','TIERS_EXHAUSTED','2026-08-02T00:00:00Z',
        'local-product-035-fixture',8
      ),
      (
        $1,$2,$5,$8,'curated_resource_library',2,
        '[{"tier":"curated_resource_library","round":1},
          {"tier":"curated_resource_library","round":2}]'::jsonb,
        'paused','PROVIDER_UNAVAILABLE','2026-08-03T00:00:00Z',
        'local-product-035-fixture',9
      )
    `, [
      organizationId,
      workspaceId,
      ...projectIds,
      ...contextIds,
    ]);
    await client.query(migration0058);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("preserves policy history while separating paid and resource cursors", async () => {
    expect((await client.query(`
      SELECT website_project_id AS "websiteProjectId",
             paid_refill_tier AS "paidTier",
             paid_refill_round AS "paidRound",
             resource_refill_tier AS "resourceTier",
             resource_refill_round AS "resourceRound",
             current_refill_tier AS "currentTier",
             current_refill_round AS "currentRound",
             refill_state AS "refillState",
             termination_reason AS "terminationReason",
             updated_at::text AS "updatedAt",
             updated_by AS "updatedBy",
             version
        FROM backlinks.backlink_commercial_inventory_policies
       WHERE organization_id=$1 AND workspace_id=$2
       ORDER BY website_project_id
    `, [organizationId, workspaceId])).rows).toEqual([
      {
        websiteProjectId: projectIds[0],
        paidTier: "exact_product_target_market",
        paidRound: 2,
        resourceTier: null,
        resourceRound: null,
        currentTier: "exact_product_target_market",
        currentRound: 2,
        refillState: "paused",
        terminationReason: "BUDGET",
        updatedAt: "2026-08-01 00:00:00+00",
        updatedBy: "local-product-035-fixture",
        version: 7,
      },
      {
        websiteProjectId: projectIds[1],
        paidTier: "same_language_expansion",
        paidRound: 3,
        resourceTier: "curated_resource_library",
        resourceRound: 1,
        currentTier: "curated_resource_library",
        currentRound: 1,
        refillState: "exhausted",
        terminationReason: "TIERS_EXHAUSTED",
        updatedAt: "2026-08-02 00:00:00+00",
        updatedBy: "local-product-035-fixture",
        version: 8,
      },
      {
        websiteProjectId: projectIds[2],
        paidTier: null,
        paidRound: null,
        resourceTier: "curated_resource_library",
        resourceRound: 2,
        currentTier: "curated_resource_library",
        currentRound: 2,
        refillState: "paused",
        terminationReason: "PROVIDER_UNAVAILABLE",
        updatedAt: "2026-08-03 00:00:00+00",
        updatedBy: "local-product-035-fixture",
        version: 9,
      },
    ]);
  });

  it("keeps forced RLS and isolates arbitrary Website Projects", async () => {
    expect((await client.query(`
      SELECT relrowsecurity,relforcerowsecurity
        FROM pg_class
       WHERE oid=
         'backlinks.backlink_commercial_inventory_policies'::regclass
    `)).rows).toEqual([{
      relrowsecurity: true,
      relforcerowsecurity: true,
    }]);

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query(
        `SELECT set_config('app.current_organization_id',$1,true),
                set_config('app.current_workspace_id',$2,true),
                set_config('app.current_website_project_id',$3,true),
                set_config('app.current_project_id',$3,true)`,
        [organizationId, workspaceId, projectIds[1]],
      );
      expect((await client.query(`
        SELECT website_project_id AS "websiteProjectId",
               paid_refill_tier AS "paidTier",
               resource_refill_tier AS "resourceTier"
          FROM backlinks.backlink_commercial_inventory_policies
         ORDER BY website_project_id
      `)).rows).toEqual([{
        websiteProjectId: projectIds[1],
        paidTier: "same_language_expansion",
        resourceTier: "curated_resource_library",
      }]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  it("keeps both cursor constraints fail-closed", async () => {
    const constraints = (await client.query(`
      SELECT conname
        FROM pg_constraint
       WHERE conrelid=
         'backlinks.backlink_commercial_inventory_policies'::regclass
         AND conname IN (
           'backlink_commercial_paid_refill_cursor_check',
           'backlink_commercial_resource_refill_cursor_check'
         )
       ORDER BY conname
    `)).rows;
    expect(constraints).toEqual([
      { conname: "backlink_commercial_paid_refill_cursor_check" },
      { conname: "backlink_commercial_resource_refill_cursor_check" },
    ]);
    await expect(client.query(`
      UPDATE backlinks.backlink_commercial_inventory_policies
         SET resource_refill_tier='same_language_expansion',
             resource_refill_round=1
       WHERE website_project_id='${projectIds[0]}'
    `)).rejects.toThrow();
  });
});
