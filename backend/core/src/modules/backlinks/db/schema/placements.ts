import { createRequire } from "node:module";

import { projectIdentityColumns } from "./common.js";
import { backlinkReplyMatchCandidates } from "./mail-sync.js";
import { backlinkOpportunities } from "./opportunities.js";

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

export const backlinkPlacementCandidates = pg.pgTable(
  "backlink_placement_candidates",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    opportunityId: pg.uuid("opportunity_id"),
    replyId: pg.uuid("reply_id"),
    plannedPlacementId: pg.uuid("planned_placement_id").notNull(),
    sourceType: pg.text("source_type").notNull(),
    sourceExternalId: pg.text("source_external_id"),
    sourcePageUrl: pg.text("source_page_url"),
    normalizedSourceUrl: pg.text("normalized_source_url"),
    normalizedSourceUrlHash: pg.text("normalized_source_url_hash"),
    targetUrl: pg.text("target_url").notNull(),
    normalizedTargetUrl: pg.text("normalized_target_url").notNull(),
    normalizedTargetUrlHash: pg.text("normalized_target_url_hash").notNull(),
    urlNormalizationVersion: pg.text("url_normalization_version").notNull(),
    status: pg.text("status").notNull().default("PENDING_MATCH"),
    matchStatus: pg.text("match_status").notNull().default("UNMATCHED"),
    initialValidationStatus: pg
      .text("initial_validation_status")
      .notNull()
      .default("PENDING"),
    discoveryEvidenceSnapshot: pg
      .jsonb("discovery_evidence_snapshot")
      .notNull(),
    discoveryEvidenceHash: pg.text("discovery_evidence_hash").notNull(),
    evidenceContractVersion: pg.text("evidence_contract_version").notNull(),
    evidenceSchemaVersion: pg.integer("evidence_schema_version").notNull(),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_placement_candidate_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_placement_candidate_match_identity_uq").on(
      ...identity(table),
      table.id,
      table.opportunityId,
    ),
    pg.uniqueIndex("backlink_placement_candidate_full_lineage_uq").on(
      ...identity(table),
      table.id,
      table.opportunityId,
      table.replyId,
      table.plannedPlacementId,
    ),
    pg.foreignKey({
      name: "backlink_placement_candidate_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_candidate_reply_assignment_fk",
      columns: [
        ...identity(table),
        table.replyId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkReplyMatchCandidates),
        backlinkReplyMatchCandidates.inboundMessageId,
        backlinkReplyMatchCandidates.opportunityId,
      ],
    }),
  ],
);

export const backlinkPlacementValidationRuns = pg.pgTable(
  "backlink_placement_validation_runs",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    candidateId: pg.uuid("candidate_id").notNull(),
    opportunityId: pg.uuid("opportunity_id"),
    runNumber: pg.integer("run_number").notNull(),
    validationMethod: pg.text("validation_method").notNull(),
    status: pg.text("status").notNull(),
    sourcePageUrl: pg.text("source_page_url").notNull(),
    normalizedSourceUrl: pg.text("normalized_source_url").notNull(),
    normalizedSourceUrlHash: pg
      .text("normalized_source_url_hash")
      .notNull(),
    targetUrl: pg.text("target_url").notNull(),
    normalizedTargetUrl: pg.text("normalized_target_url").notNull(),
    normalizedTargetUrlHash: pg.text("normalized_target_url_hash").notNull(),
    urlNormalizationVersion: pg.text("url_normalization_version").notNull(),
    evidenceSnapshot: pg.jsonb("evidence_snapshot").notNull(),
    evidenceSnapshotHash: pg.text("evidence_snapshot_hash").notNull(),
    evidenceContractVersion: pg.text("evidence_contract_version").notNull(),
    evidenceSchemaVersion: pg.integer("evidence_schema_version").notNull(),
    evidenceObservedAt: timestamp("evidence_observed_at").notNull(),
    verifiedBy: pg.text("verified_by").notNull(),
    verifiedAt: timestamp("verified_at").notNull(),
    auditEventId: pg.text("audit_event_id").notNull(),
    initialEvidenceRef: pg.text("initial_evidence_ref").notNull(),
    manualConfirmationReason: pg.text("manual_confirmation_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_placement_validation_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_placement_validation_run_number_uq").on(
      ...identity(table),
      table.candidateId,
      table.runNumber,
    ),
    pg.uniqueIndex("backlink_placement_validation_initial_evidence_uq").on(
      ...identity(table),
      table.id,
      table.candidateId,
      table.opportunityId,
      table.status,
      table.normalizedSourceUrlHash,
      table.normalizedTargetUrlHash,
      table.urlNormalizationVersion,
      table.evidenceSnapshotHash,
      table.evidenceContractVersion,
      table.evidenceSchemaVersion,
    ),
    pg.uniqueIndex(
      "backlink_placement_validation_initial_identity_uq",
    ).on(
      ...identity(table),
      table.id,
      table.candidateId,
      table.status,
      table.normalizedSourceUrlHash,
      table.normalizedTargetUrlHash,
      table.urlNormalizationVersion,
      table.evidenceSnapshotHash,
      table.evidenceContractVersion,
      table.evidenceSchemaVersion,
    ),
    pg.foreignKey({
      name: "backlink_placement_validation_candidate_identity_fk",
      columns: [
        ...identity(table),
        table.candidateId,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementCandidates),
        backlinkPlacementCandidates.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_validation_candidate_fk",
      columns: [
        ...identity(table),
        table.candidateId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementCandidates),
        backlinkPlacementCandidates.id,
        backlinkPlacementCandidates.opportunityId,
      ],
    }),
  ],
);

