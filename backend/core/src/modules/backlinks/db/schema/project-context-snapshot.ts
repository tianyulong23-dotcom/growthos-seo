import { createRequire } from "node:module";

import { projectIdentityColumns } from "./common.js";

type Builder = {
  notNull(): Builder;
  primaryKey(): unknown;
  defaultNow(): unknown;
};
type Table = Readonly<Record<string, unknown>>;
const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (
    name: string, columns: Record<string, unknown>,
    extraConfig: (table: Table) => readonly unknown[],
  ) => Table;
  readonly uniqueIndex: (name: string) =>
    { on(...columns: readonly unknown[]): unknown };
  readonly uuid: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly timestamp: (
    name: string, config: { readonly mode: "date"; readonly withTimezone: true },
  ) => Builder;
};

export const projectContextSnapshotStatuses = [
  "ACTIVE",
  "PAUSED",
  "DELETION_REQUESTED",
  "DELETED",
] as const;

export const backlinkProjectContextSnapshots = pg.pgTable(
  "backlink_project_context_snapshots",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    snapshotVersion: pg.integer("snapshot_version").notNull(),
    projectStatus: pg.text("project_status").notNull(),
    canonicalDomain: pg.text("canonical_domain").notNull(),
    locale: pg.text("locale").notNull(),
    countryCode: pg.text("country_code").notNull(),
    profileVersionId: pg.text("profile_version_id").notNull(),
    promotionTargetVersionId: pg.text("promotion_target_version_id").notNull(),
    createdAt: pg.timestamp("created_at", {
      mode: "date", withTimezone: true,
    }).notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_project_context_snapshot_version_uq").on(
      table.organizationId,
      table.workspaceId,
      table.websiteProjectId,
      table.snapshotVersion,
    ),
  ],
);
