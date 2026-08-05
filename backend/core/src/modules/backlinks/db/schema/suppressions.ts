import { createRequire } from "node:module";

type Builder = {
  notNull(): Builder;
  primaryKey(): unknown;
  default(value: unknown): Builder;
  defaultNow(): unknown;
};
type IndexBuilder = {
  where(condition: unknown): unknown;
};
type Table = Readonly<Record<string, unknown>>;

const require = createRequire(import.meta.url);
const { sql } = require("drizzle-orm") as {
  readonly sql: (
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ) => unknown;
};
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (
    name: string,
    columns: Record<string, unknown>,
    extra: (table: Table) => readonly unknown[],
  ) => Table;
  readonly uniqueIndex: (name: string) => {
    on(...columns: readonly unknown[]): IndexBuilder;
  };
  readonly index: (name: string) => {
    on(...columns: readonly unknown[]): IndexBuilder;
  };
  readonly uuid: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly timestamp: (
    name: string,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => Builder;
};

const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });

export const backlinkSuppressionEntries = pg.pgTable(
  "backlink_suppression_entries",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id"),
    websiteProjectId: pg.uuid("website_project_id"),
    scopeType: pg.text("scope_type").notNull(),
    targetType: pg.text("target_type").notNull(),
    targetHmac: pg.text("target_hmac").notNull(),
    hashKeyVersion: pg.integer("hash_key_version").notNull(),
    reason: pg.text("reason").notNull(),
    status: pg.text("status").notNull().default("ACTIVE"),
    releasedAt: timestamp("released_at"),
    releaseReason: pg.text("release_reason"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_suppression_entry_tenant_identity_uq").on(
      table.organizationId,
      table.id,
    ),
    pg
      .uniqueIndex("backlink_suppression_organization_active_uq")
      .on(
        table.organizationId,
        table.targetType,
        table.targetHmac,
        table.hashKeyVersion,
      )
      .where(sql`${table.scopeType} = 'ORGANIZATION'
        AND ${table.status} = 'ACTIVE'`),
    pg
      .uniqueIndex("backlink_suppression_project_active_uq")
      .on(
        table.organizationId,
        table.workspaceId,
        table.websiteProjectId,
        table.targetType,
        table.targetHmac,
        table.hashKeyVersion,
      )
      .where(sql`${table.scopeType} = 'WEBSITE_PROJECT'
        AND ${table.status} = 'ACTIVE'`),
  ],
);

export const backlinkSuppressionFeedbackEvents = pg.pgTable(
  "backlink_suppression_feedback_events",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id").notNull(),
    websiteProjectId: pg.uuid("website_project_id").notNull(),
    sourceEventId: pg.text("source_event_id").notNull(),
    targetHmac: pg.text("target_hmac").notNull(),
    hashKeyVersion: pg.integer("hash_key_version").notNull(),
    kind: pg.text("kind").notNull(),
    observedAt: timestamp("observed_at").notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
    appliedSuppressionReason: pg.text("applied_suppression_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_suppression_feedback_tenant_identity_uq").on(
      table.organizationId,
      table.workspaceId,
      table.websiteProjectId,
      table.id,
    ),
    pg.uniqueIndex("backlink_suppression_feedback_source_event_uq").on(
      table.organizationId,
      table.sourceEventId,
    ),
    pg
      .index("backlink_suppression_feedback_soft_bounce_lookup_idx")
      .on(
        table.organizationId,
        table.targetHmac,
        table.hashKeyVersion,
        table.observedAt,
      )
      .where(sql`${table.kind} = 'SOFT_BOUNCE'`),
  ],
);
