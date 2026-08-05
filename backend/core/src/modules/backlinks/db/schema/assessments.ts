import { createRequire } from "node:module";
import { projectIdentityColumns } from "./common.js";
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
  readonly boolean: (name: string) => Builder;
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

export const backlinkAssessmentRuns = pg.pgTable(
  "backlink_assessment_runs",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    policyVersion: pg.text("policy_version").notNull(),
    evidenceContractVersion: pg.text("evidence_contract_version").notNull(),
    sourceReleaseIds: pg.jsonb("source_release_ids").notNull(),
    inputEvidenceRefs: pg.jsonb("input_evidence_refs").notNull(),
    inputEvidenceHash: pg.text("input_evidence_hash").notNull(),
    status: pg.text("status").notNull().default("QUEUED"),
    attemptCount: pg.integer("attempt_count").notNull().default(0),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    errorCode: pg.text("error_code"),
    lastSuccessfulSnapshotId: pg.uuid("last_successful_snapshot_id"),
    schemaVersion: pg.integer("schema_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_assessment_run_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.opportunityId,
      table.policyVersion,
      table.inputEvidenceHash,
    ),
    pg.uniqueIndex("backlink_assessment_run_input_uq").on(
      ...identity(table),
      table.opportunityId,
      table.policyVersion,
      table.inputEvidenceHash,
    ),
    pg.foreignKey({
      name: "backlink_assessment_run_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_assessment_run_last_success_fk",
      columns: [
        ...identity(table),
        table.lastSuccessfulSnapshotId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkAssessmentSnapshots),
        backlinkAssessmentSnapshots.id,
        backlinkAssessmentSnapshots.opportunityId,
      ],
    }),
  ],
);

export const backlinkAssessmentSnapshots = pg.pgTable(
  "backlink_assessment_snapshots",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    runId: pg.uuid("run_id").notNull(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    policyVersion: pg.text("policy_version").notNull(),
    inputEvidenceHash: pg.text("input_evidence_hash").notNull(),
    snapshotVersion: pg.integer("snapshot_version").notNull(),
    sourceReleaseIds: pg.jsonb("source_release_ids").notNull(),
    availability: pg.text("availability").notNull(),
    confidence: pg.numeric("confidence", {
      precision: 5,
      scale: 4,
    }).notNull(),
    evidenceRefs: pg.jsonb("evidence_refs").notNull(),
    unavailableReason: pg.text("unavailable_reason"),
    stale: pg.boolean("stale").notNull().default(false),
    resultPayload: pg.jsonb("result_payload").notNull(),
    resultHash: pg.text("result_hash").notNull(),
    generatedAt: timestamp("generated_at").notNull(),
    schemaVersion: pg.integer("schema_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_assessment_snapshot_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.opportunityId,
    ),
    pg.uniqueIndex("backlink_assessment_snapshot_run_uq").on(
      ...identity(table),
      table.runId,
    ),
    pg.uniqueIndex("backlink_assessment_snapshot_version_uq").on(
      ...identity(table),
      table.opportunityId,
      table.snapshotVersion,
    ),
    pg.foreignKey({
      name: "backlink_assessment_snapshot_run_fk",
      columns: [
        ...identity(table),
        table.runId,
        table.opportunityId,
        table.policyVersion,
        table.inputEvidenceHash,
      ],
      foreignColumns: [
        ...identity(backlinkAssessmentRuns),
        backlinkAssessmentRuns.id,
        backlinkAssessmentRuns.opportunityId,
        backlinkAssessmentRuns.policyVersion,
        backlinkAssessmentRuns.inputEvidenceHash,
      ],
    }),
  ],
);
