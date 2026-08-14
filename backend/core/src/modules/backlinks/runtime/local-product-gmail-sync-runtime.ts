import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  type InitialMailSyncCheckpoint,
  type InitialMailSyncRepository,
  type InitialMailSyncContext,
  type PersistInitialMailSyncPageInput,
  type PersistedInitialMailMessage,
} from "../application/services/mail-initial-sync.repository.js";
import {
  type IncrementalMailSyncCheckpoint,
  type IncrementalMailSyncContext,
  type IncrementalMailSyncRepository,
  type PersistIncrementalMailSyncPageInput,
  type PersistedIncrementalMailMessage,
} from "../application/services/mail-incremental-sync.repository.js";
import {
  PostgresqlReplyMatchRepository,
} from "../application/services/reply-match.repository.js";
import {
  runGmailInitialSyncWorkflow,
} from "../application/workflows/mail-initial-sync-workflow.js";
import {
  runGmailIncrementalSyncWorkflow,
} from "../application/workflows/mail-incremental-sync-workflow.js";
import type {
  GmailPollingSyncCommands,
  GmailPollingSyncWorkflowInput,
  GmailPollingSyncWorkflowResult,
} from "../application/workflows/gmail-polling-sync-workflow.js";
import {
  gmailPollingSyncNowSignal,
  gmailPollingSyncStatusQuery,
} from "../application/workflows/gmail-polling-sync-workflow.js";
import type {
  GmailPollingSyncWorkflowStatus,
} from "../application/workflows/gmail-polling-sync-workflow.js";
import {
  GoogleAuthClientAdapter,
} from "../adapters/gmail/auth-client.js";
import {
  GoogleAuthLibraryClient,
} from "../adapters/gmail/google-auth-library-client.js";
import {
  GoogleGmailProviderClient,
} from "../adapters/gmail/google-gmail-provider-client.js";
import {
  parseGmailMimeMessage,
  type MailMessage,
} from "../adapters/gmail/message-parser.js";
import {
  GmailSyncClientAdapter,
} from "../adapters/gmail/sync-client.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import {
  SecretStoreClientAdapter,
} from "../adapters/security/secret-store-client.js";
import {
  SecretBackedGmailConnectionRepository,
} from "../application/services/gmail-connection-secret.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  matchInboundReply,
  type OutboundReplyReference,
} from "../domain/replies/matching.js";
import {
  PostgresqlGmailConnectionRefreshLock,
  PostgresqlGmailConnectionRepository,
} from "../db/repositories/gmail-connection.repository.js";
import {
  createPostgresqlProjectScopeProvider,
} from "../db/repositories/project-scope.repository.js";
import {
  withBacklinkTenantTransaction,
  withBacklinkWorkspaceTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../db/tenant-transaction.js";
import type {
  ResolvedProjectContext,
} from "../ports/project-context.port.js";
import {
  secretKinds,
} from "../ports/secret-store.port.js";
import type {
  GmailSyncPort,
} from "../ports/gmail-sync.port.js";
import type {
  BacklinksTemporalClient,
} from "../workflows/client.js";
import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "../workflows/namespaces.js";
import type {
  BacklinksLiveCapabilities,
} from "./live-capabilities.js";
import {
  LocalProductMailRawObjectStore,
} from "./local-product-mail-store.js";

type SyncScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

type SyncContext = Readonly<{
  resolved: ResolvedProjectContext;
  primaryEmail: string;
}>;

export const gmailPollingStatusQueryTimeoutMs = 1_000;

async function withGmailPollingStatusQueryTimeout<T>(
  query: Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("GMAIL_POLLING_STATUS_QUERY_TIMEOUT"));
        }, gmailPollingStatusQueryTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type RawReferenceRow = Readonly<{
  id: string;
  providerMessageId: string;
  providerThreadId: string;
  rawObjectKey: string;
  receivedAt: Date;
}>;

type OutboundRow = Readonly<{
  opportunityId: string;
  providerThreadId: string;
  rfcMessageId: string;
  contactAddress: string;
  bodyText: string;
  subject: string | null;
  sentAt: Date;
}>;

const initialSyncLookbackMs = 24 * 60 * 60 * 1_000;

export const buildLocalProductGmailInitialQuery = (
  outbound: readonly Pick<OutboundRow, "subject" | "sentAt">[],
  mode: BacklinksLiveCapabilities["mode"],
): string => {
  if (
    !["LOCAL_PRODUCT", "LOCAL_PRODUCT_ACCEPTANCE"].includes(mode)
    || outbound.length === 0
  ) {
    throw new Error(
      "BACKLINK_LOCAL_PRODUCT_GMAIL_SYNC_REQUIRES_ACCEPTED_SEND",
    );
  }
  const earliestSentAt = Math.min(...outbound.map((row) =>
    row.sentAt.getTime()));
  if (!Number.isFinite(earliestSentAt)) {
    throw new Error("BACKLINK_LOCAL_PRODUCT_GMAIL_SYNC_SENT_AT_INVALID");
  }
  const afterUnixSeconds = Math.max(
    0,
    Math.floor((earliestSentAt - initialSyncLookbackMs) / 1_000),
  );
  return `in:anywhere after:${afterUnixSeconds}`;
};

const bodyFingerprint = (value: string): string =>
  createHash("sha256")
    .update(value.replace(/\s+/gu, " ").trim())
    .digest("hex");

const quotedBodyFingerprints = (value: string | null): readonly string[] => {
  if (value === null) return Object.freeze([]);
  const lines = value.split(/\r?\n/u);
  const quotedLines = lines
    .filter((line) => /^\s*>/u.test(line))
    .map((line) => line.replace(/^\s*>\s?/u, ""));
  const wroteAt = lines.findIndex((line) =>
    /^\s*On .+ wrote:\s*$/iu.test(line));
  const candidates = [
    quotedLines.join("\n"),
    wroteAt < 0 ? "" : lines.slice(wroteAt + 1).join("\n"),
  ]
    .map((candidate) => candidate.replace(/\s+/gu, " ").trim())
    .filter((candidate) => candidate.length > 0);
  return Object.freeze([...new Set(candidates.map(bodyFingerprint))]);
};

const scopeFrom = (input: SyncScope): SyncScope => ({
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  websiteProjectId: input.websiteProjectId,
});

const rawStoreRoot = (capabilities: BacklinksLiveCapabilities): string => {
  if (capabilities.secretStoreRoot === null) {
    throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_STORE_MISSING");
  }
  return resolve(capabilities.secretStoreRoot, "..", "mail-raw");
};

const assertSyncKillSwitchOpen = async (
  pool: BacklinkTenantPool,
  scope: SyncScope,
): Promise<void> => {
  const blocked = await withBacklinkTenantTransaction(
    pool,
    scope,
    async (client) => {
      const result = await client.query(
        `SELECT switch.blocked
           FROM backlinks.backlink_kill_switch_versions AS switch
          WHERE switch.organization_id=$1
            AND switch.workspace_id=$2
            AND switch.website_project_id=$3
            AND switch.capability='GMAIL_SYNC'
          ORDER BY switch.version DESC
          LIMIT 1`,
        [
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
        ],
      );
      return result.rows[0]?.blocked;
    },
  );
  if (blocked !== false) {
    throw new BacklinkError({
      code: backlinkErrorCodes.conflict,
      message: "Gmail polling is blocked by the project Kill Switch.",
    });
  }
};

