import { randomUUID } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export type IncrementalMailSyncContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
  actorId: string;
}>;

export type IncrementalMailSyncCheckpoint = Readonly<{
  historyId: string;
  nextPageToken: string | null;
  initialSyncCompletedAt: Date;
  lastSyncedAt: Date | null;
}>;

export type PersistedIncrementalMailMessage = Readonly<{
  providerMessageId: string;
  providerThreadId: string;
  historyId: string;
  receivedAt: Date;
  rawObjectKey: string;
  rawContentSha256: string;
  rawSizeBytes: number;
  fetchedAt: Date;
  retentionExpiresAt: Date;
}>;

export type PersistIncrementalMailSyncPageInput =
  IncrementalMailSyncContext & Readonly<{
    expectedHistoryId: string;
    expectedPageToken: string | null;
    latestHistoryId: string;
    nextPageToken: string | null;
    messages: readonly PersistedIncrementalMailMessage[];
    persistedAt: Date;
  }>;

export type PersistIncrementalMailSyncPageResult = Readonly<{
  state: "advanced" | "completed" | "stale";
  checkpoint: IncrementalMailSyncCheckpoint;
  insertedMessages: number;
}>;

export interface IncrementalMailSyncRepository {
  loadCheckpoint(
    input: IncrementalMailSyncContext,
  ): Promise<IncrementalMailSyncCheckpoint>;
  persistPage(
    input: PersistIncrementalMailSyncPageInput,
  ): Promise<PersistIncrementalMailSyncPageResult>;
}

type PostgresqlIncrementalMailSyncRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

const historyIdPattern = /^[1-9][0-9]*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

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

const assertContext = (input: IncrementalMailSyncContext): void => {
  assertNonBlank(input.organizationId, "Incremental sync organizationId");
  assertNonBlank(input.workspaceId, "Incremental sync workspaceId");
  assertNonBlank(input.websiteProjectId, "Incremental sync websiteProjectId");
  assertNonBlank(input.gmailConnectionId, "Incremental sync gmailConnectionId");
  assertNonBlank(input.actorId, "Incremental sync actorId");
};

const assertPageToken = (value: string | null, name: string): void => {
  if (value !== null) assertNonBlank(value, name);
};

const assertMessage = (message: PersistedIncrementalMailMessage): void => {
  assertNonBlank(
    message.providerMessageId,
    "Incremental sync providerMessageId",
  );
  assertNonBlank(
    message.providerThreadId,
    "Incremental sync providerThreadId",
  );
  assertHistoryId(message.historyId, "Incremental sync message historyId");
  assertDate(message.receivedAt, "Incremental sync message receivedAt");
  assertNonBlank(message.rawObjectKey, "Incremental sync rawObjectKey");
  if (!sha256Pattern.test(message.rawContentSha256)) {
    throw new TypeError("Incremental sync rawContentSha256 must be SHA-256.");
  }
  if (
    !Number.isSafeInteger(message.rawSizeBytes)
    || message.rawSizeBytes < 0
  ) {
    throw new TypeError(
      "Incremental sync rawSizeBytes must be non-negative.",
    );
  }
  assertDate(message.fetchedAt, "Incremental sync message fetchedAt");
  assertDate(
    message.retentionExpiresAt,
    "Incremental sync message retentionExpiresAt",
  );
  if (message.retentionExpiresAt.getTime() <= message.fetchedAt.getTime()) {
    throw new TypeError(
      "Incremental sync message retention must expire after fetch.",
    );
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
    "Incremental sync historyId",
  );
  const initialSyncCompletedAt = row.initialSyncCompletedAt;
  if (historyId === null || initialSyncCompletedAt === null) {
    throw new Error(
      "Initial Mail Sync must complete before Incremental Mail Sync.",
    );
  }
  assertHistoryId(historyId, "Incremental sync historyId");
  return Object.freeze({
    historyId,
    nextPageToken: nullableStringFromRow(
      row.nextPageToken,
      "Incremental sync nextPageToken",
    ),
    initialSyncCompletedAt: dateFromRow(
      initialSyncCompletedAt,
      "Incremental sync initialSyncCompletedAt",
    ),
    lastSyncedAt: nullableDateFromRow(
      row.lastSyncedAt,
      "Incremental sync lastSyncedAt",
    ),
  });
};

const loadCheckpoint = async (
  transaction: BacklinkTransactionClient,
  input: IncrementalMailSyncContext,
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
      "Initial Mail Sync must complete before Incremental Mail Sync.",
    );
  }
  return checkpointFromRow(row);
};

const assertSyncConnectionAvailable = async (
  transaction: BacklinkTransactionClient,
  input: IncrementalMailSyncContext,
): Promise<void> => {
  const result = await transaction.query(
    `SELECT connection.id
       FROM backlinks.backlink_gmail_connections AS connection
       JOIN backlinks.backlink_gmail_workspace_bindings AS binding
         ON binding.organization_id = connection.organization_id
        AND binding.gmail_connection_id = connection.id
      WHERE connection.organization_id = $1
        AND connection.id = $2
        AND connection.connection_status = 'CONNECTED'
          AND connection.mail_sync_capability = true
          AND binding.workspace_id = $3
          AND binding.website_project_id = $4
          AND binding.binding_status = 'ACTIVE'
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
      "Gmail connection is unavailable for Incremental Mail Sync.",
    );
  }
};

export class PostgresqlIncrementalMailSyncRepository
implements IncrementalMailSyncRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(
    dependencies: PostgresqlIncrementalMailSyncRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async loadCheckpoint(
    input: IncrementalMailSyncContext,
  ): Promise<IncrementalMailSyncCheckpoint> {
    assertContext(input);
    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await assertSyncConnectionAvailable(transaction, input);
      return loadCheckpoint(transaction, input, false);
    });
  }

  async persistPage(
    input: PersistIncrementalMailSyncPageInput,
  ): Promise<PersistIncrementalMailSyncPageResult> {
    assertContext(input);
    assertHistoryId(
      input.expectedHistoryId,
      "Incremental sync expectedHistoryId",
    );
    assertPageToken(
      input.expectedPageToken,
      "Incremental sync expectedPageToken",
    );
    assertHistoryId(input.latestHistoryId, "Incremental sync latestHistoryId");
    assertPageToken(input.nextPageToken, "Incremental sync nextPageToken");
    assertDate(input.persistedAt, "Incremental sync persistedAt");
    for (const message of input.messages) assertMessage(message);

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `mail-incremental-sync:${input.organizationId}:${input.workspaceId}:`
          + `${input.websiteProjectId}:${input.gmailConnectionId}`,
        ],
      );
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

      const committedHistoryId = input.nextPageToken === null
        ? input.latestHistoryId
        : input.expectedHistoryId;
      const updated = await transaction.query(
        `UPDATE backlinks.backlink_mail_sync_cursors AS cursor
            SET history_id = $5,
                next_page_token = $6,
                last_synced_at = $7,
                version = cursor.version + 1,
                updated_at = $7,
                updated_by = $8
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
          committedHistoryId,
          input.nextPageToken,
          input.persistedAt,
          input.actorId,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error(
          "Incremental Mail Sync checkpoint could not be advanced.",
        );
      }
      return {
        state: input.nextPageToken === null ? "completed" : "advanced",
        checkpoint: checkpointFromRow(row),
        insertedMessages,
      };
    });
  }
}
