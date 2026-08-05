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
  readonly jsonb: (name: string) => Builder;
  readonly numeric: (
    name: string,
    config: { readonly precision: number; readonly scale: number },
  ) => Builder;
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
const metricNumber = (name: string) =>
  pg.numeric(name, { precision: 30, scale: 10 });

export const backlinkMetricSnapshots = pg.pgTable(
  "backlink_metric_snapshots",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    metricKey: pg.text("metric_key").notNull(),
    metricDefinitionVersion: pg
      .text("metric_definition_version")
      .notNull(),
    snapshotVersion: pg.integer("snapshot_version").notNull(),
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    asOf: timestamp("as_of").notNull(),
    workspaceTimezone: pg.text("workspace_timezone").notNull(),
    dimensions: pg.jsonb("dimensions").notNull().default({}),
    dimensionHash: pg.text("dimension_hash").notNull(),
    numerator: metricNumber("numerator").notNull(),
    denominator: metricNumber("denominator"),
    valueNumeric: metricNumber("value_numeric"),
    sourceStartedAt: timestamp("source_started_at"),
    sourceEndedAt: timestamp("source_ended_at"),
    sourceFactCount: pg.integer("source_fact_count").notNull(),
    sourceFactIds: pg.jsonb("source_fact_ids").notNull().default([]),
    sourceWatermarkAt: timestamp("source_watermark_at"),
    sourceWatermarkId: pg.text("source_watermark_id"),
    inputChecksum: pg.text("input_checksum").notNull(),
    resultChecksum: pg.text("result_checksum").notNull(),
    computedAt: timestamp("computed_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_metric_snapshot_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_metric_snapshot_version_uq").on(
      ...identity(table),
      table.metricKey,
      table.metricDefinitionVersion,
      table.windowStart,
      table.windowEnd,
      table.asOf,
      table.dimensionHash,
      table.snapshotVersion,
    ),
  ],
);
