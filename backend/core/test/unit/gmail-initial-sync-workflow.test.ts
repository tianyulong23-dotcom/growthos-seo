import { describe, expect, it, vi } from "vitest";

import {
  gmailInitialSyncLookbackDays,
  initialMailSyncWorkflowId,
  runGmailInitialSyncWorkflow,
  type InitialMailRawObjectStore,
} from "../../src/modules/backlinks/application/workflows/mail-initial-sync-workflow.js";
import type {
  InitialMailSyncRepository,
} from "../../src/modules/backlinks/application/services/mail-initial-sync.repository.js";
import type {
  GmailSyncPort,
} from "../../src/modules/backlinks/ports/gmail-sync.port.js";

const context = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000128",
  actorId: "worker-128",
};
const startedAt = new Date("2026-07-28T06:00:00.000Z");
const raw = (text: string) => Buffer.from(text).toString("base64url");

const unusedGmailMethods = {
  listHistory: vi.fn<GmailSyncPort["listHistory"]>(),
  watch: vi.fn<GmailSyncPort["watch"]>(),
};

describe("BL-AI-128 Gmail Initial Sync Workflow", () => {
  it("uses the fixed seven-day window and drops messages outside it", async () => {
    const listInitialMessages = vi.fn<GmailSyncPort["listInitialMessages"]>()
      .mockResolvedValue({
        snapshotHistoryId: "700",
        messages: [{
          providerMessageId: "gmail-message-in-window",
          providerThreadId: "gmail-thread-in-window",
        }, {
          providerMessageId: "gmail-message-too-old",
          providerThreadId: "gmail-thread-too-old",
        }],
      });
    const getMessage = vi.fn<GmailSyncPort["getMessage"]>()
      .mockImplementation(async ({ providerMessageId }) => ({
        providerMessageId,
        providerThreadId: providerMessageId.endsWith("too-old")
          ? "gmail-thread-too-old"
          : "gmail-thread-in-window",
        historyId: "700",
        receivedAt: providerMessageId.endsWith("too-old")
          ? "2026-07-21T05:59:59.999Z"
          : "2026-07-27T06:00:00.000Z",
        rawBase64Url: raw(`opaque-${providerMessageId}`),
        estimatedSizeBytes: 64,
      }));
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages,
      getMessage,
    };
    const putIfAbsent = vi.fn<InitialMailRawObjectStore["putIfAbsent"]>()
      .mockResolvedValue(undefined);
    const persistPage = vi.fn<InitialMailSyncRepository["persistPage"]>()
      .mockResolvedValue({
        state: "completed",
        checkpoint: {
          state: "completed",
          startedAt,
          snapshotHistoryId: "700",
          completedAt: startedAt,
        },
        insertedMessages: 1,
      });
    const repository: InitialMailSyncRepository = {
      loadOrCreateCheckpoint: vi.fn().mockResolvedValue({
        state: "pending",
        startedAt,
        snapshotHistoryId: null,
        nextPageToken: null,
      }),
      persistPage,
    };

    await expect(runGmailInitialSyncWorkflow(
      context,
      { gmailSync, rawObjectStore: { putIfAbsent }, repository },
      { now: () => startedAt },
    )).resolves.toEqual({
      outcome: "completed",
      snapshotHistoryId: "700",
      pagesProcessed: 1,
      messagesPersisted: 1,
      completedAt: startedAt,
    });

    expect(gmailInitialSyncLookbackDays).toBe(7);
    expect(listInitialMessages).toHaveBeenCalledWith({
      gmailConnectionId: context.gmailConnectionId,
      receivedAfter: "2026-07-21T06:00:00.000Z",
      pageSize: 100,
    });
    expect(putIfAbsent).toHaveBeenCalledTimes(1);
    expect(persistPage).toHaveBeenCalledWith(expect.objectContaining({
      expectedPageToken: null,
      nextPageToken: null,
      snapshotHistoryId: "700",
      messages: [
        expect.objectContaining({
          providerMessageId: "gmail-message-in-window",
          providerThreadId: "gmail-thread-in-window",
          historyId: "700",
          receivedAt: new Date("2026-07-27T06:00:00.000Z"),
          rawContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    }));
  });

  it("resumes from the committed page token without listing earlier pages", async () => {
    const listInitialMessages = vi.fn<GmailSyncPort["listInitialMessages"]>()
      .mockResolvedValue({
        snapshotHistoryId: "701",
        messages: [],
      });
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages,
      getMessage: vi.fn(),
    };
    const repository: InitialMailSyncRepository = {
      loadOrCreateCheckpoint: vi.fn().mockResolvedValue({
        state: "pending",
        startedAt,
        snapshotHistoryId: "701",
        nextPageToken: "initial-page-2",
      }),
      persistPage: vi.fn().mockResolvedValue({
        state: "completed",
        checkpoint: {
          state: "completed",
          startedAt,
          snapshotHistoryId: "701",
          completedAt: startedAt,
        },
        insertedMessages: 0,
      }),
    };

    await runGmailInitialSyncWorkflow(
      context,
      {
        gmailSync,
        repository,
        rawObjectStore: { putIfAbsent: vi.fn() },
      },
      { now: () => startedAt },
    );

    expect(listInitialMessages).toHaveBeenCalledOnce();
    expect(listInitialMessages).toHaveBeenCalledWith({
      gmailConnectionId: context.gmailConnectionId,
      receivedAfter: "2026-07-21T06:00:00.000Z",
      pageToken: "initial-page-2",
      pageSize: 100,
    });
  });

  it("stops immediately when the durable checkpoint is already complete", async () => {
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages: vi.fn(),
      getMessage: vi.fn(),
    };
    const repository: InitialMailSyncRepository = {
      loadOrCreateCheckpoint: vi.fn().mockResolvedValue({
        state: "completed",
        startedAt,
        snapshotHistoryId: "702",
        completedAt: new Date("2026-07-28T06:05:00.000Z"),
      }),
      persistPage: vi.fn(),
    };

    await expect(runGmailInitialSyncWorkflow(
      context,
      {
        gmailSync,
        repository,
        rawObjectStore: { putIfAbsent: vi.fn() },
      },
    )).resolves.toEqual({
      outcome: "already_completed",
      snapshotHistoryId: "702",
      completedAt: new Date("2026-07-28T06:05:00.000Z"),
    });
    expect(gmailSync.listInitialMessages).not.toHaveBeenCalled();
  });

  it("fails before listing provider messages when checkpoint preflight fails", async () => {
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages: vi.fn(),
      getMessage: vi.fn(),
    };
    const repository: InitialMailSyncRepository = {
      loadOrCreateCheckpoint: vi.fn().mockRejectedValue(
        new Error("Gmail connection is unavailable for Initial Mail Sync."),
      ),
      persistPage: vi.fn(),
    };

    await expect(runGmailInitialSyncWorkflow(
      context,
      {
        gmailSync,
        repository,
        rawObjectStore: { putIfAbsent: vi.fn() },
      },
    )).rejects.toThrow("Gmail connection is unavailable");
    expect(gmailSync.listInitialMessages).not.toHaveBeenCalled();
    expect(gmailSync.getMessage).not.toHaveBeenCalled();
  });

  it("rejects a changed snapshot before raw messages or cursor advancement", async () => {
    const gmailSync: GmailSyncPort = {
      ...unusedGmailMethods,
      listInitialMessages: vi.fn().mockResolvedValue({
        snapshotHistoryId: "704",
        messages: [{
          providerMessageId: "gmail-message-128",
          providerThreadId: "gmail-thread-128",
        }],
      }),
      getMessage: vi.fn(),
    };
    const repository: InitialMailSyncRepository = {
      loadOrCreateCheckpoint: vi.fn().mockResolvedValue({
        state: "pending",
        startedAt,
        snapshotHistoryId: "703",
        nextPageToken: "initial-page-2",
      }),
      persistPage: vi.fn(),
    };
    const rawObjectStore = {
      putIfAbsent: vi.fn<InitialMailRawObjectStore["putIfAbsent"]>(),
    };

    await expect(runGmailInitialSyncWorkflow(
      context,
      { gmailSync, repository, rawObjectStore },
    )).rejects.toThrow("snapshot History ID changed");
    expect(gmailSync.getMessage).not.toHaveBeenCalled();
    expect(rawObjectStore.putIfAbsent).not.toHaveBeenCalled();
    expect(repository.persistPage).not.toHaveBeenCalled();
  });

  it("uses a stable project-and-connection Workflow ID", () => {
    expect(initialMailSyncWorkflowId(
      context.websiteProjectId,
      context.gmailConnectionId,
    )).toBe(
      `mail-initial-sync/${context.websiteProjectId}/${context.gmailConnectionId}`,
    );
  });
});