const loadSyncContext = async (
  pool: BacklinkTenantPool,
  input: GmailPollingSyncWorkflowInput,
): Promise<SyncContext> => {
  const scope = scopeFrom(input);
  const result = await withBacklinkTenantTransaction(
    pool,
    scope,
    (client) => client.query(
      `SELECT
         connection.primary_email AS "primaryEmail",
         context.canonical_domain AS "canonicalDomain",
         context.locale,
         context.country_code AS "countryCode",
         context.profile_version_id AS "profileVersionId",
         context.promotion_target_version_id AS "promotionTargetVersionId"
       FROM backlinks.backlink_gmail_connections AS connection
       JOIN backlinks.backlink_gmail_workspace_bindings AS binding
           ON binding.organization_id=connection.organization_id
          AND binding.workspace_id=$2
          AND binding.gmail_connection_id=connection.id
        AND binding.binding_status='ACTIVE'
       JOIN backlinks.backlink_website_project_mailbox_bindings AS project_binding
         ON project_binding.organization_id=binding.organization_id
        AND project_binding.workspace_id=binding.workspace_id
        AND project_binding.website_project_id=$3
        AND project_binding.gmail_workspace_binding_id=binding.id
        AND project_binding.binding_status='ACTIVE'
        AND project_binding.is_selected=true
       JOIN LATERAL (
         SELECT snapshot.*
           FROM backlinks.backlink_project_context_snapshots AS snapshot
          WHERE snapshot.organization_id=$1
            AND snapshot.workspace_id=$2
            AND snapshot.website_project_id=$3
          ORDER BY snapshot.snapshot_version DESC
          LIMIT 1
       ) AS context ON true
      WHERE connection.organization_id=$1
        AND connection.id=$4
        AND connection.connection_status='CONNECTED'
        AND connection.mail_sync_capability=true`,
      [
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        input.gmailConnectionId,
      ],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new BacklinkError({
      code: backlinkErrorCodes.notFound,
      message: "The connected Gmail account is unavailable for polling.",
    });
  }
  return Object.freeze({
    primaryEmail: String(row.primaryEmail).toLowerCase(),
    resolved: Object.freeze({
      actor: createActorContext({
        userId: input.actorId,
        sessionId: `gmail-polling-sync:${input.workflowId}`,
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
      }),
      project: createProjectContext({
        websiteProjectId: scope.websiteProjectId,
        canonicalDomain: String(row.canonicalDomain),
        locale: String(row.locale),
        countryCode: String(row.countryCode),
        profileVersionId: String(row.profileVersionId),
        promotionTargetVersionId: String(row.promotionTargetVersionId),
      }),
    }),
  });
};

const addresses = (
  values: MailMessage["to"] | MailMessage["cc"],
): string[] => values.map((value) => value.address.toLowerCase());

const restrictSyncToThreads = (
  gmailSync: GmailSyncPort,
  allowedThreadIds: ReadonlySet<string>,
): GmailSyncPort => {
  const restricted: GmailSyncPort = {
  async listInitialMessages(input) {
    const page = await gmailSync.listInitialMessages(input);
    return Object.freeze({
      ...page,
      messages: Object.freeze(page.messages.filter((message) =>
        allowedThreadIds.has(message.providerThreadId))),
    });
  },
  async listHistory(input) {
    const page = await gmailSync.listHistory(input);
    if (page.kind === "history_expired") return page;
    return Object.freeze({
      ...page,
      messages: Object.freeze(page.messages.filter((message) =>
        allowedThreadIds.has(message.providerThreadId))),
    });
  },
  getMessage: (input) => gmailSync.getMessage(input),
  watch: (input) => gmailSync.watch(input),
  };
  return Object.freeze(restricted);
};

const loadProjectionInputs = async (
  pool: BacklinkTenantPool,
  input: GmailPollingSyncWorkflowInput,
): Promise<Readonly<{
  rawReferences: readonly RawReferenceRow[];
  outbound: readonly OutboundRow[];
}>> => withBacklinkTenantTransaction(
  pool,
  scopeFrom(input),
  async (client) => {
    const outbound = await client.query(
      `SELECT
         intent.opportunity_id AS "opportunityId",
         attempt.provider_thread_id AS "providerThreadId",
         attempt.rfc_message_id AS "rfcMessageId",
         snapshot.recipient AS "contactAddress",
         snapshot.body_text AS "bodyText",
         snapshot.subject_text AS subject,
         attempt.completed_at AS "sentAt"
       FROM backlinks.backlink_send_attempts AS attempt
       JOIN backlinks.backlink_send_intents AS intent
         ON intent.organization_id=attempt.organization_id
        AND intent.workspace_id=attempt.workspace_id
        AND intent.website_project_id=attempt.website_project_id
        AND intent.id=attempt.send_intent_id
       JOIN backlinks.backlink_send_snapshots AS snapshot
         ON snapshot.organization_id=intent.organization_id
        AND snapshot.workspace_id=intent.workspace_id
        AND snapshot.website_project_id=intent.website_project_id
        AND snapshot.send_intent_id=intent.id
        AND snapshot.id=intent.send_snapshot_id
      WHERE attempt.organization_id=$1
        AND attempt.workspace_id=$2
        AND attempt.website_project_id=$3
        AND intent.gmail_connection_id=$4
        AND attempt.status='PROVIDER_ACCEPTED'
        AND attempt.provider_thread_id IS NOT NULL
        AND attempt.completed_at IS NOT NULL`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.gmailConnectionId,
      ],
    );
    const threadIds = outbound.rows.map((row) =>
      String(row.providerThreadId)
    );
    if (threadIds.length === 0) {
      return Object.freeze({ rawReferences: [], outbound: [] });
    }
    const raw = await client.query(
      `SELECT
         raw.id,
         raw.provider_message_id AS "providerMessageId",
         raw.provider_thread_id AS "providerThreadId",
         raw.raw_object_key AS "rawObjectKey",
         raw.fetched_at AS "receivedAt"
       FROM backlinks.backlink_mail_raw_message_references AS raw
      WHERE raw.organization_id=$1
        AND raw.workspace_id=$2
        AND raw.website_project_id=$3
        AND raw.gmail_connection_id=$4
        AND raw.provider_thread_id=ANY($5::text[])
        AND raw.raw_object_key IS NOT NULL
      ORDER BY raw.fetched_at,raw.id`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.gmailConnectionId,
        threadIds,
      ],
    );
    return Object.freeze({
      rawReferences: Object.freeze(raw.rows.map((row) => Object.freeze({
        id: String(row.id),
        providerMessageId: String(row.providerMessageId),
        providerThreadId: String(row.providerThreadId),
        rawObjectKey: String(row.rawObjectKey),
        receivedAt: new Date(String(row.receivedAt)),
      }))),
      outbound: Object.freeze(outbound.rows.map((row) => Object.freeze({
        opportunityId: String(row.opportunityId),
        providerThreadId: String(row.providerThreadId),
        rfcMessageId: String(row.rfcMessageId),
        contactAddress: String(row.contactAddress).toLowerCase(),
        bodyText: String(row.bodyText),
        subject: row.subject === null ? null : String(row.subject),
        sentAt: new Date(String(row.sentAt)),
      }))),
    });
  },
);

