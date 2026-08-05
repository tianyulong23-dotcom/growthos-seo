import { createRequire } from "node:module";
import { projectIdentityColumns } from "./common.js";
import { backlinkContacts } from "./contacts.js";
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
  readonly boolean: (name: string) => Builder;
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

export const backlinkEvidenceSnapshots = pg.pgTable(
  "backlink_evidence_snapshots",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    evidenceItems: pg.jsonb("evidence_items").notNull(),
    snapshotHash: pg.text("snapshot_hash").notNull(),
    schemaVersion: pg.integer("schema_version").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_evidence_snapshot_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.opportunityId,
    ),
    pg.uniqueIndex("backlink_evidence_snapshot_content_uq").on(
      ...identity(table),
      table.opportunityId,
      table.snapshotHash,
    ),
    pg.foreignKey({
      name: "backlink_evidence_snapshot_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
  ],
);

export const backlinkEmailDrafts = pg.pgTable(
  "backlink_email_drafts",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    contactId: pg.uuid("contact_id"),
    contactVersion: pg.integer("contact_version"),
    logicalDraftKey: pg.text("logical_draft_key").notNull(),
    status: pg.text("status").notNull().default("generating"),
    version: pg.integer("version").notNull().default(1),
    currentVersionId: pg.uuid("current_version_id"),
    approvedVersionId: pg.uuid("approved_version_id"),
    lastSuccessfulVersionId: pg.uuid("last_successful_version_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_email_draft_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.opportunityId,
    ),
    pg.uniqueIndex("backlink_email_draft_logical_key_uq").on(
      table.workspaceId,
      table.logicalDraftKey,
    ),
    pg.foreignKey({
      name: "backlink_email_draft_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_email_draft_contact_fk",
      columns: [...identity(table), table.contactId],
      foreignColumns: [...identity(backlinkContacts), backlinkContacts.id],
    }),
    pg.foreignKey({
      name: "backlink_email_draft_current_version_fk",
      columns: [
        ...identity(table),
        table.currentVersionId,
        table.id,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkDraftVersions),
        backlinkDraftVersions.id,
        backlinkDraftVersions.draftId,
        backlinkDraftVersions.opportunityId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_email_draft_approved_version_fk",
      columns: [
        ...identity(table),
        table.approvedVersionId,
        table.id,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkDraftVersions),
        backlinkDraftVersions.id,
        backlinkDraftVersions.draftId,
        backlinkDraftVersions.opportunityId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_email_draft_last_successful_version_fk",
      columns: [
        ...identity(table),
        table.lastSuccessfulVersionId,
        table.id,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkDraftVersions),
        backlinkDraftVersions.id,
        backlinkDraftVersions.draftId,
        backlinkDraftVersions.opportunityId,
      ],
    }),
  ],
);

export const backlinkModelRuns = pg.pgTable(
  "backlink_model_runs",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    draftId: pg.uuid("draft_id").notNull(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    contactId: pg.uuid("contact_id"),
    contactVersion: pg.integer("contact_version"),
    evidenceSnapshotId: pg.uuid("evidence_snapshot_id").notNull(),
    idempotencyKey: pg.text("idempotency_key").notNull(),
    requestHash: pg.text("request_hash").notNull(),
    status: pg.text("status").notNull().default("QUEUED"),
    providerRef: pg.text("provider_ref"),
    modelId: pg.text("model_id"),
    modelVersion: pg.text("model_version"),
    promptVersion: pg.text("prompt_version").notNull(),
    outputSchemaVersion: pg.text("output_schema_version").notNull(),
    baseDraftVersion: pg.integer("base_draft_version").notNull().default(1),
    inputTokens: pg.integer("input_tokens"),
    outputTokens: pg.integer("output_tokens"),
    estimatedCostUsd: pg.numeric("estimated_cost_usd", {
      precision: 14,
      scale: 6,
    }),
    latencyMs: pg.integer("latency_ms"),
    attemptCount: pg.integer("attempt_count").notNull().default(0),
    repairCount: pg.integer("repair_count").notNull().default(0),
    errorClass: pg.text("error_class"),
    errorCode: pg.text("error_code"),
    qualityResult: pg.jsonb("quality_result").notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_model_run_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.draftId,
      table.opportunityId,
      table.evidenceSnapshotId,
    ),
    pg.uniqueIndex("backlink_model_run_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    pg.foreignKey({
      name: "backlink_model_run_draft_fk",
      columns: [
        ...identity(table),
        table.draftId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkEmailDrafts),
        backlinkEmailDrafts.id,
        backlinkEmailDrafts.opportunityId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_model_run_contact_fk",
      columns: [...identity(table), table.contactId],
      foreignColumns: [...identity(backlinkContacts), backlinkContacts.id],
    }),
    pg.foreignKey({
      name: "backlink_model_run_evidence_snapshot_fk",
      columns: [
        ...identity(table),
        table.evidenceSnapshotId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkEvidenceSnapshots),
        backlinkEvidenceSnapshots.id,
        backlinkEvidenceSnapshots.opportunityId,
      ],
    }),
  ],
);

