import { createHash, randomUUID } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";
import {
  gmailHistoryRepairLookbackDays,
  gmailHistoryRepairMaxMessages,
  gmailHistoryRepairMaxPages,
} from "../policies/mail-history-repair.policy.js";
import type {
  IncrementalMailSyncCheckpoint,
  IncrementalMailSyncContext,
  PersistedIncrementalMailMessage,
} from "./mail-incremental-sync.repository.js";

export type MailHistoryRepairContext = IncrementalMailSyncContext;
export type PersistedMailHistoryRepairMessage =
  PersistedIncrementalMailMessage;

export type CommitMailHistoryRepairInput =
  MailHistoryRepairContext & Readonly<{
    expectedHistoryId: string;
    expectedPageToken: string | null;
    repairedHistoryId: string;
    messages: readonly PersistedMailHistoryRepairMessage[];
    repairWindowStartedAt: Date;
    repairWindowEndedAt: Date;
    pagesScanned: number;
    messagesScanned: number;
    repairedAt: Date;
  }>;

export type CommitMailHistoryRepairResult = Readonly<{
  state: "completed" | "stale";
  checkpoint: IncrementalMailSyncCheckpoint;
  insertedMessages: number;
}>;

export interface MailHistoryRepairRepository {
  loadCheckpoint(
    input: MailHistoryRepairContext,
  ): Promise<IncrementalMailSyncCheckpoint>;
  commitRepair(
    input: CommitMailHistoryRepairInput,
  ): Promise<CommitMailHistoryRepairResult>;
}

type PostgresqlMailHistoryRepairRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

const historyIdPattern = /^[1-9][0-9]*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const dayMilliseconds = 24 * 60 * 60 * 1_000;

const assertNonBlank = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const assertDate = (value: Date, name: string): void => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
};

const assertHistoryId = (value: string, name: string): void => {
  if (!historyIdPattern.test(value)) {
    throw new TypeError(`${name} must be a positive numeric History ID.`);
  }
};

const assertContext = (input: MailHistoryRepairContext): void => {
  assertNonBlank(input.organizationId, "History repair organizationId");
  assertNonBlank(input.workspaceId, "History repair workspaceId");
  assertNonBlank(input.websiteProjectId, "History repair websiteProjectId");
  assertNonBlank(input.gmailConnectionId, "History repair gmailConnectionId");
  assertNonBlank(input.actorId, "History repair actorId");
};

const assertPageToken = (value: string | null, name: string): void => {
  if (value !== null) assertNonBlank(value, name);
};

const assertMessage = (message: PersistedMailHistoryRepairMessage): void => {
  assertNonBlank(message.providerMessageId, "History repair providerMessageId");
  assertNonBlank(message.providerThreadId, "History repair providerThreadId");
  assertHistoryId(message.historyId, "History repair message historyId");
  assertDate(message.receivedAt, "History repair message receivedAt");
  assertNonBlank(message.rawObjectKey, "History repair rawObjectKey");
  if (!sha256Pattern.test(message.rawContentSha256)) {
    throw new TypeError("History repair rawContentSha256 must be SHA-256.");
  }
  if (
    !Number.isSafeInteger(message.rawSizeBytes)
    || message.rawSizeBytes < 0
  ) {
    throw new TypeError(
      "History repair rawSizeBytes must be non-negative.",
    );
  }
  assertDate(message.fetchedAt, "History repair message fetchedAt");
  assertDate(
    message.retentionExpiresAt,
    "History repair message retentionExpiresAt",
  );
  if (message.retentionExpiresAt.getTime() <= message.fetchedAt.getTime()) {
    throw new TypeError("History repair retention must expire after fetch.");
  }
};

const dateFromRow = (value: unknown, name: string): Date => {
  const date = value instanceof Date ? value : new Date(String(value));
  assertDate(date, name);
  return date;
};

const nullableDateFromRow = (
  value: unknown,
  name: string,
): Date | null => value === null ? null : dateFromRow(value, name);