type ConnectionSyncLane = Readonly<{
  input: GmailPollingSyncWorkflowInput;
  syncContext: SyncContext;
  outbound: readonly OutboundRow[];
}>;

type PersistedConnectionMailMessage =
  | PersistedInitialMailMessage
  | PersistedIncrementalMailMessage;

const requiredDate = (value: unknown, name: string): Date => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${name} returned an invalid timestamp.`);
  }
  return date;
};

const nullableDate = (value: unknown, name: string): Date | null =>
  value === null ? null : requiredDate(value, name);

const nullableString = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} returned an invalid value.`);
  }
  return value;
};

const initialCheckpointFromConnectionCursor = (
  row: Record<string, unknown>,
): InitialMailSyncCheckpoint => {
  const startedAt = requiredDate(
    row.startedAt,
    "Connection sync startedAt",
  );
  const snapshotHistoryId = nullableString(
    row.snapshotHistoryId,
    "Connection sync snapshotHistoryId",
  );
  const nextPageToken = nullableString(
    row.nextPageToken,
    "Connection sync nextPageToken",
  );
  const completedAt = nullableDate(
    row.completedAt,
    "Connection sync completedAt",
  );
  if (completedAt !== null) {
    if (snapshotHistoryId === null || nextPageToken !== null) {
      throw new TypeError("Completed connection sync cursor is invalid.");
    }
    return Object.freeze({
      state: "completed",
      startedAt,
      snapshotHistoryId,
      completedAt,
    });
  }
  return Object.freeze({
    state: "pending",
    startedAt,
    snapshotHistoryId,
    nextPageToken,
  });
};

const incrementalCheckpointFromConnectionCursor = (
  row: Record<string, unknown>,
): IncrementalMailSyncCheckpoint => {
  const historyId = nullableString(
    row.historyId,
    "Connection sync historyId",
  );
  const initialSyncCompletedAt = nullableDate(
    row.initialSyncCompletedAt,
    "Connection sync initialSyncCompletedAt",
  );
  if (historyId === null || initialSyncCompletedAt === null) {
    throw new Error(
      "Initial Mail Sync must complete before Incremental Mail Sync.",
    );
  }
  return Object.freeze({
    historyId,
    nextPageToken: nullableString(
      row.nextPageToken,
      "Connection sync nextPageToken",
    ),
    initialSyncCompletedAt,
    lastSyncedAt: nullableDate(
      row.lastSyncedAt,
      "Connection sync lastSyncedAt",
    ),
  });
};

const withConnectionSyncTransaction = async <T>(
  pool: BacklinkTenantPool,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    gmailConnectionId: string;
  }>,
  work: (transaction: BacklinkTransactionClient) => Promise<T>,
): Promise<T> => withBacklinkWorkspaceTransaction(
  pool,
  input,
  async (transaction) => {
    await transaction.query(
      `SELECT set_config(
         'app.current_gmail_connection_id',
         $1,
         true
       )`,
      [input.gmailConnectionId],
    );
    return work(transaction);
  },
);

const assertConnectionSyncAvailable = async (
  transaction: BacklinkTransactionClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    gmailConnectionId: string;
  }>,
): Promise<void> => {
  const result = await transaction.query(
    `SELECT connection.id
       FROM backlinks.backlink_gmail_connections AS connection
       JOIN backlinks.backlink_gmail_workspace_bindings AS binding
         ON binding.organization_id=connection.organization_id
        AND binding.workspace_id=$2
        AND binding.gmail_connection_id=connection.id
        AND binding.binding_status='ACTIVE'
      WHERE connection.organization_id=$1
        AND connection.id=$3
        AND connection.connection_status='CONNECTED'
        AND connection.mail_sync_capability=true
      LIMIT 1`,
    [
      input.organizationId,
      input.workspaceId,
      input.gmailConnectionId,
    ],
  );
  if (result.rows[0] === undefined) {
    throw new Error(
      "Gmail connection is unavailable for connection-level sync.",
    );
  }
};

const lockConnectionSyncCursor = async (
  transaction: BacklinkTransactionClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    gmailConnectionId: string;
  }>,
): Promise<void> => {
  await transaction.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [
      `gmail-connection-sync:${input.organizationId}:`
      + `${input.workspaceId}:${input.gmailConnectionId}`,
    ],
  );
};

const loadInitialConnectionCursor = async (
  transaction: BacklinkTransactionClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    gmailConnectionId: string;
  }>,
): Promise<InitialMailSyncCheckpoint | null> => {
  const result = await transaction.query(
    `SELECT cursor.created_at AS "startedAt",
            cursor.history_id AS "snapshotHistoryId",
            cursor.next_page_token AS "nextPageToken",
            cursor.initial_sync_completed_at AS "completedAt"
       FROM backlinks.backlink_gmail_connection_sync_cursors AS cursor
      WHERE cursor.organization_id=$1
        AND cursor.workspace_id=$2
        AND cursor.gmail_connection_id=$3
      FOR UPDATE`,
    [
      input.organizationId,
      input.workspaceId,
      input.gmailConnectionId,
    ],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : initialCheckpointFromConnectionCursor(row);
};

const loadIncrementalConnectionCursor = async (
  transaction: BacklinkTransactionClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    gmailConnectionId: string;
  }>,
): Promise<IncrementalMailSyncCheckpoint> => {
  const result = await transaction.query(
    `SELECT cursor.history_id AS "historyId",
            cursor.next_page_token AS "nextPageToken",
            cursor.initial_sync_completed_at AS "initialSyncCompletedAt",
            cursor.last_synced_at AS "lastSyncedAt"
       FROM backlinks.backlink_gmail_connection_sync_cursors AS cursor
      WHERE cursor.organization_id=$1
        AND cursor.workspace_id=$2
        AND cursor.gmail_connection_id=$3
      FOR UPDATE`,
    [
      input.organizationId,
      input.workspaceId,
      input.gmailConnectionId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      "Initial Mail Sync must complete before Incremental Mail Sync.",
    );
  }
  return incrementalCheckpointFromConnectionCursor(row);
};

