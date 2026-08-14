import { createRequire } from "node:module";
import { projectIdentityColumns } from "./common.js";
import {
  backlinkDraftVersions,
} from "./drafts.js";
import {
  backlinkGmailConnections,
  backlinkGmailSendIdentities,
} from "./gmail-connections.js";
import { backlinkContacts } from "./contacts.js";
import { backlinkLifecycleEvents } from "./jobs.js";
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

export const backlinkSendIntents = pg.pgTable(
  "backlink_send_intents",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    draftId: pg.uuid("draft_id").notNull(),
    approvedDraftVersionId: pg.uuid("approved_draft_version_id").notNull(),
    contactId: pg.uuid("contact_id"),
    contactVersion: pg.integer("contact_version"),
    sendSnapshotId: pg.uuid("send_snapshot_id"),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    clientIdempotencyKey: pg.text("client_idempotency_key").notNull(),
    logicalMessageKey: pg.text("logical_message_key").notNull(),
    messagePurpose: pg.text("message_purpose").notNull(),
    followUpIndex: pg.integer("follow_up_index").notNull().default(0),
    requestedSendAt: timestamp("requested_send_at").notNull(),
    status: pg.text("status").notNull().default("READY"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_send_intent_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_send_intent_connection_identity_uq").on(
      ...identity(table),
      table.id,
      table.gmailConnectionId,
    ),
    pg.uniqueIndex("backlink_send_intent_client_idempotency_uq").on(
      table.workspaceId,
      table.websiteProjectId,
      table.clientIdempotencyKey,
    ),
    pg.uniqueIndex("backlink_send_intent_logical_message_uq").on(
      table.workspaceId,
      table.websiteProjectId,
      table.logicalMessageKey,
    ),
    pg.foreignKey({
      name: "backlink_send_intent_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [
        ...identity(backlinkOpportunities),
        backlinkOpportunities.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_send_intent_draft_version_fk",
      columns: [
        ...identity(table),
        table.approvedDraftVersionId,
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
      name: "backlink_send_intent_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_send_intent_contact_fk",
      columns: [...identity(table), table.contactId],
      foreignColumns: [...identity(backlinkContacts), backlinkContacts.id],
    }),
  ],
);