export const backlinkPlacements = pg.pgTable(
  "backlink_placements",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    candidateId: pg.uuid("candidate_id").notNull(),
    opportunityId: pg.uuid("opportunity_id"),
    replyId: pg.uuid("reply_id"),
    initialValidationId: pg.uuid("initial_validation_id").notNull(),
    initialValidationStatus: pg.text("initial_validation_status").notNull(),
    sourcePageUrl: pg.text("source_page_url").notNull(),
    normalizedSourceUrl: pg.text("normalized_source_url").notNull(),
    normalizedSourceUrlHash: pg
      .text("normalized_source_url_hash")
      .notNull(),
    targetUrl: pg.text("target_url").notNull(),
    normalizedTargetUrl: pg.text("normalized_target_url").notNull(),
    normalizedTargetUrlHash: pg.text("normalized_target_url_hash").notNull(),
    urlNormalizationVersion: pg.text("url_normalization_version").notNull(),
    initialEvidenceSnapshotHash: pg
      .text("initial_evidence_snapshot_hash")
      .notNull(),
    evidenceContractVersion: pg.text("evidence_contract_version").notNull(),
    initialEvidenceSchemaVersion: pg
      .integer("initial_evidence_schema_version")
      .notNull(),
    healthStatus: pg.text("health_status").notNull().default("active"),
    monitoringStatus: pg
      .text("monitoring_status")
      .notNull()
      .default("enabled"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_placement_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_placement_project_urls_uq").on(
      table.websiteProjectId,
      table.normalizedSourceUrlHash,
      table.normalizedTargetUrlHash,
    ),
    pg.foreignKey({
      name: "backlink_placement_candidate_identity_fk",
      columns: [
        ...identity(table),
        table.candidateId,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementCandidates),
        backlinkPlacementCandidates.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_candidate_fk",
      columns: [
        ...identity(table),
        table.candidateId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementCandidates),
        backlinkPlacementCandidates.id,
        backlinkPlacementCandidates.opportunityId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_full_lineage_fk",
      columns: [
        ...identity(table),
        table.candidateId,
        table.opportunityId,
        table.replyId,
        table.id,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementCandidates),
        backlinkPlacementCandidates.id,
        backlinkPlacementCandidates.opportunityId,
        backlinkPlacementCandidates.replyId,
        backlinkPlacementCandidates.plannedPlacementId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_initial_validation_fk",
      columns: [
        ...identity(table),
        table.initialValidationId,
        table.candidateId,
        table.opportunityId,
        table.initialValidationStatus,
        table.normalizedSourceUrlHash,
        table.normalizedTargetUrlHash,
        table.urlNormalizationVersion,
        table.initialEvidenceSnapshotHash,
        table.evidenceContractVersion,
        table.initialEvidenceSchemaVersion,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementValidationRuns),
        backlinkPlacementValidationRuns.id,
        backlinkPlacementValidationRuns.candidateId,
        backlinkPlacementValidationRuns.opportunityId,
        backlinkPlacementValidationRuns.status,
        backlinkPlacementValidationRuns.normalizedSourceUrlHash,
        backlinkPlacementValidationRuns.normalizedTargetUrlHash,
        backlinkPlacementValidationRuns.urlNormalizationVersion,
        backlinkPlacementValidationRuns.evidenceSnapshotHash,
        backlinkPlacementValidationRuns.evidenceContractVersion,
        backlinkPlacementValidationRuns.evidenceSchemaVersion,
      ],
    }),
    pg.foreignKey({
      name: "backlink_placement_initial_validation_identity_fk",
      columns: [
        ...identity(table),
        table.initialValidationId,
        table.candidateId,
        table.initialValidationStatus,
        table.normalizedSourceUrlHash,
        table.normalizedTargetUrlHash,
        table.urlNormalizationVersion,
        table.initialEvidenceSnapshotHash,
        table.evidenceContractVersion,
        table.initialEvidenceSchemaVersion,
      ],
      foreignColumns: [
        ...identity(backlinkPlacementValidationRuns),
        backlinkPlacementValidationRuns.id,
        backlinkPlacementValidationRuns.candidateId,
        backlinkPlacementValidationRuns.status,
        backlinkPlacementValidationRuns.normalizedSourceUrlHash,
        backlinkPlacementValidationRuns.normalizedTargetUrlHash,
        backlinkPlacementValidationRuns.urlNormalizationVersion,
        backlinkPlacementValidationRuns.evidenceSnapshotHash,
        backlinkPlacementValidationRuns.evidenceContractVersion,
        backlinkPlacementValidationRuns.evidenceSchemaVersion,
      ],
    }),
  ],
);
