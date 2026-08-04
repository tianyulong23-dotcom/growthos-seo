import { createRequire } from "node:module";

import { projectIdentityColumns } from "./common.js";

type Builder = {
  notNull(): Builder;
  primaryKey(): unknown;
  default(value: unknown): Builder;
  defaultNow(): unknown;
};
type Table = Readonly<Record<string, unknown>>;

const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (
    name: string,
    columns: Record<string, unknown>,
    extra: (table: Table) => readonly unknown[],
  ) => Table;
  readonly uniqueIndex: (name: string) => {
    on(...columns: readonly unknown[]): unknown;
  };
  readonly uuid: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly timestamp: (
    name: string,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => Builder;
};

const identity = (table: Table) =>
  [
    table.organizationId,
    table.workspaceId,
    table.websiteProjectId,
  ] as const;
const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });

export const backlinkTaskProjections = pg.pgTable(
  "backlink_task_projections",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    occurrenceKey: pg.text("occurrence_key").notNull(),
    sourceEventId: pg.text("source_event_id").notNull(),
    sourceEventType: pg.text("source_event_type").notNull(),
    ruleKey: pg.text("rule_key").notNull(),
    ruleVersion: pg.integer("rule_version").notNull(),
    taskType: pg.text("task_type").notNull(),
    title: pg.text("title").notNull(),
    status: pg.text("status").notNull().default("open"),
    occurredAt: timestamp("occurred_at").notNull(),
    projectedAt: timestamp("projected_at").notNull(),
    projectionVersion: pg.integer("projection_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    pg.uniqueIndex("backlink_task_projection_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_task_projection_occurrence_uq").on(
      ...identity(table),
      table.occurrenceKey,
    ),
  ],
);
