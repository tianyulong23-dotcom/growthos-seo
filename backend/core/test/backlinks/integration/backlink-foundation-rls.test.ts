import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findBacklinksMigrationViolations } from "../../../scripts/check-backlinks-migrations.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};
type PostgresError = Error & { readonly code?: string };

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql",
  import.meta.url,
);
const fixturePath = new URL(
  "./fixtures/backlink-foundation-rls.sql",
  import.meta.url,
);
const ids = {
  workspaceA: "018f0000-0000-7000-8000-000000000002",
  projectA: "018f0000-0000-7000-8000-000000000003",
  projectB: "018f0000-0000-7000-8000-000000000004",
  jobA: "018f0000-0000-7000-8000-000000000101",
  jobWorkspaceB: "018f0000-0000-7000-8000-000000000103",
} as const;

describe("BL-AI-033 migration RLS contract", () => {
  it("requires forced Workspace/Project policies and composite tenant links", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(findBacklinksMigrationViolations(sql, {})).toEqual([]);
    expect(
      findBacklinksMigrationViolations(
        sql.replace(
          "ALTER TABLE backlink_jobs FORCE ROW LEVEL SECURITY;",
          "",
        ),
        {},
      ),
    ).toContain("Missing FORCE ROW LEVEL SECURITY for backlink_jobs.");
    expect(
      findBacklinksMigrationViolations(
        sql.replace(
          "app.current_website_project_id",
          "app.removed_website_project_id",
        ),
        {},
      ),
    ).toContain(
      "Missing Workspace/Project RLS policy for backlink_idempotency_records.",
    );
  });
});

describe.skipIf(databaseUrl === undefined)("BL-AI-033 Backlink foundation RLS", () => {
  const schema = `bl_ai_033_${process.pid}_${Date.now()}`;
  const role = `bl_ai_033_role_${process.pid}_${Date.now()}`;
  let client: RuntimeClient;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(await readFile(migrationPath, "utf8"));
    await client.query(await readFile(fixturePath, "utf8"));
    await client.query(
      `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
  });

  afterAll(async () => {
    await client.query("RESET ROLE");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`DROP ROLE IF EXISTS "${role}"`);
    await client.end();
  });

  const setTenant = async () => {
    await client.query(`SET ROLE "${role}"`);
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      [ids.workspaceA],
    );
    await client.query(
      "SELECT set_config('app.current_website_project_id', $1, true)",
      [ids.projectA],
    );
  };
  const resetTenant = async () => {
    await client.query("ROLLBACK");
    await client.query("RESET ROLE");
  };

  it("enables and forces one tenant policy on every 0001 table", async () => {
    const result = await client.query(`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             count(p.policyname)::int AS policy_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policies p
          ON p.schemaname = n.nspname AND p.tablename = c.relname
       WHERE n.nspname = current_schema()
         AND c.relname LIKE 'backlink_%'
         AND c.relkind = 'r'
       GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
       ORDER BY c.relname
    `);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.every((row) =>
      row.enabled === true && row.forced === true && row.policy_count === 1,
    )).toBe(true);
  });

  it("hides cross-workspace and cross-project rows and rejects their writes", async () => {
    await setTenant();
    try {
      const visible = await client.query(
        "SELECT id FROM backlink_jobs ORDER BY id",
      );
      expect(visible.rows).toEqual([{ id: ids.jobA }]);

      const error = await client.query(`
        INSERT INTO backlink_jobs (
          id, organization_id, workspace_id, website_project_id, job_type,
          source_object_type, source_object_id, workflow_id, correlation_id,
          created_by, updated_by
        ) VALUES (
          '018f0000-0000-7000-8000-000000000104',
          '018f0000-0000-7000-8000-000000000001',
          '${ids.workspaceA}', '${ids.projectB}', 'assessment', 'opportunity',
          '018f0000-0000-7000-8000-000000000204', 'workflow-033-rejected',
          'correlation-033-rejected', 'fixture-033', 'fixture-033'
        )
      `).catch((caught: unknown) => caught as PostgresError);
      expect(error).toMatchObject({ code: "42501" });
    } finally {
      await resetTenant();
    }
  });

  it("rejects a child event linked to a Job from another tenant tuple", async () => {
    await setTenant();
    try {
      const error = await client.query(`
        INSERT INTO backlink_lifecycle_events (
          id, organization_id, workspace_id, website_project_id, job_id,
          aggregate_type, aggregate_id, sequence, aggregate_version, event_type,
          actor_type, correlation_id, idempotency_key
        ) VALUES (
          '018f0000-0000-7000-8000-000000000301',
          '018f0000-0000-7000-8000-000000000001',
          '${ids.workspaceA}', '${ids.projectA}', '${ids.jobWorkspaceB}',
          'opportunity', '018f0000-0000-7000-8000-000000000201', 1, 1,
          'opportunity.assessed', 'user', 'correlation-033-composite',
          'idempotency-033-composite'
        )
      `).catch((caught: unknown) => caught as PostgresError);
      expect(error).toMatchObject({ code: "23503" });
    } finally {
      await resetTenant();
    }
  });
});
