import { createRequire } from "node:module";

import { projectIdentityColumns } from "./common.js";
import { backlinkInboundMessages } from "./mail-sync.js";
import { backlinkOpportunities } from "./opportunities.js";

type Builder = {
  notNull(): Builder;
  primaryKey(): unknown;
  default(value: unknown): unknown;
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

export const backlinkReplyClassificationVersions = pg.pgTable(
  "backlink_reply_classification_versions",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    inboundMessageId: pg.uuid("inbound_message_id").notNull(),
    classificationVersion: pg.integer("classification_version").notNull(),
    classificationCode: pg.text("classification_code").notNull(),
    classifierType: pg.text("classifier_type").notNull(),
    classifierVersion: pg.text("classifier_version").notNull(),
    confidenceScore: pg.numeric("confidence_score", {
      precision: 5,
      scale: 4,
    }).notNull(),
    evidence: pg.jsonb("evidence").notNull().default([]),
    classifiedAt: timestamp("classified_at").notNull(),
    schemaVersion: pg.integer("schema_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_reply_classification_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_reply_classification_version_uq").on(
      ...identity(table),
      table.inboundMessageId,
      table.classificationVersion,
    ),
    pg.foreignKey({
      name: "backlink_reply_classification_inbound_fk",
      columns: [...identity(table), table.inboundMessageId],
      foreignColumns: [
        ...identity(backlinkInboundMessages),
        backlinkInboundMessages.id,
      ],
    }),
  ],
);

export const backlinkNegotiationFactVersions = pg.pgTable(
  "backlink_negotiation_fact_versions",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    inboundMessageId: pg.uuid("inbound_message_id").notNull(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    factKey: pg.text("fact_key").notNull(),
    factVersion: pg.integer("fact_version").notNull(),
    factType: pg.text("fact_type").notNull(),
    rawValue: pg.text("raw_value").notNull(),
    normalizedValue: pg.jsonb("normalized_value").notNull(),
    factAuthority: pg.text("fact_authority").notNull(),
    reviewStatus: pg.text("review_status").notNull(),
    extractorType: pg.text("extractor_type").notNull(),
    extractorVersion: pg.text("extractor_version").notNull(),
    confidenceScore: pg.numeric("confidence_score", {
      precision: 5,
      scale: 4,
    }).notNull(),
    evidenceText: pg.text("evidence_text").notNull(),
    evidenceStart: pg.integer("evidence_start").notNull(),
    evidenceEnd: pg.integer("evidence_end").notNull(),
    supersedesFactVersionId: pg.uuid("supersedes_fact_version_id"),
    decidedBy: pg.text("decided_by"),
    decidedAt: timestamp("decided_at"),
    schemaVersion: pg.integer("schema_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_negotiation_fact_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_negotiation_fact_version_uq").on(
      ...identity(table),
      table.opportunityId,
      table.factKey,
      table.factVersion,
    ),
    pg.foreignKey({
      name: "backlink_negotiation_fact_inbound_fk",
      columns: [...identity(table), table.inboundMessageId],
      foreignColumns: [
        ...identity(backlinkInboundMessages),
        backlinkInboundMessages.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_negotiation_fact_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_negotiation_fact_supersedes_fk",
      columns: [...identity(table), table.supersedesFactVersionId],
      foreignColumns: [...identity(table), table.id],
    }),
  ],
);