const nullableStringFromRow = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} returned an invalid value.`);
  }
  return value;
};

const checkpointFromRow = (
  row: Record<string, unknown>,
): IncrementalMailSyncCheckpoint => {
  const historyId = nullableStringFromRow(
    row.historyId,
    "History repair historyId",
  );
  if (historyId === null || row.initialSyncCompletedAt === null) {
    throw new Error(
      "Initial Mail Sync must complete before History repair.",
    );
  }
  assertHistoryId(historyId, "History repair historyId");
  return Object.freeze({
    historyId,
    nextPageToken: nullableStringFromRow(
      row.nextPageToken,
      "History repair nextPageToken",
    ),
    initialSyncCompletedAt: dateFromRow(
      row.initialSyncCompletedAt,
      "History repair initialSyncCompletedAt",
    ),
    lastSyncedAt: nullableDateFromRow(
      row.lastSyncedAt,
      "History repair lastSyncedAt",
    ),
  });
};

const assertSyncConnectionAvailable = async (
  transaction: BacklinkTransactionClient,
  input: MailHistoryRepairContext,
): Promise<void> => {
  const result = await transaction.query(
    `SELECT connection.id
       FROM backlinks.backlink_gmail_connections AS connection
       JOIN backlinks.backlink_gmail_workspace_bindings AS binding
         ON binding.organization_id = connection.organization_id
        AND binding.gmail_connection_id = connection.id
       JOIN backlinks.backlink_website_project_mailbox_bindings AS project_binding
         ON project_binding.organization_id = binding.organization_id
        AND project_binding.workspace_id = binding.workspace_id
        AND project_binding.gmail_workspace_binding_id = binding.id
      WHERE connection.organization_id = $1
        AND connection.id = $2
        AND connection.connection_status = 'CONNECTED'
          AND connection.mail_sync_capability = true
          AND binding.workspace_id = $3
          AND binding.binding_status = 'ACTIVE'
          AND project_binding.website_project_id = $4
          AND project_binding.binding_status = 'ACTIVE'
          AND project_binding.is_selected = true
      LIMIT 1`,
    [
      input.organizationId,
      input.gmailConnectionId,
      input.workspaceId,
      input.websiteProjectId,
    ],
  );
  if (result.rows[0] === undefined) {
    throw new Error(
      "Gmail connection is unavailable for History repair.",
    );
  }
};

const loadCheckpoint = async (
  transaction: BacklinkTransactionClient,
  input: MailHistoryRepairContext,
  lock: boolean,
): Promise<IncrementalMailSyncCheckpoint> => {
  const result = await transaction.query(
    `SELECT cursor.history_id AS "historyId",
            cursor.next_page_token AS "nextPageToken",
            cursor.initial_sync_completed_at AS "initialSyncCompletedAt",
            cursor.last_synced_at AS "lastSyncedAt"
       FROM backlinks.backlink_mail_sync_cursors AS cursor
      WHERE cursor.organization_id = $1
        AND cursor.workspace_id = $2
        AND cursor.website_project_id = $3
        AND cursor.gmail_connection_id = $4
      ${lock ? "FOR UPDATE" : ""}`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.gmailConnectionId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      "Initial Mail Sync must complete before History repair.",
    );
  }
  return checkpointFromRow(row);
};

const auditIntegrityHash = (
  previousIntegrityHash: string | null,
  input: CommitMailHistoryRepairInput,
  insertedMessages: number,
): string => createHash("sha256").update(JSON.stringify({
  previousIntegrityHash,
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  websiteProjectId: input.websiteProjectId,
  gmailConnectionId: input.gmailConnectionId,
  actorId: input.actorId,
  expectedHistoryId: input.expectedHistoryId,
  repairedHistoryId: input.repairedHistoryId,
  repairWindowStartedAt: input.repairWindowStartedAt.toISOString(),
  repairWindowEndedAt: input.repairWindowEndedAt.toISOString(),
  pagesScanned: input.pagesScanned,
  messagesScanned: input.messagesScanned,
  insertedMessages,
  repairedAt: input.repairedAt.toISOString(),
})).digest("hex");

export class PostgresqlMailHistoryRepairRepository
implements MailHistoryRepairRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(
    dependencies: PostgresqlMailHistoryRepairRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async loadCheckpoint(
    input: MailHistoryRepairContext,
  ): Promise<IncrementalMailSyncCheckpoint> {
    assertContext(input);
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await assertSyncConnectionAvailable(transaction, input);
      return loadCheckpoint(transaction, input, false);
    });
  }

  async commitRepair(
    input: CommitMailHistoryRepairInput,
  ): Promise<CommitMailHistoryRepairResult> {
    assertContext(input);
    assertHistoryId(input.expectedHistoryId, "History repair expectedHistoryId");
    assertPageToken(
      input.expectedPageToken,
      "History repair expectedPageToken",
    );
    assertHistoryId(input.repairedHistoryId, "History repair repairedHistoryId");
    assertDate(input.repairWindowStartedAt, "History repair window start");
    assertDate(input.repairWindowEndedAt, "History repair window end");
    assertDate(input.repairedAt, "History repair repairedAt");
    if (
      input.repairWindowEndedAt.getTime()
        - input.repairWindowStartedAt.getTime()
      !== gmailHistoryRepairLookbackDays * dayMilliseconds
    ) {
      throw new TypeError("History repair must use the fixed safe window.");
    }
    if (
      !Number.isSafeInteger(input.pagesScanned)
      || input.pagesScanned < 1
      || input.pagesScanned > gmailHistoryRepairMaxPages
    ) {
      throw new TypeError("History repair pagesScanned exceeds policy.");
    }
    if (
      !Number.isSafeInteger(input.messagesScanned)
      || input.messagesScanned < 0
      || input.messagesScanned > gmailHistoryRepairMaxMessages
    ) {
      throw new TypeError("History repair messagesScanned exceeds policy.");
    }
    if (input.messages.length > input.messagesScanned) {
      throw new TypeError(
        "History repair persisted messages exceed scanned messages.",
      );
    }
    for (const message of input.messages) assertMessage(message);

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `mail-history-repair:${input.organizationId}:${input.workspaceId}:`
          + `${input.websiteProjectId}:${input.gmailConnectionId}`,
        ],
      );
      await assertSyncConnectionAvailable(transaction, input);
      const checkpoint = await loadCheckpoint(transaction, input, true);
      if (
        checkpoint.historyId !== input.expectedHistoryId
        || checkpoint.nextPageToken !== input.expectedPageToken
      ) {
        return {
          state: "stale",
          checkpoint,
          insertedMessages: 0,
        };
      }

      let insertedMessages = 0;
      for (const message of input.messages) {
        const inserted = await transaction.query(
          `INSERT INTO backlinks.backlink_mail_raw_message_references (
             id, organization_id, workspace_id, website_project_id,
             gmail_connection_id, provider_message_id, provider_thread_id,
             history_id, raw_object_key, raw_content_sha256, raw_size_bytes,
             fetched_at, retention_expires_at, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )
           ON CONFLICT (
             organization_id, workspace_id, website_project_id,
             gmail_connection_id, provider_message_id
           ) DO NOTHING
           RETURNING id`,
          [
            this.#newId(),
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
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
        insertedMessages += inserted.rowCount ?? 0;
      }

      const updated = await transaction.query(
        `UPDATE backlinks.backlink_mail_sync_cursors AS cursor
            SET history_id = $5,
                next_page_token = NULL,
                last_synced_at = $6,
                version = cursor.version + 1,
                updated_at = $6,
                updated_by = $7
          WHERE cursor.organization_id = $1
            AND cursor.workspace_id = $2
            AND cursor.website_project_id = $3
            AND cursor.gmail_connection_id = $4
          RETURNING cursor.history_id AS "historyId",
                    cursor.next_page_token AS "nextPageToken",
                    cursor.initial_sync_completed_at AS "initialSyncCompletedAt",
                    cursor.last_synced_at AS "lastSyncedAt"`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.gmailConnectionId,
          input.repairedHistoryId,
          input.repairedAt,
          input.actorId,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("History repair checkpoint could not be advanced.");
      }

      const previousAudit = await transaction.query(
        `SELECT audit.integrity_hash AS "integrityHash"
           FROM backlinks.backlink_audit_events AS audit
          WHERE audit.organization_id = $1
            AND audit.workspace_id = $2
            AND audit.website_project_id = $3
          ORDER BY audit.created_at DESC, audit.id DESC
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
        ],
      );
      const previousIntegrityHash = nullableStringFromRow(
        previousAudit.rows[0]?.integrityHash ?? null,
        "History repair previous audit integrityHash",
      );
      const correlationId =
        `mail-history-repair:${input.gmailConnectionId}:`
        + input.repairedAt.toISOString();
      await transaction.query(
        `INSERT INTO backlinks.backlink_audit_events (
           id, organization_id, workspace_id, website_project_id,
           actor_id, actor_kind, action, target_type, target_id, outcome,
           reason, before_redacted, after_redacted, request_id, correlation_id,
           previous_integrity_hash, integrity_hash
         ) VALUES (
           $1, $2, $3, $4, $5, 'system', 'gmail.history.repair.completed',
           'gmail_connection', $6, 'success', 'history_expired', $7::jsonb,
           $8::jsonb, $9, $9, $10, $11
         )`,
        [
          this.#newId(),
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.actorId,
          input.gmailConnectionId,
          JSON.stringify({
            historyId: input.expectedHistoryId,
            pageTokenPresent: input.expectedPageToken !== null,
          }),
          JSON.stringify({
            historyId: input.repairedHistoryId,
            lookbackDays: gmailHistoryRepairLookbackDays,
            pagesScanned: input.pagesScanned,
            messagesScanned: input.messagesScanned,
            messagesInserted: insertedMessages,
          }),
          correlationId,
          previousIntegrityHash,
          auditIntegrityHash(previousIntegrityHash, input, insertedMessages),
        ],
      );

      return {
        state: "completed",
        checkpoint: checkpointFromRow(row),
        insertedMessages,
      };
    });
  }
}
