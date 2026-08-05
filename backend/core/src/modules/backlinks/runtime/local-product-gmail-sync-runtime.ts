import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  PostgresqlInitialMailSyncRepository,
} from "../application/services/mail-initial-sync.repository.js";
import {
  PostgresqlIncrementalMailSyncRepository,
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
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
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
          AND binding.website_project_id=$3
          AND binding.gmail_connection_id=connection.id
        AND binding.binding_status='ACTIVE'
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

export function createLocalProductGmailPollingSyncCommands(options: Readonly<{
  pool: BacklinkTenantPool;
  workflowClient: BacklinksTemporalClient["workflow"];
  taskQueue: string;
  capabilities: BacklinksLiveCapabilities;
}>): GmailPollingSyncCommands {
  const workflowIdFor = (
    scope: SyncScope,
    connectionId: string,
  ): string => buildBacklinksWorkflowId({
    workspaceId: scope.workspaceId,
    websiteProjectId: scope.websiteProjectId,
    workflow: "gmail-polling-sync",
    instanceId: connectionId,
  });
  const workflowAlreadyStarted = (error: unknown): boolean =>
    error instanceof Error
    && error.name === "WorkflowExecutionAlreadyStartedError";
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
      try {
        await options.workflowClient.start(
          backlinksRuntimeContract.workflows.gmailPollingSync.workflowType,
          {
            workflowId,
            taskQueue: options.taskQueue,
            args: [{
              ...scope,
              gmailConnectionId: input.connectionId,
              actorId: input.context.actor.userId,
              workflowId,
              pollingIntervalSeconds:
                options.capabilities.gmailPollingIntervalSeconds,
            } satisfies GmailPollingSyncWorkflowInput],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
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
      await loadSyncContext(options.pool, {
        ...scope,
        gmailConnectionId: input.connectionId,
        actorId: input.context.actor.userId,
        workflowId: "gmail-polling-status",
        pollingIntervalSeconds:
          options.capabilities.gmailPollingIntervalSeconds,
      });
      const status = await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          const [killSwitch, acceptedSends, cursor] = await Promise.all([
            client.query(
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
            ),
            client.query(
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
            ),
            client.query(
              `SELECT
                 history_id AS "historyId",
                 initial_sync_completed_at AS "initialSyncCompletedAt",
                 last_synced_at AS "lastSyncedAt",
                 version
                FROM backlinks.backlink_mail_sync_cursors
               WHERE organization_id=$1
                 AND workspace_id=$2
                 AND website_project_id=$3
                 AND gmail_connection_id=$4`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.connectionId,
              ],
            ),
          ]);
          return {
            killSwitchOpen: killSwitch.rows[0]?.blocked === false,
            acceptedSendCount: Number(acceptedSends.rows[0]?.count ?? 0),
            cursor: cursor.rows[0],
          };
        },
      );
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
      return Object.freeze({
        state: !options.capabilities.gmailSyncEnabled
          || !status.killSwitchOpen
          ? "BLOCKED" as const
          : status.acceptedSendCount === 0
          ? "WAITING_FOR_ACCEPTED_SEND" as const
          : "POLLING" as const,
        workflowId: workflowIdFor(scope, input.connectionId),
        pollingIntervalSeconds:
          options.capabilities.gmailPollingIntervalSeconds,
        killSwitchOpen: status.killSwitchOpen,
        acceptedSendCount: status.acceptedSendCount,
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
      await assertSyncKillSwitchOpen(pool, scopeFrom(input));
      const syncContext = await loadSyncContext(pool, input);
      const provider = new GoogleGmailProviderClient({
        resolveAccessToken: async (connectionId) => {
          await assertSyncKillSwitchOpen(pool, scopeFrom(input));
          return tokenRepository.resolveAccessToken({
            context: syncContext.resolved,
            connectionId,
          });
        },
      });
      const existingInputs = await loadProjectionInputs(pool, input);
      if (existingInputs.outbound.length === 0) {
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
      const initialQuery = buildLocalProductGmailInitialQuery(
        existingInputs.outbound,
        capabilities.mode,
      );
      const gmailSync = restrictSyncToThreads(new GmailSyncClientAdapter({
        config: {
          enabled: true,
          initialQuery,
        },
        client: provider,
      }), new Set(existingInputs.outbound.map((outbound) =>
        outbound.providerThreadId)));
      const workflowContext = {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        gmailConnectionId: input.gmailConnectionId,
        actorId: input.actorId,
      };
      const initial = await runGmailInitialSyncWorkflow(workflowContext, {
        gmailSync,
        repository: new PostgresqlInitialMailSyncRepository({ pool }),
        rawObjectStore: rawStore,
      });
      await assertSyncKillSwitchOpen(pool, scopeFrom(input));
      const incremental = await runGmailIncrementalSyncWorkflow(
        workflowContext,
        {
          gmailSync,
          repository: new PostgresqlIncrementalMailSyncRepository({ pool }),
          rawObjectStore: rawStore,
        },
      );

      const projectionInputs = await loadProjectionInputs(pool, input);
      let messagesProjected = 0;
      let inboundMessagesProjected = 0;
      let repliesMatched = 0;
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
          input,
          syncContext.primaryEmail,
          raw,
          parsed,
        );
        if (projection.projected) messagesProjected += 1;
        if (projection.inboundMessageId === null) continue;
        if (projection.projected) inboundMessagesProjected += 1;
        const outboundReferences: OutboundReplyReference[] =
          projectionInputs.outbound
            .filter((outbound) =>
              outbound.providerThreadId === raw.providerThreadId)
            .map((outbound) => ({
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              websiteProjectId: input.websiteProjectId,
              gmailConnectionId: input.gmailConnectionId,
              opportunityId: outbound.opportunityId,
              mailThreadId: projection.mailThreadId,
              providerThreadId: outbound.providerThreadId,
              rfcMessageId: outbound.rfcMessageId,
              bodyFingerprint: bodyFingerprint(outbound.bodyText),
              contactAddress: outbound.contactAddress,
              participantAddresses: [
                syncContext.primaryEmail,
                outbound.contactAddress,
              ],
              subject: outbound.subject,
              sentAt: outbound.sentAt,
            }));
        const result = matchInboundReply({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          gmailConnectionId: input.gmailConnectionId,
          providerThreadId: raw.providerThreadId,
          inReplyToMessageId: parsed.inReplyToMessageId,
          referenceMessageIds: parsed.referenceMessageIds,
          quotedBodyFingerprints: quotedBodyFingerprints(parsed.body.text),
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
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          gmailConnectionId: input.gmailConnectionId,
          inboundMessageId: projection.inboundMessageId,
          actorId: input.actorId,
          result,
        });
        if (
          saved.state === "saved"
          && saved.matchStatus === "MATCH_CONFIRMED"
        ) {
          repliesMatched += 1;
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
