import { createRequire } from "node:module";
import { projectIdentityColumns, versionedProjectAuditColumns } from "./common.js";
import { backlinkJobs } from "./jobs.js";
type Builder = {
  notNull(): Builder; primaryKey(): unknown; default(value: unknown): unknown;
  defaultNow(): unknown;
};
type Table = Readonly<Record<string, unknown>>;
const require = createRequire(import.meta.url);
const pg = require("drizzle-orm/pg-core") as {
  readonly pgTable: (name: string, columns: Record<string, unknown>,
    extraConfig: (table: Table) => readonly unknown[],
  ) => Table;
  readonly uniqueIndex: (name: string) =>
    { on(...columns: readonly unknown[]): unknown };
  readonly foreignKey: (config: {
    readonly name: string; readonly columns: readonly unknown[];
    readonly foreignColumns: readonly unknown[];
  }) => unknown;
  readonly uuid: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly jsonb: (name: string) => Builder;
  readonly numeric: (name: string, config: {
    readonly precision: number; readonly scale: number }) => Builder;
  readonly timestamp: (
    name: string, config: {
      readonly mode: "date"; readonly withTimezone: true },
  ) => Builder;
};
const identity = (table: Table) => [
  table.organizationId, table.workspaceId, table.websiteProjectId,
] as const;
const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });
const createdColumns = () => ({
  id: pg.uuid("id").primaryKey(),
  ...projectIdentityColumns(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: pg.text("created_by").notNull(),
});
const recommendationReferenceColumns = () => ({
  recommendationId: pg.uuid("recommendation_id").notNull(),
  prospectId: pg.uuid("prospect_id").notNull(),
  recommendationContextVersionId:
    pg.uuid("recommendation_context_version_id").notNull(),
});
const inventoryReferenceColumns = () => ({
  inventoryId: pg.uuid("inventory_id").notNull(),
  ...recommendationReferenceColumns(),
});
export const backlinkProspects = pg.pgTable(
  "backlink_prospects",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    recommendationContextVersionId:
      pg.uuid("recommendation_context_version_id").notNull(),
    hostnameAscii: pg.text("hostname_ascii").notNull(),
    registrableDomain: pg.text("registrable_domain").notNull(),
    normalizationVersion: pg.text("normalization_version").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_prospect_context_parent_uq").on(
      ...identity(table), table.id, table.recommendationContextVersionId,
    ),
    pg.uniqueIndex("backlink_prospect_project_context_hostname_uq").on(
      ...identity(table), table.recommendationContextVersionId,
      table.hostnameAscii,
    ),
  ],
);
export const backlinkRecommendations = pg.pgTable(
  "backlink_recommendations",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    ...recommendationReferenceColumns(),
    status: pg.text("status").notNull().default("evaluating"),
  },
  (table) => [
    pg.uniqueIndex("backlink_recommendation_prospect_context_uq").on(
      ...identity(table), table.prospectId,
      table.recommendationContextVersionId,
    ),
    pg.uniqueIndex("backlink_recommendation_score_parent_uq").on(
      ...identity(table), table.id, table.prospectId,
      table.recommendationContextVersionId,
    ),
    pg.foreignKey({
      name: "backlink_recommendation_prospect_fk",
      columns: [
        ...identity(table), table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkProspects), backlinkProspects.id,
        backlinkProspects.recommendationContextVersionId,
      ],
    }),
  ],
);
export const backlinkRecommendationScores = pg.pgTable(
  "backlink_recommendation_scores",
  {
    ...createdColumns(),
    ...recommendationReferenceColumns(),
    scoreModelVersion: pg.text("score_model_version").notNull(),
    ruleVersion: pg.text("rule_version").notNull(),
    totalScore: pg.numeric("total_score", {
      precision: 7, scale: 4,
    }).notNull(),
    components: pg.jsonb("components").notNull(),
    weights: pg.jsonb("weights").notNull(),
    evidence: pg.jsonb("evidence").notNull(),
    generatedAt: pg.timestamp("generated_at", {
      mode: "date", withTimezone: true,
    }).notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_recommendation_score_tenant_identity_uq").on(
      ...identity(table), table.id,
    ),
    pg.foreignKey({
      name: "backlink_recommendation_score_parent_fk",
      columns: [
        ...identity(table), table.recommendationId, table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendations),
        backlinkRecommendations.id, backlinkRecommendations.prospectId,
        backlinkRecommendations.recommendationContextVersionId,
      ],
    }),
  ],
);
export const backlinkRecommendationInventory = pg.pgTable(
  "backlink_recommendation_inventory",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    ...recommendationReferenceColumns(),
    status: pg.text("status").notNull().default("ready"),
  },
  (table) => [
    pg.uniqueIndex("backlink_rec_inventory_recommendation_context_uq").on(
      ...identity(table), table.recommendationId,
      table.recommendationContextVersionId,
    ),
    pg.uniqueIndex("backlink_rec_inventory_parent_uq").on(
      ...identity(table), table.id, table.recommendationId, table.prospectId,
      table.recommendationContextVersionId,
    ),
    pg.foreignKey({
      name: "backlink_rec_inventory_recommendation_fk",
      columns: [
        ...identity(table), table.recommendationId, table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendations),
        backlinkRecommendations.id, backlinkRecommendations.prospectId,
        backlinkRecommendations.recommendationContextVersionId,
      ],
    }),
  ],
);
export const backlinkRecommendationClaims = pg.pgTable(
  "backlink_recommendation_claims",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    ...inventoryReferenceColumns(),
    status: pg.text("status").notNull().default("active"),
    claimToken: pg.text("claim_token").notNull(),
    claimedBy: pg.text("claimed_by").notNull(),
    claimedAt: timestamp("claimed_at").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    pg.uniqueIndex("backlink_rec_claim_inventory_uq").on(
      ...identity(table), table.inventoryId,
    ),
    pg.uniqueIndex("backlink_rec_claim_token_uq").on(
      table.workspaceId, table.claimToken,
    ),
    pg.foreignKey({
      name: "backlink_rec_claim_inventory_fk",
      columns: [
        ...identity(table), table.inventoryId, table.recommendationId,
        table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendationInventory),
        backlinkRecommendationInventory.id,
        backlinkRecommendationInventory.recommendationId,
        backlinkRecommendationInventory.prospectId,
        backlinkRecommendationInventory.recommendationContextVersionId,
      ],
    }),
  ],
);
export const backlinkRecommendationRejections = pg.pgTable(
  "backlink_recommendation_rejections",
  {
    ...createdColumns(),
    ...inventoryReferenceColumns(),
    rejectionType: pg.text("rejection_type").notNull(),
    reasonCode: pg.text("reason_code").notNull(),
    rejectedAt: timestamp("rejected_at").notNull(),
    cooldownUntil: timestamp("cooldown_until"),
    rejectedBy: pg.text("rejected_by").notNull(),
  },
  (table) => [
    pg.foreignKey({
      name: "backlink_rec_rejection_inventory_fk",
      columns: [
        ...identity(table), table.inventoryId, table.recommendationId,
        table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendationInventory),
        backlinkRecommendationInventory.id,
        backlinkRecommendationInventory.recommendationId,
        backlinkRecommendationInventory.prospectId,
        backlinkRecommendationInventory.recommendationContextVersionId,
      ],
    }),
  ],
);
export const backlinkRecommendationRefills = pg.pgTable(
  "backlink_recommendation_refills",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    jobId: pg.uuid("job_id").notNull(),
    recommendationContextVersionId:
      pg.uuid("recommendation_context_version_id").notNull(),
    triggerReason: pg.text("trigger_reason").notNull(),
    lowWatermark: pg.integer("low_watermark").notNull(),
    highWatermark: pg.integer("high_watermark").notNull(),
    refillWindowKey: pg.text("refill_window_key").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_rec_refill_job_uq").on(
      ...identity(table), table.jobId,
    ),
    pg.uniqueIndex("backlink_rec_refill_window_uq").on(
      ...identity(table), table.recommendationContextVersionId,
      table.refillWindowKey,
    ),
    pg.foreignKey({
      name: "backlink_rec_refill_job_fk",
      columns: [...identity(table), table.jobId],
      foreignColumns: [
        ...identity(backlinkJobs), backlinkJobs.id,
      ],
    }),
  ],
);
