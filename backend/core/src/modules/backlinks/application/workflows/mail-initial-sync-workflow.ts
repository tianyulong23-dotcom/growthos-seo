import { createHash } from "node:crypto";

import type {
  CompletedInitialMailSyncCheckpoint,
  InitialMailSyncCheckpoint,
  InitialMailSyncContext,
  InitialMailSyncRepository,
  PersistedInitialMailMessage,
} from "../services/mail-initial-sync.repository.js";
import type {
  GmailMessageReference,
  GmailSyncPort,
} from "../../ports/gmail-sync.port.js";

export type InitialMailRawObjectStore = {
  putIfAbsent(input: Readonly<{
    objectKey: string;
    content: Uint8Array;
    contentSha256: string;
  }>): Promise<void>;
};

export type GmailInitialSyncWorkflowDependencies = Readonly<{
  gmailSync: GmailSyncPort;
  repository: InitialMailSyncRepository;
  rawObjectStore: InitialMailRawObjectStore;
}>;

export type GmailInitialSyncWorkflowOptions = Readonly<{
  now?: () => Date;
}>;

export const gmailInitialSyncLookbackDays = 7;
export const gmailInitialSyncPageSize = 100;
export const gmailRawMessageRetentionDays = 30;

const dayMilliseconds = 24 * 60 * 60 * 1_000;

export const initialMailSyncWorkflowId = (
  websiteProjectId: string,
  gmailConnectionId: string,
): string => `mail-initial-sync/${websiteProjectId}/${gmailConnectionId}`;

const assertNonBlank = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const assertInput = (input: InitialMailSyncContext): void => {
  assertNonBlank(input.organizationId, "Initial sync organizationId");
  assertNonBlank(input.workspaceId, "Initial sync workspaceId");
  assertNonBlank(input.websiteProjectId, "Initial sync websiteProjectId");
  assertNonBlank(input.gmailConnectionId, "Initial sync gmailConnectionId");
  assertNonBlank(input.actorId, "Initial sync actorId");
};

const validDate = (value: Date, name: string): Date => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
  return value;
};

const rawObjectKey = (
  input: InitialMailSyncContext,
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
  references: readonly GmailMessageReference[],
): readonly GmailMessageReference[] => {
  const unique = new Map<string, GmailMessageReference>();
  for (const reference of references) {
    if (!unique.has(reference.providerMessageId)) {
      unique.set(reference.providerMessageId, reference);
    }
  }
  return [...unique.values()];
};

const completedResult = (
  checkpoint: CompletedInitialMailSyncCheckpoint,
  outcome: "completed" | "already_completed",
  pagesProcessed = 0,
  messagesPersisted = 0,
) => outcome === "already_completed"
  ? {
      outcome,
      snapshotHistoryId: checkpoint.snapshotHistoryId,
      completedAt: checkpoint.completedAt,
    }
  : {
      outcome,
      snapshotHistoryId: checkpoint.snapshotHistoryId,
      pagesProcessed,
      messagesPersisted,
      completedAt: checkpoint.completedAt,
    };

export async function runGmailInitialSyncWorkflow(
  input: InitialMailSyncContext,
  dependencies: GmailInitialSyncWorkflowDependencies,
  options: GmailInitialSyncWorkflowOptions = {},
) {
  assertInput(input);
  const now = options.now ?? (() => new Date());
  const requestedAt = validDate(now(), "Initial sync current time");
  let checkpoint: InitialMailSyncCheckpoint =
    await dependencies.repository.loadOrCreateCheckpoint({
      ...input,
      startedAt: requestedAt,
    });
  if (checkpoint.state === "completed") {
    return completedResult(checkpoint, "already_completed");
  }

  const receivedAfter = new Date(
    checkpoint.startedAt.getTime()
      - gmailInitialSyncLookbackDays * dayMilliseconds,
  );
  let pagesProcessed = 0;
  let messagesPersisted = 0;

  for (;;) {
    const page = await dependencies.gmailSync.listInitialMessages({
      gmailConnectionId: input.gmailConnectionId,
      receivedAfter: receivedAfter.toISOString(),
      ...(checkpoint.nextPageToken === null
        ? {}
        : { pageToken: checkpoint.nextPageToken }),
      pageSize: gmailInitialSyncPageSize,
    });
    if (
      checkpoint.snapshotHistoryId !== null
      && checkpoint.snapshotHistoryId !== page.snapshotHistoryId
    ) {
      throw new Error("Initial Mail Sync snapshot History ID changed.");
    }

    const fetchedAt = validDate(now(), "Initial sync fetch time");
    const retentionExpiresAt = new Date(
      fetchedAt.getTime() + gmailRawMessageRetentionDays * dayMilliseconds,
    );
    const messages: PersistedInitialMailMessage[] = [];

    for (const reference of uniqueReferences(page.messages)) {
      const rawMessage = await dependencies.gmailSync.getMessage({
        gmailConnectionId: input.gmailConnectionId,
        providerMessageId: reference.providerMessageId,
      });
      if (
        rawMessage.providerMessageId !== reference.providerMessageId
        || rawMessage.providerThreadId !== reference.providerThreadId
      ) {
        throw new Error("Initial Mail Sync raw message identity changed.");
      }
      const receivedAt = validDate(
        new Date(rawMessage.receivedAt),
        "Initial sync message receivedAt",
      );
      if (
        receivedAt.getTime() < receivedAfter.getTime()
        || receivedAt.getTime() > checkpoint.startedAt.getTime()
      ) {
        continue;
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
        historyId: rawMessage.historyId,
        receivedAt,
        rawObjectKey: objectKey,
        rawContentSha256: contentSha256,
        rawSizeBytes: content.byteLength,
        fetchedAt,
        retentionExpiresAt,
      }));
    }

    const persisted = await dependencies.repository.persistPage({
      ...input,
      expectedPageToken: checkpoint.nextPageToken,
      snapshotHistoryId: page.snapshotHistoryId,
      nextPageToken: page.nextPageToken ?? null,
      messages,
      persistedAt: fetchedAt,
    });
    if (persisted.state === "stale") {
      checkpoint = persisted.checkpoint;
      if (checkpoint.state === "completed") {
        return completedResult(checkpoint, "already_completed");
      }
      continue;
    }

    pagesProcessed += 1;
    messagesPersisted += persisted.insertedMessages;
    checkpoint = persisted.checkpoint;
    if (checkpoint.state === "completed") {
      return completedResult(
        checkpoint,
        "completed",
        pagesProcessed,
        messagesPersisted,
      );
    }
  }
}
