import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { findBacklinksMigrationViolations } from "../../../scripts/check-backlinks-migrations.js";
import {
  backlinkAuditEvents,
  backlinkJobStatuses,
  backlinkJobs,
  backlinkLifecycleEvents,
} from "../../../src/modules/backlinks/db/schema/jobs.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
};

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql",
  import.meta.url,
);
const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((column) => column.name);
const foreignKeyNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((key) => key.getName());

describe("BL-AI-031 Job and event schema", () => {
  it("keeps tenant, version, time, and append-only columns explicit", () => {
    const tenant = ["organization_id", "workspace_id", "website_project_id"];

    expect(backlinkJobStatuses).toEqual([
      "queued", "running", "waiting_provider", "partial_success",
      "success", "failed", "cancelled",
    ]);
    for (const [table, required] of [
      [backlinkJobs, [...tenant, "version", "created_at", "updated_at"]],
      [backlinkLifecycleEvents, [...tenant, "aggregate_version", "event_schema_version", "created_at"]],
      [backlinkAuditEvents, [...tenant, "event_schema_version", "created_at"]],
    ] as const) {
      expect(columnNames(table)).toEqual(expect.arrayContaining(required));
    }
    expect(columnNames(backlinkLifecycleEvents)).not.toContain("updated_at");
    expect(columnNames(backlinkAuditEvents)).not.toContain("updated_at");
    expect(foreignKeyNames(backlinkLifecycleEvents)).toContain("backlink_lifecycle_job_fk");
    expect(foreignKeyNames(backlinkAuditEvents)).toEqual(
      expect.arrayContaining([
        "backlink_audit_job_fk",
        "backlink_audit_lifecycle_event_fk",
      ]),
    );
    expect(getTableConfig(backlinkJobs).indexes.map((index) => index.config.name))
      .toContain("backlink_job_workspace_workflow_uq");
  });

  it("requires all three tables and their foreign keys in 0001", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(findBacklinksMigrationViolations(sql, {})).toEqual([]);
    expect(
      findBacklinksMigrationViolations(
        sql.replace(
          "CONSTRAINT backlink_audit_lifecycle_event_fk",
          "CONSTRAINT removed_audit_lifecycle_event_fk",
        ),
        {},
      ),
    ).toContain("Missing Audit-to-Lifecycle foreign key.");
  });
  it.skipIf(databaseUrl === undefined)("applies on PostgreSQL with all event foreign keys", async () => {
    const schema = `bl_ai_031_${process.pid}_${Date.now()}`;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(await readFile(migrationPath, "utf8"));
      const constraints = await client.query(`
        SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND connamespace = current_schema()::regnamespace
      `);
      expect(constraints.rows.map((row) => row.conname)).toEqual(
        expect.arrayContaining([
          "backlink_lifecycle_job_fk",
          "backlink_audit_job_fk",
          "backlink_audit_lifecycle_event_fk",
        ]),
      );
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
