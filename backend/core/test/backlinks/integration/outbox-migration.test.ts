import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findBacklinksMigrationViolations } from "../../../scripts/check-backlinks-migrations.js";
import { backlinkOutboxEvents, backlinkOutboxStatuses } from "../../../src/modules/backlinks/db/schema/outbox.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
  }>;
};

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL("../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql", import.meta.url);

describe("BL-AI-029 Outbox migration", () => {
  it("defines fixed states and tenant-safe deduplication", () => {
    const config = getTableConfig(backlinkOutboxEvents);
    const columns = Object.fromEntries(config.columns.map((column) => [column.name, column]));
    const indexes = Object.fromEntries(
      config.indexes.map((index) => [
        index.config.name,
        index.config.columns.map((column) => column.name),
      ]),
    );

    expect(config.name).toBe("backlink_outbox_events");
    expect(backlinkOutboxStatuses).toEqual(["pending", "processing", "published", "failed"]);
    expect(columns.status).toMatchObject({
      notNull: true,
      default: "pending",
    });
    expect(columns.payload?.columnType).toBe("PgJsonb");
    expect(indexes).toMatchObject({
      backlink_outbox_event_aggregate_version_uq: ["event_type", "aggregate_id", "aggregate_version"],
      backlink_outbox_workspace_idempotency_uq: ["workspace_id", "idempotency_key"],
    });
  });

  it("requires the Outbox table and deduplication constraints in 0001", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(findBacklinksMigrationViolations(sql, {})).toEqual([]);
    expect(
      findBacklinksMigrationViolations(
        sql.replace(
          "CREATE TABLE backlink_outbox_events",
          "CREATE TABLE removed",
        ),
        {},
      ),
    ).toContain("0001 must create backlink_outbox_events.");
    expect(
      findBacklinksMigrationViolations(
        sql.replace(
          "UNIQUE (event_type, aggregate_id, aggregate_version)",
          "UNIQUE (event_type, aggregate_id)",
        ),
        {},
      ),
    ).toContain(
      "Missing unique constraint on (event_type, aggregate_id, aggregate_version).",
    );
  });
});

describe.skipIf(databaseUrl === undefined)(
  "BL-AI-029 Outbox transaction rollback",
  () => {
    const schema = `bl_ai_029_${process.pid}_${Date.now()}`;
    let client: RuntimeClient;

    beforeAll(async () => {
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(await readFile(migrationPath, "utf8"));
    });

    afterAll(async () => {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    });

    it("leaves no business record or Outbox event after rollback", async () => {
      await client.query("BEGIN");
      try {
        await client.query(`
          INSERT INTO backlink_idempotency_records (
            id, organization_id, workspace_id, website_project_id, idempotency_key,
            command_type, request_hash, expires_at, created_by, updated_by
          ) VALUES (
            '018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000102',
            '018f0000-0000-7000-8000-000000000103', '018f0000-0000-7000-8000-000000000104',
            'command-029', 'CREATE_PROSPECT', 'sha256:029', '2026-07-23T00:00:00Z', 'user-029', 'user-029'
          )
        `);
        await client.query(`
          INSERT INTO backlink_outbox_events (
            id, organization_id, workspace_id, website_project_id, event_type, aggregate_id,
            aggregate_version, idempotency_key, payload, payload_schema_version, created_by, updated_by
          ) VALUES (
            '018f0000-0000-7000-8000-000000000105', '018f0000-0000-7000-8000-000000000102',
            '018f0000-0000-7000-8000-000000000103', '018f0000-0000-7000-8000-000000000104',
            'prospect.created', '018f0000-0000-7000-8000-000000000106',
            1, 'outbox-029', '{"prospectId":"029"}', 1, 'user-029', 'user-029'
          )
        `);
      } finally {
        await client.query("ROLLBACK");
      }

      const outbox = await client.query("SELECT count(*)::int AS count FROM backlink_outbox_events");
      const business = await client.query("SELECT count(*)::int AS count FROM backlink_idempotency_records");
      expect(outbox.rows[0]).toEqual({ count: 0 });
      expect(business.rows[0]).toEqual({ count: 0 });
    });
  },
);