export const backlinkSendSnapshots = pg.pgTable(
  "backlink_send_snapshots",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    sendIntentId: pg.uuid("send_intent_id").notNull(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    opportunityVersion: pg.integer("opportunity_version").notNull(),
    draftId: pg.uuid("draft_id").notNull(),
    draftVersionId: pg.uuid("draft_version_id").notNull(),
    draftVersionNo: pg.integer("draft_version_no").notNull(),
    contactId: pg.uuid("contact_id").notNull(),
    contactVersion: pg.integer("contact_version").notNull(),
    recipient: pg.text("recipient").notNull(),
    recipientHash: pg.text("recipient_hash").notNull(),
    subjectText: pg.text("subject_text").notNull(),
    bodyText: pg.text("body_text").notNull(),
    bodyDocument: pg.jsonb("body_document"),
    contentHash: pg.text("content_hash").notNull(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    gmailConnectionVersion: pg.integer("gmail_connection_version").notNull(),
    gmailIdentityId: pg.uuid("gmail_identity_id").notNull(),
    gmailIdentityVersion: pg.integer("gmail_identity_version").notNull(),
    approvalFactId: pg.uuid("approval_fact_id"),
    approvalActorId: pg.text("approval_actor_id"),
    approvalRecordedAt: timestamp("approval_recorded_at"),
    snapshotSchemaVersion: pg.integer("snapshot_schema_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_send_snapshot_tenant_identity_uq").on(
      ...identity(table),
      table.id,
      table.sendIntentId,
    ),
    pg.uniqueIndex("backlink_send_snapshot_intent_uq").on(
      ...identity(table),
      table.sendIntentId,
    ),
    pg.foreignKey({
      name: "backlink_send_snapshot_intent_fk",
      columns: [...identity(table), table.sendIntentId],
      foreignColumns: [...identity(backlinkSendIntents), backlinkSendIntents.id],
    }),
    pg.foreignKey({
      name: "backlink_send_snapshot_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [...identity(backlinkOpportunities), backlinkOpportunities.id],
    }),
    pg.foreignKey({
      name: "backlink_send_snapshot_draft_version_fk",
      columns: [
        ...identity(table),
        table.draftVersionId,
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
      name: "backlink_send_snapshot_contact_fk",
      columns: [...identity(table), table.contactId],
      foreignColumns: [...identity(backlinkContacts), backlinkContacts.id],
    }),
    pg.foreignKey({
      name: "backlink_send_snapshot_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_send_snapshot_identity_fk",
      columns: [
        table.organizationId,
        table.gmailIdentityId,
        table.gmailConnectionId,
      ],
      foreignColumns: [
        backlinkGmailSendIdentities.organizationId,
        backlinkGmailSendIdentities.id,
        backlinkGmailSendIdentities.gmailConnectionId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_send_snapshot_approval_fact_fk",
      columns: [...identity(table), table.approvalFactId],
      foreignColumns: [
        ...identity(backlinkLifecycleEvents),
        backlinkLifecycleEvents.id,
      ],
    }),
  ],
);

export const backlinkSendAttempts = pg.pgTable(
  "backlink_send_attempts",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    sendIntentId: pg.uuid("send_intent_id").notNull(),
    attemptNo: pg.integer("attempt_no").notNull(),
    fencingToken: pg.integer("fencing_token").notNull(),
    rfcMessageId: pg.text("rfc_message_id").notNull(),
    status: pg.text("status").notNull(),
    providerMessageId: pg.text("provider_message_id"),
    providerThreadId: pg.text("provider_thread_id"),
    providerErrorCode: pg.text("provider_error_code"),
    startedAt: timestamp("started_at").notNull(),
    completedAt: timestamp("completed_at"),
    retryEligibleAt: timestamp("retry_eligible_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_send_attempt_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_send_attempt_number_uq").on(
      table.sendIntentId,
      table.attemptNo,
    ),
    pg.uniqueIndex("backlink_send_attempt_rfc_message_id_uq").on(
      table.rfcMessageId,
    ),
    pg.foreignKey({
      name: "backlink_send_attempt_intent_fk",
      columns: [...identity(table), table.sendIntentId],
      foreignColumns: [
        ...identity(backlinkSendIntents),
        backlinkSendIntents.id,
      ],
    }),
  ],
);

export const backlinkSendReconciliations = pg.pgTable(
  "backlink_send_reconciliations",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    sendIntentId: pg.uuid("send_intent_id").notNull(),
    sendAttemptId: pg.uuid("send_attempt_id").notNull(),
    outcome: pg.text("outcome").notNull(),
    providerMessageId: pg.text("provider_message_id"),
    providerThreadId: pg.text("provider_thread_id"),
    evidenceReference: pg.text("evidence_reference").notNull(),
    reconciledAt: timestamp("reconciled_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_send_reconciliation_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_send_reconciliation_intent_uq").on(
      table.sendIntentId,
    ),
    pg.uniqueIndex("backlink_send_reconciliation_attempt_uq").on(
      table.sendAttemptId,
    ),
    pg.foreignKey({
      name: "backlink_send_reconciliation_intent_fk",
      columns: [...identity(table), table.sendIntentId],
      foreignColumns: [
        ...identity(backlinkSendIntents),
        backlinkSendIntents.id,
      ],
    }),
    pg.foreignKey({
      name: "backlink_send_reconciliation_attempt_fk",
      columns: [...identity(table), table.sendAttemptId],
      foreignColumns: [
        ...identity(backlinkSendAttempts),
        backlinkSendAttempts.id,
      ],
    }),
  ],
);

export const backlinkRateLimitReservations = pg.pgTable(
  "backlink_rate_limit_reservations",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    sendIntentId: pg.uuid("send_intent_id").notNull(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    reservationKey: pg.text("reservation_key").notNull(),
    laneSequence: pg.integer("lane_sequence").notNull(),
    status: pg.text("status").notNull().default("RESERVED"),
    reservedAt: timestamp("reserved_at").notNull(),
    eligibleAt: timestamp("eligible_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    releasedAt: timestamp("released_at"),
    releaseReason: pg.text("release_reason"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_rate_limit_reservation_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_rate_limit_reservation_intent_uq").on(
      table.sendIntentId,
    ),
    pg.uniqueIndex("backlink_rate_limit_reservation_key_uq").on(
      table.organizationId,
      table.gmailConnectionId,
      table.reservationKey,
    ),
    pg.uniqueIndex("backlink_rate_limit_reservation_lane_uq").on(
      table.organizationId,
      table.gmailConnectionId,
      table.laneSequence,
    ),
    pg.foreignKey({
      name: "backlink_rate_limit_reservation_intent_fk",
      columns: [
        ...identity(table),
        table.sendIntentId,
        table.gmailConnectionId,
      ],
      foreignColumns: [
        ...identity(backlinkSendIntents),
        backlinkSendIntents.id,
        backlinkSendIntents.gmailConnectionId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_rate_limit_reservation_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
  ],
);
