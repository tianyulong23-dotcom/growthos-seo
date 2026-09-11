import { createRequire } from "node:module";
import {
  projectIdentityColumns,
  versionedProjectAuditColumns,
} from "./common.js";
import { backlinkJobs } from "./jobs.js";
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
    extraConfig: (table: Table) => readonly unknown[],
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
  readonly boolean: (name: string) => Builder;
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly jsonb: (name: string) => Builder;
  readonly numeric: (
    name: string,
    config: {
      readonly precision: number;
      readonly scale: number;
    },
  ) => Builder;
  readonly timestamp: (
    name: string,
    config: {
      readonly mode: "date";
      readonly withTimezone: true;
    },
  ) => Builder;
};
const identity = (table: Table) =>
  [table.organizationId, table.workspaceId, table.websiteProjectId] as const;
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
  recommendationContextVersionId: pg
    .uuid("recommendation_context_version_id")
    .notNull(),
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
    recommendationContextVersionId: pg
      .uuid("recommendation_context_version_id")
      .notNull(),
    hostnameAscii: pg.text("hostname_ascii").notNull(),
    registrableDomain: pg.text("registrable_domain").notNull(),
    normalizationVersion: pg.text("normalization_version").notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_prospect_context_parent_uq")
      .on(...identity(table), table.id, table.recommendationContextVersionId),
    pg
      .uniqueIndex("backlink_prospect_project_context_hostname_uq")
      .on(
        ...identity(table),
        table.recommendationContextVersionId,
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
    generationContractId: pg.uuid("generation_contract_id"),
    visiblePoolGeneration: pg.integer("visible_pool_generation"),
    inputPinId: pg.uuid("input_pin_id"),
    poolContractVersion: pg.text("pool_contract_version"),
    materializationContractVersion: pg.text("materialization_contract_version"),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_recommendation_prospect_context_uq")
      .on(
        ...identity(table),
        table.prospectId,
        table.recommendationContextVersionId,
      ),
    pg
      .uniqueIndex("backlink_recommendation_score_parent_uq")
      .on(
        ...identity(table),
        table.id,
        table.prospectId,
        table.recommendationContextVersionId,
      ),
    pg.foreignKey({
      name: "backlink_recommendation_prospect_fk",
      columns: [
        ...identity(table),
        table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkProspects),
        backlinkProspects.id,
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
    totalScore: pg
      .numeric("total_score", {
        precision: 7,
        scale: 4,
      })
      .notNull(),
    components: pg.jsonb("components").notNull(),
    weights: pg.jsonb("weights").notNull(),
    evidence: pg.jsonb("evidence").notNull(),
    generatedAt: pg
      .timestamp("generated_at", {
        mode: "date",
        withTimezone: true,
      })
      .notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_recommendation_score_tenant_identity_uq")
      .on(...identity(table), table.id),
    pg.foreignKey({
      name: "backlink_recommendation_score_parent_fk",
      columns: [
        ...identity(table),
        table.recommendationId,
        table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendations),
        backlinkRecommendations.id,
        backlinkRecommendations.prospectId,
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
    pg
      .uniqueIndex("backlink_rec_inventory_recommendation_context_uq")
      .on(
        ...identity(table),
        table.recommendationId,
        table.recommendationContextVersionId,
      ),
    pg
      .uniqueIndex("backlink_rec_inventory_parent_uq")
      .on(
        ...identity(table),
        table.id,
        table.recommendationId,
        table.prospectId,
        table.recommendationContextVersionId,
      ),
    pg.foreignKey({
      name: "backlink_rec_inventory_recommendation_fk",
      columns: [
        ...identity(table),
        table.recommendationId,
        table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendations),
        backlinkRecommendations.id,
        backlinkRecommendations.prospectId,
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
    pg
      .uniqueIndex("backlink_rec_claim_inventory_uq")
      .on(...identity(table), table.inventoryId),
    pg
      .uniqueIndex("backlink_rec_claim_token_uq")
      .on(table.workspaceId, table.claimToken),
    pg.foreignKey({
      name: "backlink_rec_claim_inventory_fk",
      columns: [
        ...identity(table),
        table.inventoryId,
        table.recommendationId,
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
        ...identity(table),
        table.inventoryId,
        table.recommendationId,
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
    recommendationContextVersionId: pg
      .uuid("recommendation_context_version_id")
      .notNull(),
    triggerReason: pg.text("trigger_reason").notNull(),
    lowWatermark: pg.integer("low_watermark").notNull(),
    highWatermark: pg.integer("high_watermark").notNull(),
    refillWindowKey: pg.text("refill_window_key").notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_rec_refill_job_uq")
      .on(...identity(table), table.jobId),
    pg
      .uniqueIndex("backlink_rec_refill_window_uq")
      .on(
        ...identity(table),
        table.recommendationContextVersionId,
        table.refillWindowKey,
      ),
    pg.foreignKey({
      name: "backlink_rec_refill_job_fk",
      columns: [...identity(table), table.jobId],
      foreignColumns: [...identity(backlinkJobs), backlinkJobs.id],
    }),
  ],
);

export const backlinkRecommendationGenerationCandidates = pg.pgTable(
  "backlink_recommendation_generation_candidates",
  {
    ...createdColumns(),
    generationContractId: pg.uuid("generation_contract_id").notNull(),
    recommendationContextVersionId: pg
      .uuid("recommendation_context_version_id")
      .notNull(),
    visiblePoolGeneration: pg.integer("visible_pool_generation").notNull(),
    inputPinId: pg.uuid("input_pin_id").notNull(),
    poolContractVersion: pg.text("pool_contract_version").notNull(),
    canonicalDomain: pg.text("canonical_domain").notNull(),
    admissionState: pg.text("admission_state").notNull(),
    admissionContractVersion: pg.text("admission_contract_version").notNull(),
    exclusionReasonCode: pg.text("exclusion_reason_code"),
    exclusionEvidence: pg.jsonb("exclusion_evidence").notNull(),
    decisionEvidence: pg.jsonb("decision_evidence").notNull(),
    firstSeenRequestIntent: pg.text("first_seen_request_intent").notNull(),
    recommended: pg.boolean("recommended").notNull(),
    recommendationReasonCodes: pg
      .jsonb("recommendation_reason_codes")
      .notNull(),
    firstSeenAt: timestamp("first_seen_at").notNull(),
    admittedAt: timestamp("admitted_at"),
    excludedAt: timestamp("excluded_at"),
    decidedAt: timestamp("decided_at").notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_generation_candidate_scope_id_uq")
      .on(...identity(table), table.id),
    pg
      .uniqueIndex("backlink_generation_candidate_domain_uq")
      .on(
        ...identity(table),
        table.generationContractId,
        table.canonicalDomain,
      ),
  ],
);

export const backlinkRecommendationGenerationCandidateSources = pg.pgTable(
  "backlink_recommendation_generation_candidate_sources",
  {
    ...createdColumns(),
    generationCandidateId: pg.uuid("generation_candidate_id").notNull(),
    requestIntent: pg.text("request_intent").notNull(),
    providerOutcome: pg.text("provider_outcome").notNull(),
    sourceType: pg.text("source_type").notNull(),
    discoveredUrl: pg.text("discovered_url").notNull(),
    sourceRef: pg.text("source_ref").notNull(),
    evidencePayload: pg.jsonb("evidence_payload").notNull(),
    evidenceFingerprint: pg.text("evidence_fingerprint").notNull(),
    observedAt: timestamp("observed_at").notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_generation_candidate_source_scope_id_uq")
      .on(...identity(table), table.id),
    pg
      .uniqueIndex("backlink_generation_candidate_source_evidence_uq")
      .on(
        ...identity(table),
        table.generationCandidateId,
        table.evidenceFingerprint,
      ),
    pg.foreignKey({
      name: "backlink_generation_candidate_source_candidate_fk",
      columns: [...identity(table), table.generationCandidateId],
      foreignColumns: [
        ...identity(backlinkRecommendationGenerationCandidates),
        backlinkRecommendationGenerationCandidates.id,
      ],
    }),
  ],
);

export const backlinkRecommendationCandidateMetricSnapshots = pg.pgTable(
  "backlink_recommendation_candidate_metric_snapshots",
  {
    ...createdColumns(),
    generationCandidateId: pg.uuid("generation_candidate_id").notNull(),
    metricType: pg.text("metric_type").notNull(),
    valueState: pg.text("value_state").notNull(),
    provider: pg.text("provider").notNull(),
    endpoint: pg.text("endpoint").notNull(),
    market: pg.text("market").notNull(),
    location: pg.text("location").notNull(),
    language: pg.text("language").notNull(),
    requestIntent: pg.text("request_intent").notNull(),
    metricValue: pg.jsonb("metric_value"),
    requestRef: pg.text("request_ref"),
    artifactRef: pg.text("artifact_ref"),
    evidenceFingerprint: pg.text("evidence_fingerprint").notNull(),
    observedAt: timestamp("observed_at").notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_candidate_metric_scope_id_uq")
      .on(...identity(table), table.id),
    pg
      .uniqueIndex("backlink_candidate_metric_evidence_uq")
      .on(
        ...identity(table),
        table.generationCandidateId,
        table.metricType,
        table.evidenceFingerprint,
      ),
    pg.foreignKey({
      name: "backlink_candidate_metric_candidate_fk",
      columns: [...identity(table), table.generationCandidateId],
      foreignColumns: [
        ...identity(backlinkRecommendationGenerationCandidates),
        backlinkRecommendationGenerationCandidates.id,
      ],
    }),
  ],
);

export const backlinkRecommendationGenerationCandidateLinks = pg.pgTable(
  "backlink_recommendation_generation_candidate_links",
  {
    ...createdColumns(),
    generationCandidateId: pg.uuid("generation_candidate_id").notNull(),
    candidateId: pg.uuid("candidate_id").notNull(),
    recommendationId: pg.uuid("recommendation_id").notNull(),
    prospectId: pg.uuid("prospect_id").notNull(),
    inventoryId: pg.uuid("inventory_id").notNull(),
    recommendationContextVersionId: pg
      .uuid("recommendation_context_version_id")
      .notNull(),
    visiblePoolGeneration: pg.integer("visible_pool_generation").notNull(),
    materializationContractVersion: pg
      .text("materialization_contract_version")
      .notNull(),
    idempotencyFingerprint: pg.text("idempotency_fingerprint").notNull(),
  },
  (table) => [
    pg
      .uniqueIndex("backlink_generation_candidate_link_scope_id_uq")
      .on(...identity(table), table.id),
    pg
      .uniqueIndex("backlink_generation_candidate_link_source_uq")
      .on(...identity(table), table.generationCandidateId),
    pg
      .uniqueIndex("backlink_generation_candidate_link_idempotency_uq")
      .on(...identity(table), table.idempotencyFingerprint),
    pg.foreignKey({
      name: "backlink_generation_candidate_link_source_fk",
      columns: [...identity(table), table.generationCandidateId],
      foreignColumns: [
        ...identity(backlinkRecommendationGenerationCandidates),
        backlinkRecommendationGenerationCandidates.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_generation_candidate_link_recommendation_fk",
      columns: [
        ...identity(table),
        table.recommendationId,
        table.prospectId,
        table.recommendationContextVersionId,
      ],
      foreignColumns: [
        ...identity(backlinkRecommendations),
        backlinkRecommendations.id,
        backlinkRecommendations.prospectId,
        backlinkRecommendations.recommendationContextVersionId,
      ],
    }),
  ],
);