const persistRoutedRawMessages = async (
  pool: BacklinkTenantPool,
  routes: ReadonlyMap<string, readonly GmailPollingSyncWorkflowInput[]>,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    gmailConnectionId: string;
    actorId: string;
  }>,
  messages: readonly PersistedConnectionMailMessage[],
): Promise<number> => {
  let insertedMessages = 0;
  for (const message of messages) {
    const projectInputs = routes.get(message.providerThreadId) ?? [];
    if (projectInputs.length !== 1) continue;
    const projectInput = projectInputs[0];
    if (projectInput === undefined) continue;
    insertedMessages += await withBacklinkTenantTransaction(
      pool,
      scopeFrom(projectInput),
      async (transaction) => {
        const inserted = await transaction.query(
          `INSERT INTO backlinks.backlink_mail_raw_message_references (
             id, organization_id, workspace_id, website_project_id,
             gmail_connection_id, provider_message_id,
             provider_thread_id, history_id, raw_object_key,
             raw_content_sha256, raw_size_bytes, fetched_at,
             retention_expires_at, created_by
           )
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
            WHERE EXISTS (
              SELECT 1
                FROM backlinks.backlink_send_attempts AS attempt
                JOIN backlinks.backlink_send_intents AS intent
                  ON intent.organization_id=attempt.organization_id
                 AND intent.workspace_id=attempt.workspace_id
                 AND intent.website_project_id=attempt.website_project_id
                 AND intent.id=attempt.send_intent_id
                JOIN backlinks.backlink_gmail_workspace_bindings AS binding
                  ON binding.organization_id=intent.organization_id
                 AND binding.workspace_id=intent.workspace_id
                 AND binding.gmail_connection_id=intent.gmail_connection_id
                 AND binding.binding_status='ACTIVE'
                JOIN backlinks.backlink_website_project_mailbox_bindings
                  AS project_binding
                  ON project_binding.organization_id=binding.organization_id
                 AND project_binding.workspace_id=binding.workspace_id
                 AND project_binding.website_project_id=intent.website_project_id
                 AND project_binding.gmail_workspace_binding_id=binding.id
                 AND project_binding.binding_status='ACTIVE'
                 AND project_binding.is_selected=true
               WHERE attempt.organization_id=$2
                 AND attempt.workspace_id=$3
                 AND attempt.website_project_id=$4
                 AND attempt.status='PROVIDER_ACCEPTED'
                 AND attempt.provider_thread_id=$7
                 AND intent.gmail_connection_id=$5
            )
              AND COALESCE((
                SELECT kill_switch.blocked
                  FROM backlinks.backlink_kill_switch_versions AS kill_switch
                 WHERE kill_switch.organization_id=$2
                   AND kill_switch.workspace_id=$3
                   AND kill_switch.website_project_id=$4
                   AND kill_switch.layer='project'
                   AND kill_switch.capability='GMAIL_SYNC'
                   AND kill_switch.provider IS NULL
                 ORDER BY kill_switch.version DESC
                 LIMIT 1
              ), true)=false
           ON CONFLICT (
             organization_id,workspace_id,website_project_id,
             gmail_connection_id,provider_message_id
           ) DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            input.organizationId,
            input.workspaceId,
            projectInput.websiteProjectId,
            input.gmailConnectionId,
            message.providerMessageId,
            message.providerThreadId,
            message.historyId,
            message.rawObjectKey,
            message.rawContentSha256,
            message.rawSizeBytes,
            message.fetchedAt,
            message.retentionExpiresAt,
            input.actorId,
          ],
        );
        return inserted.rowCount ?? 0;
      },
    );
  }
  return insertedMessages;
};

const createConnectionInitialSyncRepository = (
  pool: BacklinkTenantPool,
  routes: ReadonlyMap<string, readonly GmailPollingSyncWorkflowInput[]>,
): InitialMailSyncRepository => Object.freeze({
  async loadOrCreateCheckpoint(
    input: InitialMailSyncContext & Readonly<{ startedAt: Date }>,
  ) {
    return withConnectionSyncTransaction(pool, input, async (transaction) => {
      await lockConnectionSyncCursor(transaction, input);
      const existing = await loadInitialConnectionCursor(
        transaction,
        input,
      );
      await assertConnectionSyncAvailable(transaction, input);
      if (existing !== null) return existing;
      const inserted = await transaction.query(
        `INSERT INTO backlinks.backlink_gmail_connection_sync_cursors (
           id,organization_id,workspace_id,gmail_connection_id,
           created_at,updated_at,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$5,$6,$6)
         RETURNING created_at AS "startedAt",
                   history_id AS "snapshotHistoryId",
                   next_page_token AS "nextPageToken",
                   initial_sync_completed_at AS "completedAt"`,
        [
          randomUUID(),
          input.organizationId,
          input.workspaceId,
          input.gmailConnectionId,
          input.startedAt,
          input.actorId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("Connection sync cursor could not be created.");
      }
      return initialCheckpointFromConnectionCursor(row);
    });
  },
  async persistPage(input: PersistInitialMailSyncPageInput) {
    const checkpoint = await withConnectionSyncTransaction(
      pool,
      input,
      async (transaction) => {
        await lockConnectionSyncCursor(transaction, input);
        const current = await loadInitialConnectionCursor(
          transaction,
          input,
        );
        if (current === null) {
          throw new Error("Connection sync cursor is unavailable.");
        }
        await assertConnectionSyncAvailable(transaction, input);
        return current;
      },
    );
    if (
      checkpoint.state === "completed"
      || checkpoint.nextPageToken !== input.expectedPageToken
    ) {
      return {
        state: "stale" as const,
        checkpoint,
        insertedMessages: 0,
      };
    }
    if (
      checkpoint.snapshotHistoryId !== null
      && checkpoint.snapshotHistoryId !== input.snapshotHistoryId
    ) {
      throw new Error("Initial Mail Sync snapshot History ID changed.");
    }
    const insertedMessages = await persistRoutedRawMessages(
      pool,
      routes,
      input,
      input.messages,
    );
    return withConnectionSyncTransaction(
      pool,
      input,
      async (transaction) => {
        await lockConnectionSyncCursor(transaction, input);
        const current = await loadInitialConnectionCursor(
          transaction,
          input,
        );
        if (current === null) {
          throw new Error("Connection sync cursor is unavailable.");
        }
        if (
          current.state === "completed"
          || current.nextPageToken !== input.expectedPageToken
        ) {
          return {
            state: "stale" as const,
            checkpoint: current,
            insertedMessages: 0,
          };
        }
        const completedAt = input.nextPageToken === null
          ? input.persistedAt
          : null;
        const updated = await transaction.query(
          `UPDATE backlinks.backlink_gmail_connection_sync_cursors
              SET history_id=$4,
                  next_page_token=$5,
                  initial_sync_completed_at=$6,
                  last_synced_at=$7,
                  version=version+1,
                  updated_at=$7,
                  updated_by=$8
            WHERE organization_id=$1
              AND workspace_id=$2
              AND gmail_connection_id=$3
            RETURNING created_at AS "startedAt",
                      history_id AS "snapshotHistoryId",
                      next_page_token AS "nextPageToken",
                      initial_sync_completed_at AS "completedAt"`,
          [
            input.organizationId,
            input.workspaceId,
            input.gmailConnectionId,
            input.snapshotHistoryId,
            input.nextPageToken,
            completedAt,
            input.persistedAt,
            input.actorId,
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          throw new Error("Connection sync cursor could not be advanced.");
        }
        const next = initialCheckpointFromConnectionCursor(row);
        return {
          state: next.state === "completed"
            ? "completed" as const
            : "advanced" as const,
          checkpoint: next,
          insertedMessages,
        };
      },
    );
  },
});

const createConnectionIncrementalSyncRepository = (
  pool: BacklinkTenantPool,
  routes: ReadonlyMap<string, readonly GmailPollingSyncWorkflowInput[]>,
): IncrementalMailSyncRepository => Object.freeze({
  async loadCheckpoint(input: IncrementalMailSyncContext) {
    return withConnectionSyncTransaction(pool, input, async (transaction) => {
      await assertConnectionSyncAvailable(transaction, input);
      return loadIncrementalConnectionCursor(transaction, input);
    });
  },
  async persistPage(input: PersistIncrementalMailSyncPageInput) {
    const checkpoint = await withConnectionSyncTransaction(
      pool,
      input,
      async (transaction) => {
        await lockConnectionSyncCursor(transaction, input);
        await assertConnectionSyncAvailable(transaction, input);
        return loadIncrementalConnectionCursor(transaction, input);
      },
    );
    if (
      checkpoint.historyId !== input.expectedHistoryId
      || checkpoint.nextPageToken !== input.expectedPageToken
    ) {
      return {
        state: "stale" as const,
        checkpoint,
        insertedMessages: 0,
      };
    }
    const insertedMessages = await persistRoutedRawMessages(
      pool,
      routes,
      input,
      input.messages,
    );
    return withConnectionSyncTransaction(
      pool,
      input,
      async (transaction) => {
        await lockConnectionSyncCursor(transaction, input);
        const current = await loadIncrementalConnectionCursor(
          transaction,
          input,
        );
        if (
          current.historyId !== input.expectedHistoryId
          || current.nextPageToken !== input.expectedPageToken
        ) {
          return {
            state: "stale" as const,
            checkpoint: current,
            insertedMessages: 0,
          };
        }
        const committedHistoryId = input.nextPageToken === null
          ? input.latestHistoryId
          : input.expectedHistoryId;
        const updated = await transaction.query(
          `UPDATE backlinks.backlink_gmail_connection_sync_cursors
              SET history_id=$4,
                  next_page_token=$5,
                  last_synced_at=$6,
                  version=version+1,
                  updated_at=$6,
                  updated_by=$7
            WHERE organization_id=$1
              AND workspace_id=$2
              AND gmail_connection_id=$3
            RETURNING history_id AS "historyId",
                      next_page_token AS "nextPageToken",
                      initial_sync_completed_at AS
                        "initialSyncCompletedAt",
                      last_synced_at AS "lastSyncedAt"`,
          [
            input.organizationId,
            input.workspaceId,
            input.gmailConnectionId,
            committedHistoryId,
            input.nextPageToken,
            input.persistedAt,
            input.actorId,
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          throw new Error("Connection sync cursor could not be advanced.");
        }
        return {
          state: input.nextPageToken === null
            ? "completed" as const
            : "advanced" as const,
          checkpoint: incrementalCheckpointFromConnectionCursor(row),
          insertedMessages,
        };
      },
    );
  },
});

const loadConnectionSyncLanes = async (
  pool: BacklinkTenantPool,
  input: GmailPollingSyncWorkflowInput,
): Promise<readonly ConnectionSyncLane[]> => {
  const provider = createPostgresqlProjectScopeProvider(pool);
  const lanes: ConnectionSyncLane[] = [];
  let cursor: string | null = null;
  do {
    const page = await provider.listActiveProjectScopes({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      lane: "gmail-sync",
      cursor,
      limit: 100,
    });
    for (const scope of page.scopes) {
      const projectInput: GmailPollingSyncWorkflowInput = {
        ...input,
        websiteProjectId: scope.websiteProjectId,
      };
      try {
        await assertSyncKillSwitchOpen(pool, scope);
        const syncContext = await loadSyncContext(pool, projectInput);
        const projectionInputs = await loadProjectionInputs(
          pool,
          projectInput,
        );
        if (projectionInputs.outbound.length === 0) continue;
        lanes.push(Object.freeze({
          input: projectInput,
          syncContext,
          outbound: projectionInputs.outbound,
        }));
      } catch (error) {
        if (
          error instanceof BacklinkError
          && (
            error.code === backlinkErrorCodes.conflict
            || error.code === backlinkErrorCodes.notFound
          )
        ) {
          continue;
        }
        throw error;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(lanes);
};

const routesForConnectionSyncLanes = (
  lanes: readonly ConnectionSyncLane[],
): ReadonlyMap<string, readonly GmailPollingSyncWorkflowInput[]> => {
  const routes = new Map<string, GmailPollingSyncWorkflowInput[]>();
  for (const lane of lanes) {
    for (const outbound of lane.outbound) {
      const existing = routes.get(outbound.providerThreadId) ?? [];
      if (!existing.some((entry) =>
        entry.websiteProjectId === lane.input.websiteProjectId)) {
        existing.push(lane.input);
      }
      routes.set(outbound.providerThreadId, existing);
    }
  }
  return routes;
};

const persistProjection = async (
  pool: BacklinkTenantPool,
  input: GmailPollingSyncWorkflowInput,
  primaryEmail: string,
  raw: RawReferenceRow,
  parsed: MailMessage,
): Promise<Readonly<{
  projected: boolean;
  inboundMessageId: string | null;
  mailThreadId: string;
}>> => withBacklinkTenantTransaction(
  pool,
  scopeFrom(input),
  async (client) => {
    const threadId = randomUUID();
    const thread = await client.query(
      `INSERT INTO backlinks.backlink_mail_threads (
         id,organization_id,workspace_id,website_project_id,
         gmail_connection_id,provider_thread_id,
         created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         gmail_connection_id,provider_thread_id
       ) DO UPDATE SET updated_by=EXCLUDED.updated_by
       RETURNING id`,
      [
        threadId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.gmailConnectionId,
        raw.providerThreadId,
        input.actorId,
      ],
    );
    const persistedThread = thread.rows[0];
    if (persistedThread === undefined) {
      throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_THREAD_NOT_PERSISTED");
    }
    const persistedThreadId = String(persistedThread.id);
    const fromAddress = parsed.from?.address.toLowerCase() ?? null;
    const direction = fromAddress === primaryEmail ? "OUTBOUND" : "INBOUND";
    const receivedAt = parsed.sentAt === null
      ? raw.receivedAt
      : new Date(parsed.sentAt);
    const messageId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO backlinks.backlink_mail_messages (
         id,organization_id,workspace_id,website_project_id,
         gmail_connection_id,raw_message_reference_id,mail_thread_id,
         rfc_message_id,in_reply_to_message_id,reference_message_ids,
         from_address,to_addresses,cc_addresses,subject_text,received_at,
         direction,parse_status,parsed_at,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
         $11,$12::jsonb,$13::jsonb,$14,$15,$16,'PARSED',now(),$17,$17
       )
       ON CONFLICT (raw_message_reference_id) DO NOTHING
       RETURNING id`,
      [
        messageId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.gmailConnectionId,
        raw.id,
        persistedThreadId,
        parsed.rfcMessageId,
        parsed.inReplyToMessageId,
        JSON.stringify(parsed.referenceMessageIds),
        fromAddress,
        JSON.stringify(addresses(parsed.to)),
        JSON.stringify(addresses(parsed.cc)),
        parsed.subject,
        receivedAt,
        direction,
        input.actorId,
      ],
    );
    const projected = inserted.rows[0] !== undefined;
    const persistedMessage = projected
      ? inserted.rows[0]
      : (await client.query(
          `SELECT id
             FROM backlinks.backlink_mail_messages
            WHERE organization_id=$1
              AND workspace_id=$2
              AND website_project_id=$3
              AND raw_message_reference_id=$4`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            raw.id,
          ],
        )).rows[0];
    if (persistedMessage === undefined) {
      throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_MESSAGE_NOT_PERSISTED");
    }
    const persistedMessageId = String(persistedMessage.id);
    let inboundMessageId: string | null = null;
    if (direction === "INBOUND") {
      const inboundId = randomUUID();
      const inbound = await client.query(
        `INSERT INTO backlinks.backlink_inbound_messages (
           id,organization_id,workspace_id,website_project_id,
           gmail_connection_id,mail_message_id,received_at,
           created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (mail_message_id) DO NOTHING
         RETURNING id`,
        [
          inboundId,
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.gmailConnectionId,
          persistedMessageId,
          receivedAt,
          input.actorId,
        ],
      );
      const persistedInbound = inbound.rows[0] === undefined
        ? (await client.query(
            `SELECT id
               FROM backlinks.backlink_inbound_messages
              WHERE organization_id=$1
                AND workspace_id=$2
                AND website_project_id=$3
                AND mail_message_id=$4`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              persistedMessageId,
            ],
          )).rows[0]
        : inbound.rows[0];
      if (persistedInbound === undefined) {
        throw new Error("BACKLINK_LOCAL_PRODUCT_INBOUND_MESSAGE_NOT_PERSISTED");
      }
      inboundMessageId = String(persistedInbound.id);
    }
    await client.query(
      `WITH aggregate AS (
         SELECT count(*)::integer AS message_count,
                max(COALESCE(received_at,created_at)) AS latest_message_at
           FROM backlinks.backlink_mail_messages
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND mail_thread_id=$4
       )
       UPDATE backlinks.backlink_mail_threads AS thread
          SET message_count=aggregate.message_count,
              latest_message_at=aggregate.latest_message_at,
              updated_at=now(),
              updated_by=$5,
              version=CASE
                WHEN thread.message_count IS DISTINCT FROM aggregate.message_count
                  OR thread.latest_message_at IS DISTINCT FROM aggregate.latest_message_at
                THEN thread.version+1
                ELSE thread.version
              END
         FROM aggregate
        WHERE thread.organization_id=$1
          AND thread.workspace_id=$2
          AND thread.website_project_id=$3
          AND thread.id=$4`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        persistedThreadId,
        input.actorId,
      ],
    );
    return Object.freeze({
      projected,
      inboundMessageId,
      mailThreadId: persistedThreadId,
    });
  },
);

