import { createHash } from "node:crypto";

import {
  createGmailHistoryRepairPolicy,
} from "../policies/mail-history-repair.policy.js";
import type {
  MailHistoryRepairContext,
  MailHistoryRepairRepository,
  PersistedMailHistoryRepairMessage,
} from "../services/mail-history-repair.repository.js";
import type {
  GmailMessageReference,
  GmailSyncPort,
} from "../../ports/gmail-sync.port.js";

export type GmailHistoryRepairWorkflowInput =
  MailHistoryRepairContext & Readonly<{
    expiredHistoryId: string;
    expiredPageToken: string | null;
  }>;

export type HistoryRepairMailRawObjectStore = {
  putIfAbsent(input: Readonly<{
    objectKey: string;
    content: Uint8Array;
    contentSha256: string;
  }>): Promise<void>;
};

export type GmailHistoryRepairWorkflowDependencies = Readonly<{
  gmailSync: GmailSyncPort;
  repository: MailHistoryRepairRepository;
  rawObjectStore: HistoryRepairMailRawObjectStore;
}>;

export type GmailHistoryRepairWorkflowOptions = Readonly<{
  now?: () => Date;
}>;

export const gmailHistoryRepairRawMessageRetentionDays = 30;

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const historyIdPattern = /^[1-9][0-9]*$/u;

export class MailHistoryRepairLimitExceededError extends Error {
  constructor() {
    super("Gmail History repair exceeded its bounded scan policy.");
    this.name = "MailHistoryRepairLimitExceededError";
  }
}

export const historyRepairMailSyncWorkflowId = (
  websiteProjectId: string,
  gmailConnectionId: string,
): string => `mail-history-repair/${websiteProjectId}/${gmailConnectionId}`;

const assertNonBlank = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const assertInput = (input: GmailHistoryRepairWorkflowInput): void => {
  assertNonBlank(input.organizationId, "History repair organizationId");
  assertNonBlank(input.workspaceId, "History repair workspaceId");
  assertNonBlank(input.websiteProjectId, "History repair websiteProjectId");
  assertNonBlank(input.gmailConnectionId, "History repair gmailConnectionId");
  assertNonBlank(input.actorId, "History repair actorId");
  if (!historyIdPattern.test(input.expiredHistoryId)) {
    throw new TypeError(
      "History repair expiredHistoryId must be a positive numeric History ID.",
    );
  }
  if (input.expiredPageToken !== null) {
    assertNonBlank(input.expiredPageToken, "History repair expiredPageToken");
  }
};

const validDate = (value: Date, name: string): Date => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
  return value;
};

const rawObjectKey = (
  input: GmailHistoryRepairWorkflowInput,
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

const uniqueUnseenReferences = (
  references: readonly GmailMessageReference[],
  seenProviderMessageIds: Set<string>,
): readonly GmailMessageReference[] => {
  const unique: GmailMessageReference[] = [];
  for (const reference of references) {
    if (seenProviderMessageIds.has(reference.providerMessageId)) continue;
    seenProviderMessageIds.add(reference.providerMessageId);
    unique.push(reference);
  }
  return unique;
};

export async function runGmailHistoryRepairWorkflow(
  input: GmailHistoryRepairWorkflowInput,
  dependencies: GmailHistoryRepairWorkflowDependencies,
  options: GmailHistoryRepairWorkflowOptions = {},
) {
  assertInput(input);
  const now = options.now ?? (() => new Date());
  const repairedAt = validDate(now(), "History repair current time");
  const policy = createGmailHistoryRepairPolicy(repairedAt);
  const checkpoint = await dependencies.repository.loadCheckpoint(input);
  if (
    checkpoint.historyId !== input.expiredHistoryId
    || checkpoint.nextPageToken !== input.expiredPageToken
  ) {
    return {
      outcome: "stale" as const,
      historyId: checkpoint.historyId,
      pageToken: checkpoint.nextPageToken,
    };
  }

  const messages: PersistedMailHistoryRepairMessage[] = [];
  const seenProviderMessageIds = new Set<string>();
  let pagesProcessed = 0;
  let pageToken: string | undefined;
  let snapshotHistoryId: string | null = null;

  for (;;) {
    const page = await dependencies.gmailSync.listInitialMessages({
      gmailConnectionId: input.gmailConnectionId,
      receivedAfter: policy.receivedAfter.toISOString(),
      ...(pageToken === undefined ? {} : { pageToken }),
      pageSize: policy.pageSize,
    });
    pagesProcessed += 1;
    if (
      snapshotHistoryId !== null
      && snapshotHistoryId !== page.snapshotHistoryId
    ) {
      throw new Error("History repair snapshot History ID changed.");
    }
    snapshotHistoryId = page.snapshotHistoryId;

    const references = uniqueUnseenReferences(
      page.messages,
      seenProviderMessageIds,
    );
    if (seenProviderMessageIds.size > policy.maxMessages) {
      throw new MailHistoryRepairLimitExceededError();
    }
    const fetchedAt = validDate(now(), "History repair fetch time");
    const retentionExpiresAt = new Date(
      fetchedAt.getTime()
        + gmailHistoryRepairRawMessageRetentionDays * dayMilliseconds,
    );

    for (const reference of references) {
      const rawMessage = await dependencies.gmailSync.getMessage({
        gmailConnectionId: input.gmailConnectionId,
        providerMessageId: reference.providerMessageId,
      });
      if (
        rawMessage.providerMessageId !== reference.providerMessageId
        || rawMessage.providerThreadId !== reference.providerThreadId
      ) {
        throw new Error("History repair raw message identity changed.");
      }
      const receivedAt = validDate(
        new Date(rawMessage.receivedAt),
        "History repair message receivedAt",
      );
      if (
        receivedAt.getTime() < policy.receivedAfter.getTime()
        || receivedAt.getTime() > policy.receivedBefore.getTime()
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

    pageToken = page.nextPageToken;
    if (pageToken === undefined) break;
    if (pagesProcessed >= policy.maxPages) {
      throw new MailHistoryRepairLimitExceededError();
    }
  }

  if (snapshotHistoryId === null) {
    throw new Error("History repair did not obtain a snapshot History ID.");
  }
  const committed = await dependencies.repository.commitRepair({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    gmailConnectionId: input.gmailConnectionId,
    actorId: input.actorId,
    expectedHistoryId: input.expiredHistoryId,
    expectedPageToken: input.expiredPageToken,
    repairedHistoryId: snapshotHistoryId,
    messages,
    repairWindowStartedAt: policy.receivedAfter,
    repairWindowEndedAt: policy.receivedBefore,
    pagesScanned: pagesProcessed,
    messagesScanned: seenProviderMessageIds.size,
    repairedAt,
  });
  if (committed.state === "stale") {
    return {
      outcome: "stale" as const,
      historyId: committed.checkpoint.historyId,
      pageToken: committed.checkpoint.nextPageToken,
    };
  }
  return {
    outcome: "completed" as const,
    previousHistoryId: input.expiredHistoryId,
    historyId: committed.checkpoint.historyId,
    pagesProcessed,
    messagesPersisted: committed.insertedMessages,
    repairedAt: committed.checkpoint.lastSyncedAt ?? repairedAt,
  };
}
