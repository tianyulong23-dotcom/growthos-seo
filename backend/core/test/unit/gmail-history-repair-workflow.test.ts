import { describe, expect, it, vi } from "vitest";

import type {
  MailHistoryRepairRepository,
} from "../../src/modules/backlinks/application/services/mail-history-repair.repository.js";
import {
  gmailHistoryRepairMaxPages,
} from "../../src/modules/backlinks/application/policies/mail-history-repair.policy.js";
import {
  historyRepairMailSyncWorkflowId,
  MailHistoryRepairLimitExceededError,
  runGmailHistoryRepairWorkflow,
  type HistoryRepairMailRawObjectStore,
} from "../../src/modules/backlinks/application/workflows/mail-history-repair-workflow.js";
import type {
  GmailSyncPort,
} from "../../src/modules/backlinks/ports/gmail-sync.port.js";

const context = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000130",
  actorId: "worker-130",
};
const repairStartedAt = new Date("2026-07-28T08:00:00.000Z");
const initialSyncCompletedAt = new Date("2026-07-28T06:00:00.000Z");
const raw = (text: string) => Buffer.from(text).toString("base64url");

const unusedGmailMethods = {
  listHistory: vi.fn<GmailSyncPort["listHistory"]>(),
  watch: vi.fn<GmailSyncPort["watch"]>(),
};