export const gmailConnectionPollingWorkflowId = (
  scope: Pick<SyncScope, "organizationId" | "workspaceId">,
  connectionId: string,
): string => buildBacklinksWorkflowId({
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
  websiteProjectId: "gmail-connection",
  workflow: "gmail-polling-sync",
  instanceId: connectionId,
});

const workflowAlreadyStarted = (error: unknown): boolean =>
  error instanceof Error
  && error.name === "WorkflowExecutionAlreadyStartedError";

export async function ensureLocalProductGmailPollingSyncWorkflow(
  options: Readonly<{
    workflowClient: Pick<BacklinksTemporalClient["workflow"], "start">;
    taskQueue: string;
    context: Readonly<{
      organizationId: string;
      workspaceId: string;
      gmailConnectionId: string;
      actorId: string;
    }>;
    pollingIntervalSeconds: number;
  }>,
): Promise<Readonly<{
  state: "started" | "existing";
  workflowId: string;
}>> {
  const workflowId = gmailConnectionPollingWorkflowId(
    options.context,
    options.context.gmailConnectionId,
  );
  try {
    await options.workflowClient.start(
      backlinksRuntimeContract.workflows.gmailPollingSync.workflowType,
      {
        workflowId,
        taskQueue: options.taskQueue,
        args: [{
          organizationId: options.context.organizationId,
          workspaceId: options.context.workspaceId,
          websiteProjectId: "gmail-connection",
          gmailConnectionId: options.context.gmailConnectionId,
          actorId: options.context.actorId,
          workflowId,
          pollingIntervalSeconds: options.pollingIntervalSeconds,
        } satisfies GmailPollingSyncWorkflowInput],
      },
    );
    return Object.freeze({ state: "started" as const, workflowId });
  } catch (error) {
    if (!workflowAlreadyStarted(error)) throw error;
    return Object.freeze({ state: "existing" as const, workflowId });
  }
}

