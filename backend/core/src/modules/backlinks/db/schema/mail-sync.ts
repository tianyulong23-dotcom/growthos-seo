import { createRequire } from "node:module";
import { projectIdentityColumns } from "./common.js";
import {
  backlinkGmailConnections,
  backlinkGmailWorkspaceBindings,
} from "./gmail-connections.js";
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
  readonly boolean: (name: string) => Builder;
  readonly numeric: (name: string, config: {
    readonly precision: number;
    readonly scale: number;
  }) => Builder;
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

export const backlinkMailSyncCursors = pg.pgTable(
  "backlink_mail_sync_cursors",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    historyId: pg.text("history_id"),
    nextPageToken: pg.text("next_page_token"),
    initialSyncCompletedAt: timestamp("initial_sync_completed_at"),
    lastSyncedAt: timestamp("last_synced_at"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_mail_sync_cursor_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_mail_sync_cursor_connection_uq").on(
      ...identity(table),
      table.gmailConnectionId,
    ),
    pg.foreignKey({
      name: "backlink_mail_sync_cursor_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
  ],
);

export const backlinkGmailConnectionSyncCursors = pg.pgTable(
  "backlink_gmail_connection_sync_cursors",
  {
    id: pg.uuid("id").primaryKey(),
    organizationId: pg.uuid("organization_id").notNull(),
    workspaceId: pg.uuid("workspace_id").notNull(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    historyId: pg.text("history_id"),
    nextPageToken: pg.text("next_page_token"),
    initialSyncCompletedAt: timestamp("initial_sync_completed_at"),
    lastSyncedAt: timestamp("last_synced_at"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex(
      "backlink_gmail_connection_sync_cursor_identity_uq",
    ).on(
      table.organizationId,
      table.workspaceId,
      table.id,
    ),
    pg.uniqueIndex(
      "backlink_gmail_connection_sync_cursor_connection_uq",
    ).on(
      table.organizationId,
      table.workspaceId,
      table.gmailConnectionId,
    ),
    pg.foreignKey({
      name: "backlink_gmail_connection_sync_cursor_binding_fk",
      columns: [
        table.organizationId,
        table.workspaceId,
        table.gmailConnectionId,
      ],
      foreignColumns: [
        backlinkGmailWorkspaceBindings.organizationId,
        backlinkGmailWorkspaceBindings.workspaceId,
        backlinkGmailWorkspaceBindings.gmailConnectionId,
      ],
    }),
  ],
);

export const backlinkMailRawMessageReferences = pg.pgTable(
  "backlink_mail_raw_message_references",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    providerMessageId: pg.text("provider_message_id").notNull(),
    providerThreadId: pg.text("provider_thread_id").notNull(),
    historyId: pg.text("history_id"),
    rawObjectKey: pg.text("raw_object_key"),
    rawContentSha256: pg.text("raw_content_sha256").notNull(),
    rawSizeBytes: pg.integer("raw_size_bytes").notNull(),
    fetchedAt: timestamp("fetched_at").notNull(),
    retentionExpiresAt: timestamp("retention_expires_at").notNull(),
    purgedAt: timestamp("purged_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_mail_raw_message_reference_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex(
      "backlink_mail_raw_message_reference_connection_identity_uq",
    ).on(...identity(table), table.id, table.gmailConnectionId),
    pg.uniqueIndex("backlink_mail_raw_message_reference_provider_uq").on(
      ...identity(table),
      table.gmailConnectionId,
      table.providerMessageId,
    ),
    pg.foreignKey({
      name: "backlink_mail_raw_message_reference_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
  ],
);

export const backlinkMailThreads = pg.pgTable(
  "backlink_mail_threads",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    providerThreadId: pg.text("provider_thread_id").notNull(),
    latestMessageAt: timestamp("latest_message_at"),
    messageCount: pg.integer("message_count").notNull().default(0),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_mail_thread_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_mail_thread_connection_identity_uq").on(
      ...identity(table),
      table.id,
      table.gmailConnectionId,
    ),
    pg.uniqueIndex("backlink_mail_thread_provider_uq").on(
      ...identity(table),
      table.gmailConnectionId,
      table.providerThreadId,
    ),
    pg.foreignKey({
      name: "backlink_mail_thread_connection_fk",
      columns: [table.organizationId, table.gmailConnectionId],
      foreignColumns: [
        backlinkGmailConnections.organizationId,
        backlinkGmailConnections.id,
      ],
    }),
  ],
);

export const backlinkMailMessages = pg.pgTable(
  "backlink_mail_messages",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    rawMessageReferenceId: pg.uuid("raw_message_reference_id").notNull(),
    mailThreadId: pg.uuid("mail_thread_id").notNull(),
    rfcMessageId: pg.text("rfc_message_id"),
    inReplyToMessageId: pg.text("in_reply_to_message_id"),
    referenceMessageIds: pg.jsonb("reference_message_ids").notNull().default([]),
    fromAddress: pg.text("from_address"),
    toAddresses: pg.jsonb("to_addresses").notNull().default([]),
    ccAddresses: pg.jsonb("cc_addresses").notNull().default([]),
    subjectText: pg.text("subject_text"),
    receivedAt: timestamp("received_at"),
    direction: pg.text("direction").notNull(),
    parseStatus: pg.text("parse_status").notNull().default("PENDING"),
    parsedAt: timestamp("parsed_at"),
    version: pg.integer("version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_mail_message_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_mail_message_connection_identity_uq").on(
      ...identity(table),
      table.id,
      table.gmailConnectionId,
    ),
    pg.uniqueIndex("backlink_mail_message_raw_reference_uq").on(
      table.rawMessageReferenceId,
    ),
    pg.foreignKey({
      name: "backlink_mail_message_raw_reference_fk",
      columns: [
        ...identity(table),
        table.rawMessageReferenceId,
        table.gmailConnectionId,
      ],
      foreignColumns: [
        ...identity(backlinkMailRawMessageReferences),
        backlinkMailRawMessageReferences.id,
        backlinkMailRawMessageReferences.gmailConnectionId,
      ],
    }),
    pg.foreignKey({
      name: "backlink_mail_message_thread_fk",
      columns: [...identity(table), table.mailThreadId, table.gmailConnectionId],
      foreignColumns: [
        ...identity(backlinkMailThreads),
        backlinkMailThreads.id,
        backlinkMailThreads.gmailConnectionId,
      ],
    }),
  ],
);

export const backlinkInboundMessages = pg.pgTable(
  "backlink_inbound_messages",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    gmailConnectionId: pg.uuid("gmail_connection_id").notNull(),
    mailMessageId: pg.uuid("mail_message_id").notNull(),
    receivedAt: timestamp("received_at").notNull(),
    matchStatus: pg.text("match_status").notNull().default("UNMATCHED"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
    updatedBy: pg.text("updated_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_inbound_message_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_inbound_message_mail_message_uq").on(
      table.mailMessageId,
    ),
    pg.foreignKey({
      name: "backlink_inbound_message_mail_message_fk",
      columns: [...identity(table), table.mailMessageId, table.gmailConnectionId],
      foreignColumns: [
        ...identity(backlinkMailMessages),
        backlinkMailMessages.id,
        backlinkMailMessages.gmailConnectionId,
      ],
    }),
  ],
);

export const backlinkReplyMatchCandidates = pg.pgTable(
  "backlink_reply_match_candidates",
  {
    id: pg.uuid("id").primaryKey(),
    ...projectIdentityColumns(),
    inboundMessageId: pg.uuid("inbound_message_id").notNull(),
    opportunityId: pg.uuid("opportunity_id").notNull(),
    candidateRank: pg.integer("candidate_rank").notNull(),
    confidenceScore: pg.numeric("confidence_score", {
      precision: 5,
      scale: 4,
    }).notNull(),
    reasonCodes: pg.jsonb("reason_codes").notNull().default([]),
    requiresManualConfirmation: pg
      .boolean("requires_manual_confirmation")
      .notNull()
      .default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: pg.text("created_by").notNull(),
  },
  (table) => [
    pg.uniqueIndex("backlink_reply_match_candidate_tenant_identity_uq").on(
      ...identity(table),
      table.id,
    ),
    pg.uniqueIndex("backlink_reply_match_candidate_reply_opportunity_uq").on(
      table.inboundMessageId,
      table.opportunityId,
    ),
    pg.uniqueIndex(
      "backlink_reply_match_candidate_scoped_assignment_uq",
    ).on(
      ...identity(table),
      table.inboundMessageId,
      table.opportunityId,
    ),
    pg.foreignKey({
      name: "backlink_reply_match_candidate_inbound_fk",
      columns: [...identity(table), table.inboundMessageId],
      foreignColumns: [...identity(backlinkInboundMessages), backlinkInboundMessages.id],
    }),
    pg.foreignKey({
      name: "backlink_reply_match_candidate_opportunity_fk",
      columns: [...identity(table), table.opportunityId],
      foreignColumns: [...identity(backlinkOpportunities), backlinkOpportunities.id],
    }),
  ],
);
