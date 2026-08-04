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
  readonly foreignKey: (config: {
    readonly name: string;
    readonly columns: readonly unknown[];
    readonly foreignColumns: readonly unknown[];
  }) => unknown;
  readonly uuid: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly jsonb: (name: string) => Builder;
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

export const backlinkReportRevisions = pg.pgTable(
  "backlink_report_revisions",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    reportKey: pg.text("report_key").notNull(),
    revision: pg.integer("revision").notNull(),
    inputSnapshotIds: pg.jsonb("input_snapshot_ids").notNull(),
    metricDefinitionVersions: pg
      .jsonb("metric_definition_versions")
      .notNull(),
    querySpec: pg.jsonb("query_spec").notNull(),
    reportPayload: pg.jsonb("report_payload").notNull(),
    sourceStartedAt: timestamp("source_started_at").notNull(),
    sourceEndedAt: timestamp("source_ended_at").notNull(),
    sourceWatermarkAt: timestamp("source_watermark_at").notNull(),
    sourceWatermarkId: pg.text("source_watermark_id").notNull(),
    inputChecksum: pg.text("input_checksum").notNull(),
    resultChecksum: pg.text("result_checksum").notNull(),
    generatedAt: timestamp("generated_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_report_revision_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.reportKey,
      table.revision,
    ),
    pg.uniqueIndex("backlink_report_revision_number_uq").on(
      ...identity(table),
      table.reportKey,
      table.revision,
    ),
  ],
);

export const backlinkReportPublications = pg.pgTable(
  "backlink_report_publications",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    reportKey: pg.text("report_key").notNull(),
    reportRevisionId: pg.uuid("report_revision_id").notNull(),
    reportRevision: pg.integer("report_revision").notNull(),
    publishedAt: timestamp("published_at").notNull(),
    publishedBy: pg.text("published_by").notNull(),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_report_publication_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_report_publication_report_uq").on(
      ...identity(table),
      table.reportKey,
    ),
    pg.foreignKey({
      name: "backlink_report_publication_revision_fk",
      columns: [
        ...identity(table),
        table.reportRevisionId,
        table.reportKey,
        table.reportRevision,
      ],
      foreignColumns: [
        ...identity(backlinkReportRevisions),
        backlinkReportRevisions.id,
        backlinkReportRevisions.reportKey,
        backlinkReportRevisions.revision,
      ],
    }),
  ],
);