export function createLocalProductGmailPollingSyncCommands(options: Readonly<{
  pool: BacklinkTenantPool;
  workflowClient: BacklinksTemporalClient["workflow"];
  taskQueue: string;
  capabilities: BacklinksLiveCapabilities;
}>): GmailPollingSyncCommands {
  const workflowIdFor = (
    scope: SyncScope,
    connectionId: string,
  ): string => gmailConnectionPollingWorkflowId(scope, connectionId);
  const assertActorCanSync = (context: ResolvedProjectContext): void => {
    if (!context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role))) {
      throw new BacklinkError({
        code: backlinkErrorCodes.accessDenied,
        message: "The current actor cannot access Gmail polling.",
      });
    }
  };
  return Object.freeze({
    async start(input) {
      if (!options.capabilities.gmailSyncEnabled) {
        throw new BacklinkError({
          code: backlinkErrorCodes.internal,
          message: "Gmail sync is disabled for this runtime.",
        });
      }
      assertActorCanSync(input.context);
      const scope = {
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
      };
      await assertSyncKillSwitchOpen(options.pool, scope);
      await loadSyncContext(options.pool, {
        ...scope,
        gmailConnectionId: input.connectionId,
        actorId: input.context.actor.userId,
        workflowId: "gmail-polling-preflight",
        pollingIntervalSeconds:
          options.capabilities.gmailPollingIntervalSeconds,
      });
      const workflowId = workflowIdFor(scope, input.connectionId);
      const ensured = await ensureLocalProductGmailPollingSyncWorkflow({
        workflowClient: options.workflowClient,
        taskQueue: options.taskQueue,
        context: {
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          gmailConnectionId: input.connectionId,
          actorId: input.context.actor.userId,
        },
        pollingIntervalSeconds:
          options.capabilities.gmailPollingIntervalSeconds,
      });
      if (ensured.state === "existing") {
        await options.workflowClient
          .getHandle(workflowId)
          .signal(gmailPollingSyncNowSignal);
      }
      return Object.freeze({ status: "ACCEPTED" as const, workflowId });
    },
    async status(input) {
      assertActorCanSync(input.context);
      const scope = {
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
      };
      const status = await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          const connection = await client.query(
            `SELECT
               connection.connection_status AS "connectionStatus",
               connection.mail_sync_capability AS "mailSyncCapability",
               connection.last_api_error_code AS "lastErrorCategory"
              FROM backlinks.backlink_gmail_connections AS connection
              JOIN backlinks.backlink_gmail_workspace_bindings AS binding
                ON binding.organization_id=connection.organization_id
               AND binding.workspace_id=$2
               AND binding.gmail_connection_id=connection.id
               AND binding.binding_status='ACTIVE'
              JOIN backlinks.backlink_website_project_mailbox_bindings
                AS project_binding
                ON project_binding.organization_id=binding.organization_id
               AND project_binding.workspace_id=binding.workspace_id
               AND project_binding.website_project_id=$3
               AND project_binding.gmail_workspace_binding_id=binding.id
               AND project_binding.binding_status='ACTIVE'
               AND project_binding.is_selected=true
             WHERE connection.organization_id=$1
               AND connection.id=$4
             LIMIT 1`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.connectionId,
            ],
          );
          const killSwitch = await client.query(
            `SELECT blocked
               FROM backlinks.backlink_kill_switch_versions
              WHERE organization_id=$1
                AND workspace_id=$2
                AND website_project_id=$3
                AND capability='GMAIL_SYNC'
              ORDER BY version DESC
              LIMIT 1`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
            ],
          );
          const acceptedSends = await client.query(
            `SELECT count(*)::integer AS count
               FROM backlinks.backlink_send_attempts AS attempt
               JOIN backlinks.backlink_send_intents AS intent
                 ON intent.organization_id=attempt.organization_id
                AND intent.workspace_id=attempt.workspace_id
                AND intent.website_project_id=attempt.website_project_id
                AND intent.id=attempt.send_intent_id
              WHERE attempt.organization_id=$1
                AND attempt.workspace_id=$2
                AND attempt.website_project_id=$3
                AND intent.gmail_connection_id=$4
                AND attempt.status='PROVIDER_ACCEPTED'
                AND attempt.provider_thread_id IS NOT NULL`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.connectionId,
            ],
          );
          const cursor = await client.query(
            `SELECT
               history_id AS "historyId",
               initial_sync_completed_at AS "initialSyncCompletedAt",
               last_synced_at AS "lastSyncedAt",
               version
              FROM backlinks.backlink_gmail_connection_sync_cursors
             WHERE organization_id=$1
               AND workspace_id=$2
               AND gmail_connection_id=$3`,
            [
              scope.organizationId,
              scope.workspaceId,
              input.connectionId,
            ],
          );
          return {
            connection: connection.rows[0],
            killSwitchOpen: killSwitch.rows[0]?.blocked === false,
            acceptedSendCount: Number(acceptedSends.rows[0]?.count ?? 0),
            cursor: cursor.rows[0],
          };
        },
      );
      if (status.connection === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "The Gmail account is not selected for this project.",
        });
      }
      const cursor = status.cursor === undefined
        ? null
        : Object.freeze({
            historyId: String(status.cursor.historyId),
            initialSyncCompletedAt:
              status.cursor.initialSyncCompletedAt === null
                ? null
                : new Date(String(
                    status.cursor.initialSyncCompletedAt,
                  )).toISOString(),
            lastSyncedAt: status.cursor.lastSyncedAt === null
              ? null
              : new Date(String(status.cursor.lastSyncedAt)).toISOString(),
            version: Number(status.cursor.version),
          });
      const connectionStatus = String(status.connection.connectionStatus);
      const connectionBlocked = connectionStatus !== "CONNECTED"
        || status.connection.mailSyncCapability !== true;
      const state = !options.capabilities.gmailSyncEnabled
        || !status.killSwitchOpen
        || connectionBlocked
        ? "BLOCKED" as const
        : status.acceptedSendCount === 0
        ? "WAITING_FOR_ACCEPTED_SEND" as const
        : "POLLING" as const;
      const connectionErrorCategory =
        status.connection.lastErrorCategory === "GOOGLE_AUTH_EXPIRED"
          ? "GOOGLE_AUTH_EXPIRED" as const
          : status.connection.lastErrorCategory === null
          ? null
          : "UNKNOWN" as const;
      let workflowStatus: GmailPollingSyncWorkflowStatus = {
        lastSuccessfulSyncAt: cursor?.lastSyncedAt ?? null,
        lastError: connectionStatus === "REAUTH_REQUIRED"
          ? "Gmail authorization requires reconnection."
          : connectionStatus === "TOKEN_REVOKED"
          ? "Gmail authorization was revoked by the user."
          : connectionStatus === "DISCONNECTED"
          ? "Gmail connection is disconnected."
          : status.connection.mailSyncCapability !== true
          ? "Gmail sync capability is unavailable."
          : null,
        lastErrorCategory: connectionErrorCategory,
        nextRetryAt: null,
        consecutiveFailures: 0,
      };
      if (state === "POLLING") {
        try {
          const queriedStatus = await withGmailPollingStatusQueryTimeout(
            options.workflowClient
              .getHandle(workflowIdFor(scope, input.connectionId))
              .query<GmailPollingSyncWorkflowStatus>(
                gmailPollingSyncStatusQuery,
              ),
          );
          workflowStatus = {
            lastSuccessfulSyncAt:
              queriedStatus.lastSuccessfulSyncAt ?? null,
            lastError: queriedStatus.lastError ?? null,
            lastErrorCategory: queriedStatus.lastErrorCategory ?? null,
            nextRetryAt: queriedStatus.nextRetryAt ?? null,
            consecutiveFailures: queriedStatus.consecutiveFailures ?? 0,
          };
        } catch (error) {
          workflowStatus = {
            lastSuccessfulSyncAt: cursor?.lastSyncedAt ?? null,
            lastError: error instanceof Error
              ? error.message.slice(0, 1_000)
              : "Gmail polling workflow status is unavailable.",
            lastErrorCategory: "UNKNOWN",
            nextRetryAt: null,
            consecutiveFailures: 0,
          };
        }
      }
      return Object.freeze({
        state,
        workflowId: workflowIdFor(scope, input.connectionId),
        pollingIntervalSeconds:
          options.capabilities.gmailPollingIntervalSeconds,
        killSwitchOpen: status.killSwitchOpen,
        acceptedSendCount: status.acceptedSendCount,
        ...workflowStatus,
        cursor,
      });
    },
  });
}

