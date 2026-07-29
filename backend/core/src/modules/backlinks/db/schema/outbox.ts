import { createRequire } from "node:module";

import { projectAuditColumns } from "./common.js";

type TableColumns<TColumns extends Record<string, unknown>> = {
  readonly [TKey in keyof TColumns]: TColumns[TKey];
};
type RequiredBuilder = {
  default(value: unknown): unknown;
  defaultNow(): unknown;
};
type ColumnBuilder = {
  notNull(): RequiredBuilder;
  primaryKey(): unknown;
};

const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: <TColumns extends Record<string, unknown>>(
    name: string,
    columns: TColumns,
    extraConfig: (table: TableColumns<TColumns>) => readonly unknown[],
  ) => TableColumns<TColumns>;
  readonly uniqueIndex: (name: string) => {
    on(...columns: readonly unknown[]): unknown;
  };
  readonly uuid: (name: string) => ColumnBuilder;
  readonly text: (name: string) => ColumnBuilder;
  readonly integer: (name: string) => ColumnBuilder;
  readonly jsonb: (name: string) => ColumnBuilder;
  readonly timestamp: (
    name: string,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => ColumnBuilder;
};

export const backlinkOutboxStatuses = [
  "pending",
  "processing",
  "published",
  "failed",
] as const;

const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });

const columns = {
  id: pg.uuid("id").primaryKey(),
  ...projectAuditColumns(),
  eventType: pg.text("event_type").notNull(),
  aggregateId: pg.uuid("aggregate_id").notNull(),
  aggregateVersion: pg.integer("aggregate_version").notNull(),
  idempotencyKey: pg.text("idempotency_key").notNull(),
  payload: pg.jsonb("payload").notNull(),
  payloadSchemaVersion: pg.integer("payload_schema_version").notNull(),
  status: pg.text("status").notNull().default("pending"),
  availableAt: timestamp("available_at").notNull().defaultNow(),
  claimedAt: timestamp("claimed_at"),
  claimedBy: pg.text("claimed_by"),
  publishedAt: timestamp("published_at"),
  attemptCount: pg.integer("attempt_count").notNull().default(0),
};

export const backlinkOutboxEvents = pg.pgTable(
  "backlink_outbox_events",
  columns,
  (table) => [
    pg.uniqueIndex("backlink_outbox_event_aggregate_version_uq").on(
      table.eventType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    pg.uniqueIndex("backlink_outbox_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
  ],
);
