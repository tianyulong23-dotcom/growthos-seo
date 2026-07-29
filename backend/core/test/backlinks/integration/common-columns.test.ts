import { pgTable } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  projectAuditColumns,
  projectIdentityColumns,
  versionedProjectAuditColumns,
} from "../../../src/modules/backlinks/db/schema/common.js";

const tenantColumnNames = {
  organizationId: "organization_id",
  workspaceId: "workspace_id",
  websiteProjectId: "website_project_id",
} as const;

describe("backlinks common Drizzle columns", () => {
  it.each([
    ["identity", projectIdentityColumns],
    ["audit", projectAuditColumns],
    ["versioned audit", versionedProjectAuditColumns],
  ] as const)("includes the complete tenant scope in %s helper", (_name, helper) => {
    const columns = helper();

    for (const [property, columnName] of Object.entries(tenantColumnNames)) {
      const column = columns[property as keyof typeof tenantColumnNames];

      expect(column.config).toMatchObject({
        name: columnName,
        columnType: "PgUUID",
        notNull: true,
        hasDefault: false,
      });
    }
  });

  it("defines UTC audit timestamps and actor identifiers", () => {
    const columns = projectAuditColumns();

    expect(columns.createdAt.config).toMatchObject({
      name: "created_at",
      columnType: "PgTimestamp",
      withTimezone: true,
      notNull: true,
      hasDefault: true,
    });
    expect(columns.updatedAt.config).toMatchObject({
      name: "updated_at",
      columnType: "PgTimestamp",
      withTimezone: true,
      notNull: true,
      hasDefault: true,
    });
    expect(columns.createdBy.config).toMatchObject({
      name: "created_by",
      columnType: "PgText",
      notNull: true,
      hasDefault: false,
    });
    expect(columns.updatedBy.config).toMatchObject({
      name: "updated_by",
      columnType: "PgText",
      notNull: true,
      hasDefault: false,
    });

    type CreatedAt = typeof columns.createdAt._.data;
    type CreatedBy = typeof columns.createdBy._.data;
    expectTypeOf<CreatedAt>().toEqualTypeOf<Date>();
    expectTypeOf<CreatedBy>().toEqualTypeOf<string>();
  });

  it("defines a required optimistic version starting at one", () => {
    const columns = versionedProjectAuditColumns();

    expect(columns.version.config).toMatchObject({
      name: "version",
      columnType: "PgInteger",
      notNull: true,
      hasDefault: true,
      default: 1,
    });

    type Version = typeof columns.version._.data;
    expectTypeOf<Version>().toEqualTypeOf<number>();
  });

  it("is accepted by pgTable with the expected select types", () => {
    const table = pgTable(
      "backlink_common_columns_type_test",
      versionedProjectAuditColumns(),
    );

    expect(table).toBeDefined();
    expectTypeOf<typeof table.$inferSelect>().toEqualTypeOf<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      createdAt: Date;
      updatedAt: Date;
      createdBy: string;
      updatedBy: string;
      version: number;
    }>();
  });
});
