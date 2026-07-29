import { createRequire } from "node:module";
import { projectIdentityColumns, versionedProjectAuditColumns } from "./common.js";
import { backlinkRecommendations } from "./recommendations.js";
type Builder = { notNull(): Builder; primaryKey(): unknown; default(value: unknown): unknown;
  defaultNow(): unknown };
type Table = Readonly<Record<string, unknown>>;
const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (name: string, columns: Record<string, unknown>,
    extra: (table: Table) => readonly unknown[]) => Table;
  readonly uniqueIndex: (name: string) => { on(...columns: readonly unknown[]): unknown };
  readonly foreignKey: (config: { readonly name: string;
    readonly columns: readonly unknown[]; readonly foreignColumns: readonly unknown[];
  }) => unknown;
  readonly uuid: (name: string) => Builder; readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly timestamp: (name: string, config: {
    readonly mode: "date"; readonly withTimezone: true }) => Builder;
};
const identity = (table: Table) => [
  table.organizationId, table.workspaceId, table.websiteProjectId,
] as const;
const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });
export const backlinkOpportunities = pg.pgTable(
  "backlink_opportunities",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    recommendationId: pg.uuid("recommendation_id").notNull(),
    prospectId: pg.uuid("prospect_id").notNull(),
    recommendationContextVersionId: pg.uuid("recommendation_context_version_id").notNull(),
    targetSiteKey: pg.text("target_site_key").notNull(),
    targetHostAscii: pg.text("target_host_ascii").notNull(),
    targetIdentityKind: pg.text("target_identity_kind").notNull()
      .default("registrable_domain"),
    targetIdentityRuleVersion: pg.text("target_identity_rule_version").notNull(),
    targetIdentityOverrideReason: pg.text("target_identity_override_reason"),
    joinSequence: pg.integer("join_sequence").notNull(),
    businessStage: pg.text("business_stage").notNull().default("JOINED"),
    managementStatus: pg.text("management_status").notNull().default("ACTIVE"),
    outcomeStatus: pg.text("outcome_status").notNull().default("OPEN"),
    fulfillmentStatus: pg.text("fulfillment_status").notNull()
      .default("NOT_EXPECTED"),
  },
  (table) => [
    pg.uniqueIndex("backlink_opportunity_tenant_identity_uq")
      .on(...identity(table), table.id),
    pg.uniqueIndex("backlink_opportunity_project_target_site_uq").on(
      table.websiteProjectId, table.targetSiteKey,
    ),
    pg.uniqueIndex("backlink_opportunity_project_join_sequence_uq").on(
      table.websiteProjectId, table.joinSequence,
    ),
    pg.foreignKey({
      name: "backlink_opportunity_recommendation_fk",
      columns: [
        ...identity(table), table.recommendationId, table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendations), backlinkRecommendations.id,
        backlinkRecommendations.prospectId,
        backlinkRecommendations.recommendationContextVersionId,
      ],
    }),
  ],
);
export const backlinkOpportunityCycles = pg.pgTable(
  "backlink_opportunity_cycles",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    cycleNumber: pg.integer("cycle_number").notNull(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    closeReason: pg.text("close_reason"),
  },
  (table) => [
    pg.uniqueIndex("backlink_opportunity_cycle_number_uq")
      .on(table.opportunityId, table.cycleNumber),
    pg.foreignKey({
      name: "backlink_opportunity_cycle_parent_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [...identity(backlinkOpportunities), backlinkOpportunities.id],
    }),
  ],
);
export const backlinkOpportunityCooperationTypes = pg.pgTable(
  "backlink_opportunity_cooperation_types",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    methodKey: pg.text("method_key").notNull(),
    registryVersion: pg.text("registry_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_opportunity_cooperation_method_uq").on(
      table.opportunityId, table.methodKey,
    ),
    pg.foreignKey({
      name: "backlink_opportunity_cooperation_parent_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [...identity(backlinkOpportunities), backlinkOpportunities.id],
    }),
  ],
);
