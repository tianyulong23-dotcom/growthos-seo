import { randomUUID } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export type InitialMailSyncContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
  actorId: string;
}>;

export type PendingInitialMailSyncCheckpoint = Readonly<{
  state: "pending";
  startedAt: Date;
  snapshotHistoryId: string | null;
  nextPageToken: string | null;
}>;

export type CompletedInitialMailSyncCheckpoint = Readonly<{
  state: "completed";
  startedAt: Date;
  snapshotHistoryId: string;
  completedAt: Date;
}>;

export type InitialMailSyncCheckpoint =
  | PendingInitialMailSyncCheckpoint
  | CompletedInitialMailSyncCheckpoint;

export type PersistedInitialMailMessage = Readonly<{
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

export type PersistInitialMailSyncPageInput = InitialMailSyncContext & Readonly<{
  expectedPageToken: string | null;
  snapshotHistoryId: string;
  nextPageToken: string | null;
  messages: readonly PersistedInitialMailMessage[];
  persistedAt: Date;
}>;

export type PersistInitialMailSyncPageResult = Readonly<{
  state: "advanced" | "completed" | "stale";
  checkpoint: InitialMailSyncCheckpoint;
  insertedMessages: number;
}>;

export interface InitialMailSyncRepository {
  loadOrCreateCheckpoint(
    input: InitialMailSyncContext & Readonly<{ startedAt: Date }>,
  ): Promise<InitialMailSyncCheckpoint>;
  persistPage(
    input: PersistInitialMailSyncPageInput,
  ): Promise<PersistInitialMailSyncPageResult>;
}

type PostgresqlInitialMailSyncRepositoryDependencies = Readonly<{
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

const assertContext = (input: InitialMailSyncContext): void => {
  assertNonBlank(input.organizationId, "Initial sync organizationId");
  assertNonBlank(input.workspaceId, "Initial sync workspaceId");
  assertNonBlank(input.websiteProjectId, "Initial sync websiteProjectId");
  assertNonBlank(input.gmailConnectionId, "Initial sync gmailConnectionId");
  assertNonBlank(input.actorId, "Initial sync actorId");
};

const assertPageToken = (value: string | null, name: string): void => {
  if (value !== null) assertNonBlank(value, name);
};

const assertMessage = (message: PersistedInitialMailMessage): void => {
  assertNonBlank(message.providerMessageId, "Initial sync providerMessageId");
  assertNonBlank(message.providerThreadId, "Initial sync providerThreadId");
  assertHistoryId(message.historyId, "Initial sync message historyId");
  assertDate(message.receivedAt, "Initial sync message receivedAt");
  assertNonBlank(message.rawObjectKey, "Initial sync rawObjectKey");
  if (!sha256Pattern.test(message.rawContentSha256)) {
    throw new TypeError("Initial sync rawContentSha256 must be SHA-256.");
  }
  if (
    !Number.isSafeInteger(message.rawSizeBytes)
    || message.rawSizeBytes < 0
  ) {
    throw new TypeError("Initial sync rawSizeBytes must be non-negative.");
  }
  assertDate(message.fetchedAt, "Initial sync message fetchedAt");
  assertDate(
    message.retentionExpiresAt,
    "Initial sync message retentionExpiresAt",
  );
  if (message.retentionExpiresAt.getTime() <= message.fetchedAt.getTime()) {
    throw new TypeError(
      "Initial sync message retention must expire after fetch.",
    );
  }
};

const dateFromRow = (value: unknown, name: string): Date => {
  const date = value instanceof Date ? value : new Date(String(value));
  assertDate(date, name);
  return date;
};

const nullableStringFromRow = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} returned an invalid value.`);
  }
  return value;
};

const checkpointFromRow = (
  row: Record<string, unknown>,
): InitialMailSyncCheckpoint => {
  const startedAt = dateFromRow(row.startedAt, "Initial sync startedAt");
  const snapshotHistoryId = nullableStringFromRow(
    row.snapshotHistoryId,
    "Initial sync snapshotHistoryId",
  );
  const nextPageToken = nullableStringFromRow(
    row.nextPageToken,
    "Initial sync nextPageToken",
  );
  const completedAtValue = row.completedAt;

  if (completedAtValue !== null) {
    if (snapshotHistoryId === null || nextPageToken !== null) {
      throw new TypeError("Completed Initial sync checkpoint is invalid.");
    }
    assertHistoryId(snapshotHistoryId, "Initial sync snapshotHistoryId");
    return Object.freeze({
      state: "completed",
      startedAt,
      snapshotHistoryId,
      completedAt: dateFromRow(completedAtValue, "Initial sync completedAt"),
    });
  }
  if (snapshotHistoryId !== null) {
    assertHistoryId(snapshotHistoryId, "Initial sync snapshotHistoryId");
  }
  return Object.freeze({
    state: "pending",
    startedAt,
    snapshotHistoryId,
    nextPageToken,
  });
};

const loadCheckpoint = async (
  transaction: BacklinkTransactionClient,
  input: InitialMailSyncContext,
  lock: boolean,
): Promise<InitialMailSyncCheckpoint | null> => {
  const result = await transaction.query(
    `SELECT cursor.created_at AS "startedAt",
            cursor.history_id AS "snapshotHistoryId",
            cursor.next_page_token AS "nextPageToken",
            cursor.initial_sync_completed_at AS "completedAt"
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
  return row === undefined ? null : checkpointFromRow(row);
};