export async function createLocalProductGmailPollingSyncRuntime(
  options: Readonly<{
    pool: BacklinkTenantPool;
    capabilities: BacklinksLiveCapabilities;
  }>,
) {
  const { capabilities, pool } = options;
  if (
    !capabilities.gmailSyncEnabled
    || capabilities.secretStoreRoot === null
    || capabilities.googleOauthClientId === null
    || capabilities.googleOauthClientSecretReference === null
    || capabilities.googleOauthRedirectUri === null
  ) {
    throw new Error("BACKLINK_LOCAL_PRODUCT_GMAIL_SYNC_CONFIGURATION_INVALID");
  }
  const secretStore = new SecretStoreClientAdapter({
    config: { enabled: true, provider: "platform-secret-store" },
    client: new LocalProductSecretStoreClient({
      rootDirectory: capabilities.secretStoreRoot,
    }),
  });
  const googleAuth = new GoogleAuthClientAdapter({
    config: {
      enabled: true,
      redirectUris: [capabilities.googleOauthRedirectUri],
    },
    client: new GoogleAuthLibraryClient({
      clientId: capabilities.googleOauthClientId,
      clientSecret: await secretStore.resolve({
        reference: parseLocalProductSecretReference(
          capabilities.googleOauthClientSecretReference,
          secretKinds.googleOauthClientSecret,
        ),
        context: {
          organizationId: "local-product",
          subjectProvider: "google",
        },
      }),
    }),
  });
  const tokenRepository = new SecretBackedGmailConnectionRepository({
    secretStore,
    googleAuth,
    persistence: new PostgresqlGmailConnectionRepository({ pool }),
    refreshLock: new PostgresqlGmailConnectionRefreshLock(pool),
  });
  const rawStore = new LocalProductMailRawObjectStore(
    rawStoreRoot(capabilities),
  );
  const replyMatches = new PostgresqlReplyMatchRepository({ pool });

  return Object.freeze({
    async run(
      input: GmailPollingSyncWorkflowInput,
    ): Promise<GmailPollingSyncWorkflowResult> {
      const lanes = await loadConnectionSyncLanes(pool, input);
      if (lanes.length === 0) {
        return Object.freeze({
          workflowId: input.workflowId,
          initialOutcome: "WAITING_FOR_ACCEPTED_SEND",
          incrementalOutcome: "WAITING_FOR_ACCEPTED_SEND",
          rawMessagesPersisted: 0,
          messagesProjected: 0,
          inboundMessagesProjected: 0,
          repliesMatched: 0,
        });
      }
      const routes = routesForConnectionSyncLanes(lanes);
      const outbound = lanes.flatMap((lane) => lane.outbound);
      const provider = new GoogleGmailProviderClient({
        resolveAccessToken: async (connectionId) => {
          const currentLanes = await loadConnectionSyncLanes(pool, input);
          const currentProviderContext = currentLanes[0];
          if (currentProviderContext === undefined) {
            throw new Error(
              "BACKLINK_LOCAL_PRODUCT_GMAIL_SYNC_LANE_UNAVAILABLE",
            );
          }
          return tokenRepository.resolveAccessToken({
            context: currentProviderContext.syncContext.resolved,
            connectionId,
          });
        },
      });
      const initialQuery = buildLocalProductGmailInitialQuery(
        outbound,
        capabilities.mode,
      );
      const gmailClient = new GmailSyncClientAdapter({
        config: {
          enabled: true,
          initialQuery,
        },
        client: provider,
      });
      const gmailSync = restrictSyncToThreads(
        gmailClient,
        new Set(routes.keys()),
      );
      const workflowContext = {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: "gmail-connection",
        gmailConnectionId: input.gmailConnectionId,
        actorId: input.actorId,
      };
      const initial = await runGmailInitialSyncWorkflow(workflowContext, {
        gmailSync,
        repository: createConnectionInitialSyncRepository(pool, routes),
        rawObjectStore: rawStore,
      });
      const activeLanes = await loadConnectionSyncLanes(pool, input);
      if (activeLanes.length === 0) {
        throw new Error(
          "BACKLINK_LOCAL_PRODUCT_GMAIL_SYNC_LANE_UNAVAILABLE",
        );
      }
      const activeRoutes = routesForConnectionSyncLanes(activeLanes);
      const incrementalGmailSync = restrictSyncToThreads(
        gmailClient,
        new Set(activeRoutes.keys()),
      );
      const incremental = await runGmailIncrementalSyncWorkflow(
        workflowContext,
        {
          gmailSync: incrementalGmailSync,
          repository: createConnectionIncrementalSyncRepository(
            pool,
            activeRoutes,
          ),
          rawObjectStore: rawStore,
        },
      );

      let messagesProjected = 0;
      let inboundMessagesProjected = 0;
      let repliesMatched = 0;
      for (const lane of activeLanes) {
        const projectionInputs = await loadProjectionInputs(
          pool,
          lane.input,
        );
        for (const raw of projectionInputs.rawReferences) {
          const content = await rawStore.get({
            rawObjectKey: raw.rawObjectKey,
          });
          if (content === null) {
            throw new Error("BACKLINK_LOCAL_PRODUCT_MAIL_OBJECT_MISSING");
          }
          const parsed = await parseGmailMimeMessage(content);
          const projection = await persistProjection(
            pool,
            lane.input,
            lane.syncContext.primaryEmail,
            raw,
            parsed,
          );
          if (projection.projected) messagesProjected += 1;
          if (projection.inboundMessageId === null) continue;
          if (projection.projected) inboundMessagesProjected += 1;
          const outboundReferences: OutboundReplyReference[] =
            projectionInputs.outbound
              .filter((reference) =>
                reference.providerThreadId === raw.providerThreadId)
              .map((reference) => ({
                organizationId: lane.input.organizationId,
                workspaceId: lane.input.workspaceId,
                websiteProjectId: lane.input.websiteProjectId,
                gmailConnectionId: lane.input.gmailConnectionId,
                opportunityId: reference.opportunityId,
                mailThreadId: projection.mailThreadId,
                providerThreadId: reference.providerThreadId,
                rfcMessageId: reference.rfcMessageId,
                bodyFingerprint: bodyFingerprint(reference.bodyText),
                contactAddress: reference.contactAddress,
                participantAddresses: [
                  lane.syncContext.primaryEmail,
                  reference.contactAddress,
                ],
                subject: reference.subject,
                sentAt: reference.sentAt,
              }));
          const result = matchInboundReply({
            organizationId: lane.input.organizationId,
            workspaceId: lane.input.workspaceId,
            websiteProjectId: lane.input.websiteProjectId,
            gmailConnectionId: lane.input.gmailConnectionId,
            providerThreadId: raw.providerThreadId,
            inReplyToMessageId: parsed.inReplyToMessageId,
            referenceMessageIds: parsed.referenceMessageIds,
            quotedBodyFingerprints: quotedBodyFingerprints(
              parsed.body.text,
            ),
            fromAddress: parsed.from?.address ?? null,
            participantAddresses: [
              ...(parsed.from === null ? [] : [parsed.from.address]),
              ...addresses(parsed.to),
              ...addresses(parsed.cc),
            ],
            subject: parsed.subject,
            receivedAt: parsed.sentAt === null
              ? raw.receivedAt
              : new Date(parsed.sentAt),
          }, outboundReferences);
          const saved = await replyMatches.saveMatchResult({
            organizationId: lane.input.organizationId,
            workspaceId: lane.input.workspaceId,
            websiteProjectId: lane.input.websiteProjectId,
            gmailConnectionId: lane.input.gmailConnectionId,
            inboundMessageId: projection.inboundMessageId,
            actorId: lane.input.actorId,
            result,
          });
          if (
            saved.state === "saved"
            && saved.matchStatus === "MATCH_CONFIRMED"
          ) {
            repliesMatched += 1;
          }
        }
      }
      const initialPersisted = "messagesPersisted" in initial
        ? initial.messagesPersisted
        : 0;
      const incrementalPersisted = "messagesPersisted" in incremental
        ? incremental.messagesPersisted
        : 0;
      return Object.freeze({
        workflowId: input.workflowId,
        initialOutcome: initial.outcome,
        incrementalOutcome: incremental.outcome,
        rawMessagesPersisted: initialPersisted + incrementalPersisted,
        messagesProjected,
        inboundMessagesProjected,
        repliesMatched,
      });
    },
  });
}
