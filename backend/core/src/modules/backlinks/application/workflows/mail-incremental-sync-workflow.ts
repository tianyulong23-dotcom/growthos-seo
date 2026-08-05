import { createHash } from "node:crypto";

import type {
  IncrementalMailSyncCheckpoint,
  IncrementalMailSyncContext,
  IncrementalMailSyncRepository,
  PersistedIncrementalMailMessage,
} from "../services/mail-incremental-sync.repository.js";
import type {
  GmailHistoryMessageReference,
  GmailSyncPort,
} from "../../ports/gmail-sync.port.js";

export type IncrementalMailRawObjectStore = {
  putIfAbsent(input: Readonly<{
    objectKey: string;
    content: Uint8Array;
    contentSha256: string;
  }>): Promise<void>;
};

export type GmailIncrementalSyncWorkflowDependencies = Readonly<{
  gmailSync: GmailSyncPort;
  repository: IncrementalMailSyncRepository;
  rawObjectStore: IncrementalMailRawObjectStore;
}>;

export type GmailIncrementalSyncWorkflowOptions = Readonly<{
  now?: () => Date;
}>;

export const gmailIncrementalSyncPageSize = 100;
export const gmailIncrementalRawMessageRetentionDays = 30;

const dayMilliseconds = 24 * 60 * 60 * 1_000;

export const incrementalMailSyncWorkflowId = (
  websiteProjectId: string,
  gmailConnectionId: string,
): string => `mail-incremental-sync/${websiteProjectId}/${gmailConnectionId}`;

const assertNonBlank = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const assertInput = (input: IncrementalMailSyncContext): void => {
  assertNonBlank(input.organizationId, "Incremental sync organizationId");
  assertNonBlank(input.workspaceId, "Incremental sync workspaceId");
  assertNonBlank(input.websiteProjectId, "Incremental sync websiteProjectId");
  assertNonBlank(input.gmailConnectionId, "Incremental sync gmailConnectionId");
  assertNonBlank(input.actorId, "Incremental sync actorId");
};

const validDate = (value: Date, name: string): Date => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
  return value;
};

const rawObjectKey = (
  input: IncrementalMailSyncContext,
  providerMessageId: string,
): string => {
  const messageKey = createHash("sha256")
    .update(providerMessageId)
    .digest("hex");
  return [
    "backlinks",
    "mail",
    "raw",
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.gmailConnectionId,
    `${messageKey}.eml`,
  ].join("/");
};

const uniqueReferences = (
  references: readonly GmailHistoryMessageReference[],
): readonly GmailHistoryMessageReference[] => {
  const unique = new Map<string, GmailHistoryMessageReference>();
  for (const reference of references) {
    if (!unique.has(reference.providerMessageId)) {
      unique.set(reference.providerMessageId, reference);
    }
  }
  return [...unique.values()];
};

export async function runGmailIncrementalSyncWorkflow(
  input: IncrementalMailSyncContext,
  dependencies: GmailIncrementalSyncWorkflowDependencies,
  options: GmailIncrementalSyncWorkflowOptions = {},
) {
  assertInput(input);
  const now = options.now ?? (() => new Date());
  let checkpoint: IncrementalMailSyncCheckpoint =
    await dependencies.repository.loadCheckpoint(input);
  let pagesProcessed = 0;
  let messagesPersisted = 0;

  for (;;) {
    const page = await dependencies.gmailSync.listHistory({
      gmailConnectionId: input.gmailConnectionId,
      startHistoryId: checkpoint.historyId,
      ...(checkpoint.nextPageToken === null
        ? {}
        : { pageToken: checkpoint.nextPageToken }),
      pageSize: gmailIncrementalSyncPageSize,
    });
    if (page.kind === "history_expired") {
      if (page.startHistoryId !== checkpoint.historyId) {
        throw new Error(
          "Incremental Mail Sync expired History ID changed.",
        );
      }
      return {
        outcome: "history_expired" as const,
        startHistoryId: checkpoint.historyId,
        pageToken: checkpoint.nextPageToken,
        pagesProcessed,
        messagesPersisted,
      };
    }

    const fetchedAt = validDate(now(), "Incremental sync fetch time");
    const retentionExpiresAt = new Date(
      fetchedAt.getTime()
        + gmailIncrementalRawMessageRetentionDays * dayMilliseconds,
    );
    const messages: PersistedIncrementalMailMessage[] = [];

    for (const reference of uniqueReferences(page.messages)) {
      const rawMessage = await dependencies.gmailSync.getMessage({
        gmailConnectionId: input.gmailConnectionId,
        providerMessageId: reference.providerMessageId,
      });
      if (
        rawMessage.providerMessageId !== reference.providerMessageId
        || rawMessage.providerThreadId !== reference.providerThreadId
      ) {
        throw new Error(
          "Incremental Mail Sync raw message identity changed.",
        );
      }

      const content = Buffer.from(rawMessage.rawBase64Url, "base64url");
      const contentSha256 = createHash("sha256")
        .update(content)
        .digest("hex");
      const objectKey = rawObjectKey(input, rawMessage.providerMessageId);
      await dependencies.rawObjectStore.putIfAbsent({
        objectKey,
        content,
        contentSha256,
      });
      messages.push(Object.freeze({
        providerMessageId: rawMessage.providerMessageId,
        providerThreadId: rawMessage.providerThreadId,
        historyId: reference.historyId,
        receivedAt: validDate(
          new Date(rawMessage.receivedAt),
          "Incremental sync message receivedAt",
        ),
        rawObjectKey: objectKey,
        rawContentSha256: contentSha256,
        rawSizeBytes: content.byteLength,
        fetchedAt,
        retentionExpiresAt,
      }));
    }

    const persisted = await dependencies.repository.persistPage({
      ...input,
      expectedHistoryId: checkpoint.historyId,
      expectedPageToken: checkpoint.nextPageToken,
      latestHistoryId: page.latestHistoryId,
      nextPageToken: page.nextPageToken ?? null,
      messages,
      persistedAt: fetchedAt,
    });
    if (persisted.state === "stale") {
      checkpoint = persisted.checkpoint;
      continue;
    }

    pagesProcessed += 1;
    messagesPersisted += persisted.insertedMessages;
    checkpoint = persisted.checkpoint;
    if (persisted.state === "completed") {
      return {
        outcome: "completed" as const,
        historyId: checkpoint.historyId,
        pagesProcessed,
        messagesPersisted,
        syncedAt: checkpoint.lastSyncedAt,
      };
    }
  }
}
