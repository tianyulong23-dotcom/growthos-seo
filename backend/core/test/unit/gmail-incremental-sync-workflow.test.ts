import { describe, expect, it, vi } from "vitest";

import {
  incrementalMailSyncWorkflowId,
  runGmailIncrementalSyncWorkflow,
  type IncrementalMailRawObjectStore,
} from "../../src/modules/backlinks/application/workflows/mail-incremental-sync-workflow.js";
import type {
  IncrementalMailSyncRepository,
} from "../../src/modules/backlinks/application/services/mail-incremental-sync.repository.js";
import type {
  GmailSyncPort,
} from "../../src/modules/backlinks/ports/gmail-sync.port.js";

const context = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000129",
  actorId: "worker-129",
};
const initialSyncCompletedAt = new Date("2026-07-28T06:00:00.000Z");
const syncedAt = new Date("2026-07-28T07:00:00.000Z");
const raw = (text: string) => Buffer.from(text).toString("base64url");

const unusedGmailMethods = {
  listInitialMessages: vi.fn<GmailSyncPort["listInitialMessages"]>(),
  watch: vi.fn<GmailSyncPort["watch"]>(),
};

describe("BL-AI-129 Gmail Incremental History Sync Workflow", () => {
  it("keeps the original history cursor across pages and advances it last", async () => {
    const listHistory = vi.fn<GmailSyncPort["listHistory"]>()
      .mockResolvedValueOnce({
        kind: "page",
        latestHistoryId: "710",
        messages: [{
          providerMessageId: "gmail-message-1",
          providerThreadId: "gmail-thread-1",
          historyId: "705",
        }],
        nextPageToken: "history-page-2",
      })
      .mockResolvedValueOnce({
        kind: "page",
        latestHistoryId: "715",
        messages: [{
          providerMessageId: "gmail-message-2",
          providerThreadId: "gmail-thread-2",
          historyId: "712",
        }],
      });
    const getMessage = vi.fn<GmailSyncPort["getMessage"]>()
      .mockImplementation(async ({ providerMessageId }) => ({
        providerMessageId,
        providerThreadId: providerMessageId.endsWith("-1")
          ? "gmail-thread-1"
          : "gmail-thread-2",
        historyId: providerMessageId.endsWith("-1") ? "705" : "712",
        receivedAt: "2026-07-28T06:30:00.000Z",
        rawBase64Url: raw(`opaque-${providerMessageId}`),
        estimatedSizeBytes: 64,
      }));
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listHistory,
      getMessage,
    };
    const putIfAbsent = vi.fn<IncrementalMailRawObjectStore["putIfAbsent"]>()
      .mockResolvedValue(undefined);
    const persistPage = vi.fn<IncrementalMailSyncRepository["persistPage"]>()
      .mockResolvedValueOnce({
        state: "advanced",
        insertedMessages: 1,
        checkpoint: {
          historyId: "700",
          nextPageToken: "history-page-2",
          initialSyncCompletedAt,
          lastSyncedAt: syncedAt,
        },
      })
      .mockResolvedValueOnce({
        state: "completed",
        insertedMessages: 1,
        checkpoint: {
          historyId: "715",
          nextPageToken: null,
          initialSyncCompletedAt,
          lastSyncedAt: syncedAt,
        },
      });
    const repository: IncrementalMailSyncRepository = {
      loadCheckpoint: vi.fn().mockResolvedValue({
        historyId: "700",
        nextPageToken: null,
        initialSyncCompletedAt,
        lastSyncedAt: initialSyncCompletedAt,
      }),
      persistPage,
    };

    await expect(runGmailIncrementalSyncWorkflow(
      context,
      { gmailSync, rawObjectStore: { putIfAbsent }, repository },
      { now: () => syncedAt },
    )).resolves.toEqual({
      outcome: "completed",
      historyId: "715",
      pagesProcessed: 2,
      messagesPersisted: 2,
      syncedAt,
    });

    expect(listHistory).toHaveBeenNthCalledWith(1, {
      gmailConnectionId: context.gmailConnectionId,
      startHistoryId: "700",
      pageSize: 100,
    });
    expect(listHistory).toHaveBeenNthCalledWith(2, {
      gmailConnectionId: context.gmailConnectionId,
      startHistoryId: "700",
      pageToken: "history-page-2",
      pageSize: 100,
    });
    expect(persistPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedHistoryId: "700",
        expectedPageToken: null,
        latestHistoryId: "710",
        nextPageToken: "history-page-2",
      }),
    );
    expect(persistPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedHistoryId: "700",
        expectedPageToken: "history-page-2",
        latestHistoryId: "715",
        nextPageToken: null,
      }),
    );
    expect(putIfAbsent).toHaveBeenCalledTimes(2);
  });

  it("returns history_expired without mutating the cursor", async () => {
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listHistory: vi.fn().mockResolvedValue({
        kind: "history_expired",
        startHistoryId: "700",
      }),
      getMessage: vi.fn(),
    };
    const repository: IncrementalMailSyncRepository = {
      loadCheckpoint: vi.fn().mockResolvedValue({
        historyId: "700",
        nextPageToken: null,
        initialSyncCompletedAt,
        lastSyncedAt: initialSyncCompletedAt,
      }),
      persistPage: vi.fn(),
    };
    const rawObjectStore = {
      putIfAbsent: vi.fn<IncrementalMailRawObjectStore["putIfAbsent"]>(),
    };

    await expect(runGmailIncrementalSyncWorkflow(
      context,
      { gmailSync, repository, rawObjectStore },
    )).resolves.toEqual({
      outcome: "history_expired",
      startHistoryId: "700",
      pageToken: null,
      pagesProcessed: 0,
      messagesPersisted: 0,
    });
    expect(gmailSync.getMessage).not.toHaveBeenCalled();
    expect(rawObjectStore.putIfAbsent).not.toHaveBeenCalled();
    expect(repository.persistPage).not.toHaveBeenCalled();
  });

  it("does not advance the durable cursor when raw object storage fails", async () => {
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listHistory: vi.fn().mockResolvedValue({
        kind: "page",
        latestHistoryId: "701",
        messages: [{
          providerMessageId: "gmail-message-failed",
          providerThreadId: "gmail-thread-failed",
          historyId: "701",
        }],
      }),
      getMessage: vi.fn().mockResolvedValue({
        providerMessageId: "gmail-message-failed",
        providerThreadId: "gmail-thread-failed",
        historyId: "701",
        receivedAt: "2026-07-28T06:30:00.000Z",
        rawBase64Url: raw("opaque-failed"),
        estimatedSizeBytes: 64,
      }),
    };
    const repository: IncrementalMailSyncRepository = {
      loadCheckpoint: vi.fn().mockResolvedValue({
        historyId: "700",
        nextPageToken: null,
        initialSyncCompletedAt,
        lastSyncedAt: initialSyncCompletedAt,
      }),
      persistPage: vi.fn(),
    };

    await expect(runGmailIncrementalSyncWorkflow(
      context,
      {
        gmailSync,
        repository,
        rawObjectStore: {
          putIfAbsent: vi.fn().mockRejectedValue(
            new Error("object store unavailable"),
          ),
        },
      },
    )).rejects.toThrow("object store unavailable");
    expect(repository.persistPage).not.toHaveBeenCalled();
  });

  it("uses a stable project-and-connection Workflow ID", () => {
    expect(incrementalMailSyncWorkflowId(
      context.websiteProjectId,
      context.gmailConnectionId,
    )).toBe(
      `mail-incremental-sync/${context.websiteProjectId}/${context.gmailConnectionId}`,
    );
  });
});