const assertSyncConnectionAvailable = async (
  transaction: BacklinkTransactionClient,
  input: InitialMailSyncContext,
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
        AND binding.binding_status = 'ACTIVE'
      LIMIT 1`,
    [
      input.organizationId,
      input.gmailConnectionId,
      input.workspaceId,
    ],
  );
  if (result.rows[0] === undefined) {
    throw new Error(
      "Gmail connection is unavailable for Initial Mail Sync.",
    );
  }
};

export class PostgresqlInitialMailSyncRepository
implements InitialMailSyncRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(dependencies: PostgresqlInitialMailSyncRepositoryDependencies) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async loadOrCreateCheckpoint(
    input: InitialMailSyncContext & Readonly<{ startedAt: Date }>,
  ): Promise<InitialMailSyncCheckpoint> {
    assertContext(input);
    assertDate(input.startedAt, "Initial sync startedAt");

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `mail-initial-sync:${input.organizationId}:${input.workspaceId}:`
          + `${input.websiteProjectId}:${input.gmailConnectionId}`,
        ],
      );
      const existing = await loadCheckpoint(transaction, input, true);
      await assertSyncConnectionAvailable(transaction, input);
      if (existing !== null) return existing;

      const inserted = await transaction.query(
        `INSERT INTO backlinks.backlink_mail_sync_cursors AS cursor (
           id, organization_id, workspace_id, website_project_id,
           gmail_connection_id, created_at, updated_at, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $6, $7, $7
         )
         RETURNING cursor.created_at AS "startedAt",
                   cursor.history_id AS "snapshotHistoryId",
                   cursor.next_page_token AS "nextPageToken",
                   cursor.initial_sync_completed_at AS "completedAt"`,
        [
          this.#newId(),
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.gmailConnectionId,
          input.startedAt,
          input.actorId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("Initial Mail Sync checkpoint could not be created.");
      }
      return checkpointFromRow(row);
    });
  }

  async persistPage(
    input: PersistInitialMailSyncPageInput,
  ): Promise<PersistInitialMailSyncPageResult> {
    assertContext(input);
    assertPageToken(input.expectedPageToken, "Initial sync expectedPageToken");
    assertHistoryId(input.snapshotHistoryId, "Initial sync snapshotHistoryId");
    assertPageToken(input.nextPageToken, "Initial sync nextPageToken");
    assertDate(input.persistedAt, "Initial sync persistedAt");
    for (const message of input.messages) assertMessage(message);

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `mail-initial-sync:${input.organizationId}:${input.workspaceId}:`
          + `${input.websiteProjectId}:${input.gmailConnectionId}`,
        ],
      );
      const checkpoint = await loadCheckpoint(transaction, input, true);
      if (checkpoint === null) {
        throw new Error("Initial Mail Sync checkpoint is unavailable.");
      }
      if (
        checkpoint.state === "completed"
        || checkpoint.nextPageToken !== input.expectedPageToken
      ) {
        return {
          state: "stale",
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

      const completedAt = input.nextPageToken === null
        ? input.persistedAt
        : null;
      const updated = await transaction.query(
        `UPDATE backlinks.backlink_mail_sync_cursors AS cursor
            SET history_id = $5,
                next_page_token = $6,
                initial_sync_completed_at = $7,
                last_synced_at = $8,
                version = cursor.version + 1,
                updated_at = $8,
                updated_by = $9
          WHERE cursor.organization_id = $1
            AND cursor.workspace_id = $2
            AND cursor.website_project_id = $3
            AND cursor.gmail_connection_id = $4
          RETURNING cursor.created_at AS "startedAt",
                    cursor.history_id AS "snapshotHistoryId",
                    cursor.next_page_token AS "nextPageToken",
                    cursor.initial_sync_completed_at AS "completedAt"`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
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
        throw new Error("Initial Mail Sync checkpoint could not be advanced.");
      }
      const nextCheckpoint = checkpointFromRow(row);
      return {
        state: nextCheckpoint.state === "completed"
          ? "completed"
          : "advanced",
        checkpoint: nextCheckpoint,
        insertedMessages,
      };
    });
  }
}
