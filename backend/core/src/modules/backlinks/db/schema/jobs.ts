import { createRequire } from "node:module";
import { projectIdentityColumns, versionedProjectAuditColumns } from "./common.js";

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
  readonly text: (name: string) => Builder;
  readonly integer: (name: string) => Builder;
  readonly jsonb: (name: string) => Builder;
  readonly timestamp: (
    name: string,
    config: { readonly mode: "date"; readonly withTimezone: true },
  ) => Builder;
};
export const backlinkJobStatuses = [
  "queued", "running", "waiting_provider", "partial_success",
  "success", "failed", "cancelled",
] as const;

const timestamp = (name: string) =>
  pg.timestamp(name, { mode: "date", withTimezone: true });
const foreignKey = (name: string, column: unknown, foreignColumn: unknown) =>
  pg.foreignKey({ name, columns: [column], foreignColumns: [foreignColumn] });
const eventIdentityColumns = () => ({
  id: pg.uuid("id").primaryKey(),
  ...projectIdentityColumns(),
  eventSchemaVersion: pg.integer("event_schema_version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const backlinkJobs = pg.pgTable(
  "backlink_jobs",
  {
    id: pg.uuid("id").primaryKey(),
    ...versionedProjectAuditColumns(),
    jobType: pg.text("job_type").notNull(),
    sourceObjectType: pg.text("source_object_type").notNull(),
    sourceObjectId: pg.uuid("source_object_id").notNull(),
    status: pg.text("status").notNull().default("queued"),
    step: pg.text("step"),
    progress: pg.integer("progress").notNull().default(0),
    workflowId: pg.text("workflow_id").notNull(),
    correlationId: pg.text("correlation_id").notNull(),
    resultSummary: pg.jsonb("result_summary"),
    error: pg.jsonb("error"),
    retryCount: pg.integer("retry_count").notNull().default(0),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    pg.uniqueIndex("backlink_job_workspace_workflow_uq")
      .on(table.workspaceId, table.workflowId),
  ],
);

export const backlinkLifecycleEvents = pg.pgTable(
  "backlink_lifecycle_events",
  {
    ...eventIdentityColumns(),
    jobId: pg.uuid("job_id"),
    aggregateType: pg.text("aggregate_type").notNull(),
    aggregateId: pg.uuid("aggregate_id").notNull(),
    sequence: pg.integer("sequence").notNull(),
    aggregateVersion: pg.integer("aggregate_version").notNull(),
    eventType: pg.text("event_type").notNull(),
    actorType: pg.text("actor_type").notNull(),
    actorId: pg.text("actor_id"),
    beforeState: pg.jsonb("before_state"),
    afterState: pg.jsonb("after_state"),
    reason: pg.text("reason"),
    correlationId: pg.text("correlation_id").notNull(),
    causationId: pg.uuid("causation_id"),
    idempotencyKey: pg.text("idempotency_key").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_lifecycle_aggregate_sequence_uq")
      .on(table.workspaceId, table.aggregateType, table.aggregateId, table.sequence),
    pg.uniqueIndex("backlink_lifecycle_workspace_idempotency_uq")
      .on(table.workspaceId, table.idempotencyKey),
    foreignKey("backlink_lifecycle_job_fk", table.jobId, backlinkJobs.id),
  ],
);

export const backlinkAuditEvents = pg.pgTable(
  "backlink_audit_events",
  {
    ...eventIdentityColumns(),
    jobId: pg.uuid("job_id"),
    lifecycleEventId: pg.uuid("lifecycle_event_id"),
    actorId: pg.text("actor_id"),
    actorKind: pg.text("actor_kind").notNull(),
    action: pg.text("action").notNull(),
    targetType: pg.text("target_type").notNull(),
    targetId: pg.uuid("target_id").notNull(),
    outcome: pg.text("outcome").notNull(),
    reason: pg.text("reason"),
    beforeRedacted: pg.jsonb("before_redacted"),
    afterRedacted: pg.jsonb("after_redacted"),
    requestId: pg.text("request_id").notNull(),
    correlationId: pg.text("correlation_id").notNull(),
    previousIntegrityHash: pg.text("previous_integrity_hash"),
    integrityHash: pg.text("integrity_hash").notNull(),
  },
  (table) => [
    foreignKey("backlink_audit_job_fk", table.jobId, backlinkJobs.id),
    foreignKey(
      "backlink_audit_lifecycle_event_fk",
      table.lifecycleEventId,
      backlinkLifecycleEvents.id,
    ),
  ],
);
