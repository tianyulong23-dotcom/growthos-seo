import { readFile } from "node:fs/promises";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { findBacklinksMigrationViolations } from "../../../scripts/check-backlinks-migrations.js";
import { backlinkIdempotencyRecords } from "../../../src/modules/backlinks/db/schema/idempotency.js";

const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql",
  import.meta.url,
);

describe("BL-AI-027 idempotency foundation migration", () => {
  it("defines the tenant-scoped replay record and unique command key", () => {
    const config = getTableConfig(backlinkIdempotencyRecords);
    const columns = Object.fromEntries(
      config.columns.map((column) => [column.name, column]),
    );
    const uniqueIndex = config.indexes.find(
      (index) =>
        index.config.name ===
        "backlink_idempotency_workspace_key_command_uq",
    );

    expect(config.name).toBe("backlink_idempotency_records");
    expect(columns.id).toMatchObject({
      columnType: "PgUUID",
      notNull: true,
      primary: true,
    });
    for (const name of [
      "organization_id",
      "workspace_id",
      "website_project_id",
      "idempotency_key",
      "command_type",
      "request_hash",
      "expires_at",
    ]) {
      expect(columns[name]?.notNull).toBe(true);
    }
    expect(columns.response_body?.columnType).toBe("PgJsonb");
    expect(columns.completed_at?.notNull).toBe(false);
    expect(uniqueIndex?.config).toMatchObject({ unique: true });
    expect(
      uniqueIndex?.config.columns.map((column) => column.name),
    ).toEqual(["workspace_id", "idempotency_key", "command_type"]);
  });

  it("accepts only a forward migration with the required unique constraint", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(findBacklinksMigrationViolations(sql, {})).toEqual([]);
    expect(
      findBacklinksMigrationViolations(
        sql.replace(
          "UNIQUE (workspace_id, idempotency_key, command_type)",
          "UNIQUE (workspace_id, idempotency_key)",
        ),
        {},
      ),
    ).toContain(
      "Missing unique constraint on (workspace_id, idempotency_key, command_type).",
    );
    expect(
      findBacklinksMigrationViolations(sql, {
        unsafe: "drizzle-kit push",
      }),
    ).toContain("Package scripts must not use drizzle-kit push.");
  });
});
