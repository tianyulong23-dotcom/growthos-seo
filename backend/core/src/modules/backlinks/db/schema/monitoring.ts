import { createRequire } from "node:module";

import { projectIdentityColumns } from "./common.js";
import { backlinkPlacements } from "./placements.js";

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
  readonly boolean: (name: string) => Builder;
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

export const backlinkMonitorPolicies = pg.pgTable(
  "backlink_monitor_policies",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    placementId: pg.uuid("placement_id").notNull(),
    policyVersion: pg.text("policy_version").notNull(),
    normalIntervalSeconds: pg
      .integer("normal_interval_seconds")
      .notNull()
      .default(86_400),
    suspectedRecheckIntervalSeconds: pg
      .integer("suspected_recheck_interval_seconds")
      .notNull()
      .default(3_600),
    jitterWindowSeconds: pg
      .integer("jitter_window_seconds")
      .notNull()
      .default(3_600),
    retryInitialDelaySeconds: pg
      .integer("retry_initial_delay_seconds")
      .notNull()
      .default(60),
    retryMaxDelaySeconds: pg
      .integer("retry_max_delay_seconds")
      .notNull()
      .default(3_600),
    retryBackoffMultiplier: pg
      .integer("retry_backoff_multiplier")
      .notNull()
      .default(2),
    maxRetryAttempts: pg
      .integer("max_retry_attempts")
      .notNull()
      .default(3),
    lossConfirmationCount: pg
      .integer("loss_confirmation_count")
      .notNull()
      .default(2),
    changeConfirmationCount: pg
      .integer("change_confirmation_count")
      .notNull()
      .default(2),
    browserFallbackEnabled: pg
      .boolean("browser_fallback_enabled")
      .notNull()
      .default(false),
    sourceOutboxEventId: pg.uuid("source_outbox_event_id"),
    workflowId: pg.text("workflow_id"),
    nextCheckAt: timestamp("next_check_at").notNull(),
    schemaVersion: pg.integer("schema_version").notNull(),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_monitor_policy_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.placementId,
      table.policyVersion,
    ),
    pg.uniqueIndex("backlink_monitor_policy_version_uq").on(
      ...identity(table),
      table.placementId,
      table.policyVersion,
    ),
    pg.foreignKey({
      name: "backlink_monitor_policy_placement_fk",
      columns: [...identity(table), table.placementId],
      foreignColumns: [...identity(backlinkPlacements), backlinkPlacements.id],
    }),
  ],
);

export const backlinkMonitorRuns = pg.pgTable(
  "backlink_monitor_runs",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    placementId: pg.uuid("placement_id").notNull(),
    monitorPolicyId: pg.uuid("monitor_policy_id").notNull(),
    policyVersion: pg.text("policy_version").notNull(),
    scheduledFor: timestamp("scheduled_for").notNull(),
    executionMode: pg.text("execution_mode").notNull(),
    status: pg.text("status").notNull().default("SCHEDULED"),
    attemptCount: pg.integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at"),
    retryAfterSeconds: pg.integer("retry_after_seconds"),
    errorCode: pg.text("error_code"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    schemaVersion: pg.integer("schema_version").notNull(),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_monitor_run_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.placementId,
      table.monitorPolicyId,
      table.policyVersion,
      table.scheduledFor,
      table.executionMode,
    ),
    pg.uniqueIndex("backlink_monitor_run_schedule_uq").on(
      ...identity(table),
      table.placementId,
      table.scheduledFor,
      table.policyVersion,
      table.executionMode,
    ),
    pg.foreignKey({
      name: "backlink_monitor_run_placement_fk",
      columns: [...identity(table), table.placementId],
      foreignColumns: [...identity(backlinkPlacements), backlinkPlacements.id],
    }),
    pg.foreignKey({
      name: "backlink_monitor_run_policy_fk",
      columns: [
        ...identity(table),
        table.monitorPolicyId,
        table.placementId,
        table.policyVersion,
      ],
      foreignColumns: [
        ...identity(backlinkMonitorPolicies),
        backlinkMonitorPolicies.id,
        backlinkMonitorPolicies.placementId,
        backlinkMonitorPolicies.policyVersion,
      ],
    }),
  ],
);

export const backlinkMonitorObservations = pg.pgTable(
  "backlink_monitor_observations",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    monitorRunId: pg.uuid("monitor_run_id").notNull(),
    placementId: pg.uuid("placement_id").notNull(),
    monitorPolicyId: pg.uuid("monitor_policy_id").notNull(),
    policyVersion: pg.text("policy_version").notNull(),
    scheduledFor: timestamp("scheduled_for").notNull(),
    executionMode: pg.text("execution_mode").notNull(),
    result: pg.text("result").notNull(),
    failureCode: pg.text("failure_code"),
    evidenceSnapshot: pg.jsonb("evidence_snapshot").notNull(),
    evidenceSnapshotHash: pg.text("evidence_snapshot_hash").notNull(),
    evidenceFingerprint: pg.text("evidence_fingerprint").notNull(),
    evidenceContractVersion: pg.text("evidence_contract_version").notNull(),
    evidenceSchemaVersion: pg.integer("evidence_schema_version").notNull(),
    observedAt: timestamp("observed_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_monitor_observation_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_monitor_observation_run_uq").on(
      ...identity(table),
      table.monitorRunId,
    ),
    pg.foreignKey({
      name: "backlink_monitor_observation_run_fk",
      columns: [
        ...identity(table),
        table.monitorRunId,
        table.placementId,
        table.monitorPolicyId,
        table.policyVersion,
        table.scheduledFor,
        table.executionMode,
      ],
      foreignColumns: [
        ...identity(backlinkMonitorRuns),
        backlinkMonitorRuns.id,
        backlinkMonitorRuns.placementId,
        backlinkMonitorRuns.monitorPolicyId,
        backlinkMonitorRuns.policyVersion,
        backlinkMonitorRuns.scheduledFor,
        backlinkMonitorRuns.executionMode,
      ],
    }),
  ],
);
