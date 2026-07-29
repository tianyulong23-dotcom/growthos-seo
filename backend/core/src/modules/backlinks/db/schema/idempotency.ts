import { createRequire } from "node:module";

import { projectAuditColumns } from "./common.js";

type TableColumns<TColumns extends Record<string, unknown>> = {
  readonly [TKey in keyof TColumns]: TColumns[TKey];
};

const require = createRequire(import.meta.url);
const { pgTable } = require("drizzle-orm/pg-core/table") as {
  readonly pgTable: <TColumns extends Record<string, unknown>>(
    name: string,
    columns: TColumns,
    extraConfig: (table: TableColumns<TColumns>) => readonly unknown[],
  ) => TableColumns<TColumns>;
};
const { uniqueIndex } = require("drizzle-orm/pg-core/indexes") as {
  readonly uniqueIndex: (name: string) => {
    on(...columns: readonly unknown[]): unknown;
  };
};
const { uuid } = require("drizzle-orm/pg-core/columns/uuid") as {
  readonly uuid: (name: string) => {
    primaryKey(): unknown;
  };
};
const { text } = require("drizzle-orm/pg-core/columns/text") as {
  readonly text: (name: string) => {
    notNull(): unknown;
  };
};
const { integer } = require("drizzle-orm/pg-core/columns/integer") as {
  readonly integer: (name: string) => unknown;
};
const { jsonb } = require("drizzle-orm/pg-core/columns/jsonb") as {
  readonly jsonb: (name: string) => unknown;
};
const { timestamp } = require(
  "drizzle-orm/pg-core/columns/timestamp",
) as {
  readonly timestamp: (
    name: string,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => {
    notNull(): unknown;
  };
};

const columns = {
  id: uuid("id").primaryKey(),
  ...projectAuditColumns(),
  idempotencyKey: text("idempotency_key").notNull(),
  commandType: text("command_type").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  responseSchemaVersion: integer("response_schema_version"),
  completedAt: timestamp("completed_at", {
    mode: "date",
    withTimezone: true,
  }),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
};

export const backlinkIdempotencyRecords = pgTable(
  "backlink_idempotency_records",
  columns,
  (table) => [
    uniqueIndex("backlink_idempotency_workspace_key_command_uq").on(
      table.workspaceId,
      table.idempotencyKey,
      table.commandType,
    ),
  ],
);
