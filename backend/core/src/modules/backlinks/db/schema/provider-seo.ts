import { createRequire } from "node:module";
import { projectIdentityColumns } from "./common.js";

type Builder = { notNull(): Builder; primaryKey(): unknown;
  default(value: unknown): unknown; defaultNow(): unknown };
type Table = Readonly<Record<string, unknown>>;
const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (name: string, columns: Record<string, unknown>,
    extraConfig: (table: Table) => readonly unknown[]) => Table;
  readonly uniqueIndex: (name: string) =>
    { on(...columns: readonly unknown[]): unknown };
  readonly foreignKey: (config: {
    readonly name: string; readonly columns: readonly unknown[];
    readonly foreignColumns: readonly unknown[];
  }) => unknown;
  readonly uuid: (name: string) => Builder; readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder; readonly jsonb: (name: string) => Builder;
  readonly bigint: (name: string, config: { readonly mode: "number" }) => Builder;
  readonly timestamp: (name: string,
    config: { readonly mode: "date"; readonly withTimezone: true }) => Builder;
};
const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });
const recordColumns = () => ({
  id: pg.uuid("id").primaryKey(),
  ...projectIdentityColumns(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: pg.text("created_by").notNull(),
});
const tenantColumns = (table: Table) =>
  [table.organizationId, table.workspaceId, table.websiteProjectId];
const tenantForeignKey = (
  name: string, table: Table, id: unknown, foreignTable: Table,
) => pg.foreignKey({
  name,
  columns: [...tenantColumns(table), id],
  foreignColumns: [...tenantColumns(foreignTable), foreignTable.id],
});
export const backlinkProviderRequests = pg.pgTable(
  "backlink_provider_requests",
  {
    ...recordColumns(),
    provider: pg.text("provider").notNull(),
    endpoint: pg.text("endpoint").notNull(),
    requestFingerprint: pg.text("request_fingerprint").notNull(),
    activeRequestBucket: pg.text("active_request_bucket").notNull(),
    requestSchemaVersion: pg.integer("request_schema_version").notNull(),
    requestPayload: pg.jsonb("request_payload").notNull(),
    status: pg.text("status").notNull().default("pending"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    pg.uniqueIndex("backlink_provider_request_tenant_identity_uq")
      .on(...tenantColumns(table), table.id),
    pg.uniqueIndex("backlink_provider_request_fingerprint_bucket_uq")
      .on(...tenantColumns(table), table.provider, table.endpoint,
        table.requestFingerprint, table.activeRequestBucket),
  ],
);
export const backlinkSeoSnapshots = pg.pgTable(
  "backlink_seo_snapshots",
  {
    ...recordColumns(),
    providerRequestId: pg.uuid("provider_request_id").notNull(),
    provider: pg.text("provider").notNull(),
    target: pg.text("target").notNull(),
    targetType: pg.text("target_type").notNull(),
    snapshotType: pg.text("snapshot_type").notNull(),
    normalizedPayload: pg.jsonb("normalized_payload").notNull(),
    payloadHash: pg.text("payload_hash").notNull(),
    observedAt: timestamp("observed_at").notNull(),
    schemaVersion: pg.integer("schema_version").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_seo_snapshot_tenant_identity_uq")
      .on(...tenantColumns(table), table.id),
    tenantForeignKey("backlink_seo_snapshot_provider_request_fk",
      table, table.providerRequestId, backlinkProviderRequests),
  ],
);
export const backlinkProviderCacheEntries = pg.pgTable(
  "backlink_provider_cache_entries",
  {
    ...recordColumns(),
    provider: pg.text("provider").notNull(),
    endpoint: pg.text("endpoint").notNull(),
    requestFingerprint: pg.text("request_fingerprint").notNull(),
    schemaVersion: pg.integer("schema_version").notNull(),
    seoSnapshotId: pg.uuid("seo_snapshot_id").notNull(),
    fetchedAt: timestamp("fetched_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_provider_cache_fingerprint_schema_uq").on(
      ...tenantColumns(table), table.provider, table.endpoint,
      table.requestFingerprint, table.schemaVersion,
    ),
    tenantForeignKey("backlink_provider_cache_snapshot_fk",
      table, table.seoSnapshotId, backlinkSeoSnapshots),
  ],
);
export const backlinkProviderBudgets = pg.pgTable(
  "backlink_provider_budgets",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id").notNull(),
    provider: pg.text("provider").notNull(),
    periodStart: timestamp("period_start").notNull(),
    periodEnd: timestamp("period_end").notNull(),
    limitMicros: pg.bigint("limit_micros", { mode: "number" }).notNull(),
    spentMicros: pg.bigint("spent_micros", { mode: "number" })
      .notNull().default(0),
    reservedMicros: pg.bigint("reserved_micros", { mode: "number" })
      .notNull().default(0),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_provider_budget_tenant_identity_uq")
      .on(table.organizationId, table.workspaceId, table.id),
    pg.uniqueIndex("backlink_provider_budget_period_uq").on(
      table.organizationId, table.workspaceId, table.provider,
      table.periodStart,
    ),
  ],
);
export const backlinkProviderUsageLedger = pg.pgTable(
  "backlink_provider_usage_ledger",
  {
    ...recordColumns(),
    budgetId: pg.uuid("budget_id").notNull(),
    providerRequestId: pg.uuid("provider_request_id").notNull(),
    provider: pg.text("provider").notNull(),
    reservationKey: pg.text("reservation_key").notNull(),
    estimatedCostMicros: pg.bigint("estimated_cost_micros", { mode: "number" })
      .notNull(),
    actualCostMicros: pg.bigint("actual_cost_micros", { mode: "number" }),
    status: pg.text("status").notNull().default("reserved"),
    settledAt: timestamp("settled_at"),
    releasedAt: timestamp("released_at"),
  },
  (table) => [
    pg.uniqueIndex("backlink_provider_usage_tenant_identity_uq")
      .on(...tenantColumns(table), table.id),
    pg.uniqueIndex("backlink_provider_usage_reservation_uq")
      .on(table.workspaceId, table.provider, table.reservationKey),
    pg.foreignKey({
      name: "backlink_provider_usage_budget_fk",
      columns: [table.organizationId, table.workspaceId, table.budgetId],
      foreignColumns: [
        backlinkProviderBudgets.organizationId,
        backlinkProviderBudgets.workspaceId,
        backlinkProviderBudgets.id,
      ],
    }),
    tenantForeignKey("backlink_provider_usage_request_fk",
      table, table.providerRequestId, backlinkProviderRequests),
  ],
);