describe("BL-AI-130 Gmail expired History ID repair workflow", () => {
  it("scans the safe window and commits the new snapshot only after all pages", async () => {
    const listInitialMessages = vi.fn<GmailSyncPort["listInitialMessages"]>()
      .mockResolvedValueOnce({
        snapshotHistoryId: "800",
        messages: [{
          providerMessageId: "gmail-message-1",
          providerThreadId: "gmail-thread-1",
        }],
        nextPageToken: "repair-page-2",
      })
      .mockResolvedValueOnce({
        snapshotHistoryId: "800",
        messages: [{
          providerMessageId: "gmail-message-1",
          providerThreadId: "gmail-thread-1",
        }, {
          providerMessageId: "gmail-message-2",
          providerThreadId: "gmail-thread-2",
        }, {
          providerMessageId: "gmail-message-too-new",
          providerThreadId: "gmail-thread-too-new",
        }],
      });
    const getMessage = vi.fn<GmailSyncPort["getMessage"]>()
      .mockImplementation(async ({ providerMessageId }) => ({
        providerMessageId,
        providerThreadId: providerMessageId.endsWith("-1")
          ? "gmail-thread-1"
          : providerMessageId.endsWith("-2")
            ? "gmail-thread-2"
            : "gmail-thread-too-new",
        historyId: providerMessageId.endsWith("-1") ? "790" : "800",
        receivedAt: providerMessageId.endsWith("too-new")
          ? "2026-07-28T08:00:00.001Z"
          : "2026-07-27T08:00:00.000Z",
        rawBase64Url: raw(`opaque-${providerMessageId}`),
        estimatedSizeBytes: 64,
      }));
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages,
      getMessage,
    };
    const commitRepair = vi.fn<MailHistoryRepairRepository["commitRepair"]>()
      .mockResolvedValue({
        state: "completed",
        insertedMessages: 2,
        checkpoint: {
          historyId: "800",
          nextPageToken: null,
          initialSyncCompletedAt,
          lastSyncedAt: repairStartedAt,
        },
      });
    const repository: MailHistoryRepairRepository = {
      loadCheckpoint: vi.fn().mockResolvedValue({
        historyId: "700",
        nextPageToken: null,
        initialSyncCompletedAt,
        lastSyncedAt: initialSyncCompletedAt,
      }),
      commitRepair,
    };
    const putIfAbsent = vi.fn<
      HistoryRepairMailRawObjectStore["putIfAbsent"]
    >().mockResolvedValue(undefined);

    await expect(runGmailHistoryRepairWorkflow(
      { ...context, expiredHistoryId: "700", expiredPageToken: null },
      { gmailSync, repository, rawObjectStore: { putIfAbsent } },
      { now: () => repairStartedAt },
    )).resolves.toEqual({
      outcome: "completed",
      previousHistoryId: "700",
      historyId: "800",
      pagesProcessed: 2,
      messagesPersisted: 2,
      repairedAt: repairStartedAt,
    });

    expect(listInitialMessages).toHaveBeenNthCalledWith(1, {
      gmailConnectionId: context.gmailConnectionId,
      receivedAfter: "2026-07-21T08:00:00.000Z",
      pageSize: 100,
    });
    expect(listInitialMessages).toHaveBeenNthCalledWith(2, {
      gmailConnectionId: context.gmailConnectionId,
      receivedAfter: "2026-07-21T08:00:00.000Z",
      pageToken: "repair-page-2",
      pageSize: 100,
    });
    expect(getMessage).toHaveBeenCalledTimes(3);
    expect(putIfAbsent).toHaveBeenCalledTimes(2);
    expect(commitRepair).toHaveBeenCalledWith(expect.objectContaining({
      expectedHistoryId: "700",
      expectedPageToken: null,
      repairedHistoryId: "800",
      repairWindowStartedAt: new Date("2026-07-21T08:00:00.000Z"),
      repairWindowEndedAt: repairStartedAt,
      pagesScanned: 2,
      messagesScanned: 3,
      messages: [
        expect.objectContaining({ providerMessageId: "gmail-message-1" }),
        expect.objectContaining({ providerMessageId: "gmail-message-2" }),
      ],
    }));
  });

  it("fails closed before cursor or audit commit when the page bound is exceeded", async () => {
    const listInitialMessages = vi.fn<GmailSyncPort["listInitialMessages"]>()
      .mockImplementation(async ({ pageToken }) => ({
        snapshotHistoryId: "800",
        messages: [],
        nextPageToken: pageToken === undefined
          ? "repair-page-1"
          : `repair-page-${Number(pageToken.split("-").at(-1)) + 1}`,
      }));
    const repository: MailHistoryRepairRepository = {
      loadCheckpoint: vi.fn().mockResolvedValue({
        historyId: "700",
        nextPageToken: null,
        initialSyncCompletedAt,
        lastSyncedAt: initialSyncCompletedAt,
      }),
      commitRepair: vi.fn(),
    };

    await expect(runGmailHistoryRepairWorkflow(
      { ...context, expiredHistoryId: "700", expiredPageToken: null },
      {
        gmailSync: {
          ...unusedGmailMethods,
          listInitialMessages,
          getMessage: vi.fn(),
        },
        repository,
        rawObjectStore: { putIfAbsent: vi.fn() },
      },
      { now: () => repairStartedAt },
    )).rejects.toBeInstanceOf(MailHistoryRepairLimitExceededError);
    expect(listInitialMessages).toHaveBeenCalledTimes(
      gmailHistoryRepairMaxPages,
    );
    expect(repository.commitRepair).not.toHaveBeenCalled();
  });

  it("does not scan when the expired checkpoint is already stale", async () => {
    const repository: MailHistoryRepairRepository = {
      loadCheckpoint: vi.fn().mockResolvedValue({
        historyId: "801",
        nextPageToken: null,
        initialSyncCompletedAt,
        lastSyncedAt: repairStartedAt,
      }),
      commitRepair: vi.fn(),
    };
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages: vi.fn(),
      getMessage: vi.fn(),
    };

    await expect(runGmailHistoryRepairWorkflow(
      { ...context, expiredHistoryId: "700", expiredPageToken: null },
      {
        gmailSync,
        repository,
        rawObjectStore: { putIfAbsent: vi.fn() },
      },
      { now: () => repairStartedAt },
    )).resolves.toEqual({
      outcome: "stale",
      historyId: "801",
      pageToken: null,
    });
    expect(gmailSync.listInitialMessages).not.toHaveBeenCalled();
    expect(repository.commitRepair).not.toHaveBeenCalled();
  });

  it("uses a stable project-and-connection Workflow ID", () => {
    expect(historyRepairMailSyncWorkflowId(
      context.websiteProjectId,
      context.gmailConnectionId,
    )).toBe(
      `mail-history-repair/${context.websiteProjectId}/${context.gmailConnectionId}`,
    );
  });
});
