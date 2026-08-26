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
const organizationId = "89000000-0000-4000-8000-000000000001";
const workspaceId = "89000000-0000-4000-8000-000000000002";
const websiteProjectId = "89000000-0000-4000-8000-000000000003";
const otherProjectId = "89000000-0000-4000-8000-000000000004";
const contextId = "89000000-0000-4000-8000-000000000005";
const jobId = "89000000-0000-4000-8000-000000000006";
const operationId = `commercial-refill-operation:${jobId}`;

describe("commercial supply operation migration", () => {
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
    const backlinkSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-")
        && migrationId !== "backlinks-0001",
    );
    const migration0072Step = backlinkSteps.find(
      ({ migrationId }) => migrationId === "backlinks-0072",
    );
    if (migration0072Step === undefined) {
      throw new Error("BACKLINKS_MIGRATION_0072_MISSING");
    }
    for (const step of backlinkSteps.filter(
      ({ migrationId }) => migrationId !== "backlinks-0072",
    )) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    const migration0072 = await readFile(
      migrationUrl(migration0072Step.path),
      "utf8",
    );
    await client.query(migration0072);
    await client.query(`
      INSERT INTO backlinks.backlink_project_context_snapshots (
        id,organization_id,workspace_id,website_project_id,snapshot_version,
        project_status,canonical_domain,locale,country_code,
        profile_version_id,promotion_target_version_id,created_by
      ) VALUES (
        $1,$2,$3,$4,1,'ACTIVE','operation.test','en-US','US',
        'profile-v1','target-v1','migration-test'
      )
    `, [
      contextId,
      organizationId,
      workspaceId,
      websiteProjectId,
    ]);
    await client.query(`
      INSERT INTO backlinks.backlink_jobs (
        id,organization_id,workspace_id,website_project_id,job_type,
        source_object_type,source_object_id,status,workflow_id,correlation_id,
        created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,'recommendation_refill','recommendation_refill',$1,
        'queued','migration-operation-workflow','migration-operation-correlation',
        'migration-test','migration-test'
      )
    `, [
      jobId,
      organizationId,
      workspaceId,
      websiteProjectId,
    ]);
    await client.query(`
      INSERT INTO backlinks.backlink_commercial_supply_operations (
        id,organization_id,workspace_id,website_project_id,
        project_context_version_id,visible_pool_generation,job_id,provider,
        authorization_snapshot,authorization_hash,status,idempotency_key,
        created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,$5,1,$6,'dataforseo',
        '{"provider":"dataforseo","reasonCode":"migration_replay_test"}'::jsonb,
        repeat('a',64),'authorized','migration-replay-operation',
        'migration-test','migration-test'
      )
    `, [
      operationId,
      organizationId,
      workspaceId,
      websiteProjectId,
      contextId,
      jobId,
    ]);
    await client.query(migration0072);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("replays without duplicating DDL or changing persisted facts", async () => {
    expect((await client.query(`
      SELECT count(*)::integer AS "tableCount"
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace
          ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='backlinks'
         AND relation.relname='backlink_commercial_supply_operations'
         AND relation.relkind='r'
    `)).rows).toEqual([{ tableCount: 1 }]);
    expect((await client.query(`
      SELECT indexname AS name
        FROM pg_indexes
       WHERE schemaname='backlinks'
         AND tablename='backlink_commercial_supply_operations'
       ORDER BY indexname
    `)).rows).toEqual([
      { name: "backlink_commercial_supply_operations_pkey" },
      { name: "backlink_supply_operation_idempotency_uq" },
      { name: "backlink_supply_operation_job_uq" },
      { name: "backlink_supply_operation_tenant_identity_uq" },
    ]);
    expect((await client.query(`
      SELECT policyname AS name
        FROM pg_policies
       WHERE schemaname='backlinks'
         AND tablename='backlink_commercial_supply_operations'
    `)).rows).toEqual([
      { name: "backlink_supply_operation_tenant_policy" },
    ]);
    expect((await client.query(`
      SELECT relrowsecurity AS "rlsEnabled",
             relforcerowsecurity AS "rlsForced"
        FROM pg_class
       WHERE oid=
         'backlinks.backlink_commercial_supply_operations'::regclass
    `)).rows).toEqual([{ rlsEnabled: true, rlsForced: true }]);
    expect((await client.query(`
      SELECT id,job_id AS "jobId",idempotency_key AS "idempotencyKey",
             authorization_hash AS "authorizationHash"
        FROM backlinks.backlink_commercial_supply_operations
    `)).rows).toEqual([{
      id: operationId,
      jobId,
      idempotencyKey: "migration-replay-operation",
      authorizationHash: "a".repeat(64),
    }]);
  });

  it("keeps replay uniqueness and tenant isolation enforced", async () => {
    expect((await client.query(`
      SELECT conname
        FROM pg_constraint
       WHERE conrelid=
         'backlinks.backlink_commercial_supply_operations'::regclass
         AND conname IN (
           'backlink_commercial_supply_operations_pkey',
           'backlink_supply_operation_tenant_identity_uq',
           'backlink_supply_operation_job_uq',
           'backlink_supply_operation_idempotency_uq'
         )
       ORDER BY conname
    `)).rows).toEqual([
      { conname: "backlink_commercial_supply_operations_pkey" },
      { conname: "backlink_supply_operation_idempotency_uq" },
      { conname: "backlink_supply_operation_job_uq" },
      { conname: "backlink_supply_operation_tenant_identity_uq" },
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
      expect((await client.query(`
        SELECT id
          FROM backlinks.backlink_commercial_supply_operations
      `)).rows).toEqual([{ id: operationId }]);
      await client.query(
        "SELECT set_config('app.current_website_project_id',$1,true)",
        [otherProjectId],
      );
      expect((await client.query(`
        SELECT id
          FROM backlinks.backlink_commercial_supply_operations
      `)).rows).toEqual([]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
});