export const backlinkDraftVersions = pg.pgTable(
  "backlink_draft_versions",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    draftId: pg.uuid("draft_id").notNull(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    contactId: pg.uuid("contact_id"),
    contactVersion: pg.integer("contact_version"),
    versionNo: pg.integer("version_no").notNull(),
    parentVersionId: pg.uuid("parent_version_id"),
    source: pg.text("source").notNull(),
    modelRunId: pg.uuid("model_run_id"),
    evidenceSnapshotId: pg.uuid("evidence_snapshot_id").notNull(),
    subjectText: pg.text("subject_text").notNull(),
    bodyText: pg.text("body_text").notNull(),
    bodyDocument: pg.jsonb("body_document"),
    structuredOutput: pg.jsonb("structured_output").notNull(),
    evidenceIds: pg.jsonb("evidence_ids").notNull(),
    promptVersion: pg.text("prompt_version").notNull(),
    outputSchemaVersion: pg.text("output_schema_version").notNull(),
    modelId: pg.text("model_id"),
    modelVersion: pg.text("model_version"),
    requiresUserConfirmation: pg
      .boolean("requires_user_confirmation")
      .notNull()
      .default(true),
    canAutoSend: pg.boolean("can_auto_send").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_draft_version_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.draftId,
      table.opportunityId,
    ),
    pg.uniqueIndex("backlink_draft_version_number_uq").on(
      ...identity(table),
      table.draftId,
      table.versionNo,
    ),
    pg.foreignKey({
      name: "backlink_draft_version_draft_fk",
      columns: [
        ...identity(table),
        table.draftId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkEmailDrafts),
        backlinkEmailDrafts.id,
        backlinkEmailDrafts.opportunityId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_draft_version_contact_fk",
      columns: [...identity(table), table.contactId],
      foreignColumns: [...identity(backlinkContacts), backlinkContacts.id],
    }),
    pg.foreignKey({
      name: "backlink_draft_version_parent_fk",
      columns: [
        ...identity(table),
        table.parentVersionId,
        table.draftId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkDraftVersions),
        backlinkDraftVersions.id,
        backlinkDraftVersions.draftId,
        backlinkDraftVersions.opportunityId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_draft_version_model_run_fk",
      columns: [
        ...identity(table),
        table.modelRunId,
        table.draftId,
        table.opportunityId,
        table.evidenceSnapshotId,
      ],
      foreignColumns: [
        ...identity(backlinkModelRuns),
        backlinkModelRuns.id,
        backlinkModelRuns.draftId,
        backlinkModelRuns.opportunityId,
        backlinkModelRuns.evidenceSnapshotId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_draft_version_evidence_snapshot_fk",
      columns: [
        ...identity(table),
        table.evidenceSnapshotId,
        table.opportunityId,
      ],
      foreignColumns: [
        ...identity(backlinkEvidenceSnapshots),
        backlinkEvidenceSnapshots.id,
        backlinkEvidenceSnapshots.opportunityId,
      ],
    }),
  ],
);
