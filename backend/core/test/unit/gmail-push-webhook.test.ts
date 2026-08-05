import { describe, expect, it, vi } from "vitest";

import {
  GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
  createGmailPushWebhook,
  gmailPushWebhookFailureCodes,
  type GmailPushSyncTarget,
} from "../../src/modules/backlinks/application/workflows/mail-push-webhook.js";
import {
  createGmailPushIncrementalSyncOutboxRelay,
  createGmailPushIncrementalSyncWorkflowRelay,
} from "../../src/modules/backlinks/application/workflows/mail-push-outbox-relay.js";
import type {
  IncrementalMailRawObjectStore,
} from "../../src/modules/backlinks/application/workflows/mail-incremental-sync-workflow.js";
import type {
  IncrementalMailSyncRepository,
} from "../../src/modules/backlinks/application/services/mail-incremental-sync.repository.js";
import type {
  ClaimedOutboxEvent,
} from "../../src/modules/backlinks/db/repositories/outbox.repository.js";
import type {
  GmailSyncPort,
} from "../../src/modules/backlinks/ports/gmail-sync.port.js";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000141",
  workspaceId: "20000000-0000-4000-8000-000000000141",
  websiteProjectId: "30000000-0000-4000-8000-000000000141",
  gmailConnectionId: "40000000-0000-4000-8000-000000000141",
} as const satisfies GmailPushSyncTarget;
const subscription =
  "projects/growthos/subscriptions/backlinks-gmail-push";
const notification = {
  emailAddress: "Owner@Example.test",
  historyId: "99141",
};
const body = {
  message: {
    data: Buffer.from(JSON.stringify(notification)).toString("base64"),
    messageId: "1410000000001",
    publishTime: "2026-07-29T04:01:00.000Z",
  },
  subscription,
};

const createDependencies = () => {
  const verify = vi.fn(async () => undefined);
  const resolve = vi.fn(async () => scope);
  const append = vi.fn(async () => ({
    state: "appended" as const,
    eventId: "50000000-0000-4000-8000-000000000141",
  }));
  return {
    append,
    resolve,
    verify,
    webhook: createGmailPushWebhook({
      config: { enabled: true },
      identityVerifier: { verify },
      targetResolver: { resolve },
      outbox: { append },
      newId: () => "50000000-0000-4000-8000-000000000141",
    }),
  };
};

describe("BL-AI-141 Gmail Push Webhook workflow", () => {
  it("defaults off before authentication, resolution, or Outbox work", async () => {
    const verify = vi.fn(async () => undefined);
    const resolve = vi.fn(async () => scope);
    const append = vi.fn(async () => ({
      state: "appended" as const,
      eventId: "50000000-0000-4000-8000-000000000141",
    }));
    const webhook = createGmailPushWebhook({
      identityVerifier: { verify },
      targetResolver: { resolve },
      outbox: { append },
    });

    await expect(webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body,
    })).rejects.toMatchObject({
      code: gmailPushWebhookFailureCodes.disabled,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("authenticates first and rejects forged requests without side effects", async () => {
    const dependencies = createDependencies();
    dependencies.verify.mockRejectedValueOnce(new Error("forged"));

    await expect(dependencies.webhook.handle({
      authorizationHeader: "Bearer forged.token.value",
      body,
    })).rejects.toThrow("forged");
    expect(dependencies.resolve).not.toHaveBeenCalled();
    expect(dependencies.append).not.toHaveBeenCalled();
  });

  it("rejects invalid notifications and unauthorized targets", async () => {
    const malformed = createDependencies();
    await expect(malformed.webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body: { message: { data: "***", messageId: "141" }, subscription },
    })).rejects.toMatchObject({
      code: gmailPushWebhookFailureCodes.invalidNotification,
    });
    expect(malformed.resolve).not.toHaveBeenCalled();
    expect(malformed.append).not.toHaveBeenCalled();

    const unauthorized = createDependencies();
    unauthorized.resolve.mockResolvedValueOnce(null);
    await expect(unauthorized.webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body,
    })).rejects.toMatchObject({
      code: gmailPushWebhookFailureCodes.unauthorizedTarget,
    });
    expect(unauthorized.resolve).toHaveBeenCalledWith({
      subscription,
      emailAddress: "owner@example.test",
    });
    expect(unauthorized.append).not.toHaveBeenCalled();
  });

  it("deduplicates by provider message and writes only a sync trigger", async () => {
    const dependencies = createDependencies();
    dependencies.append
      .mockResolvedValueOnce({
        state: "appended",
        eventId: "50000000-0000-4000-8000-000000000141",
      })
      .mockResolvedValueOnce({
        state: "existing",
        eventId: "50000000-0000-4000-8000-000000000141",
      });

    await expect(dependencies.webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body,
    })).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(dependencies.webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body,
    })).resolves.toEqual({ accepted: true, duplicate: true });

    const first = dependencies.append.mock.calls[0]?.[0];
    const second = dependencies.append.mock.calls[1]?.[0];
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ...scope,
      eventType: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
      aggregateVersion: 1,
      payloadSchemaVersion: 1,
      actorId: "gmail-push-webhook",
      payload: {
        contractVersion: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
        ...scope,
        trigger: "GMAIL_PUSH",
      },
    });
    expect(JSON.stringify(first?.payload)).not.toMatch(
      /owner@example|99141|1410000000001|message|mailBody/iu,
    );
  });
});

describe("BL-AI-141 Gmail Push Outbox sync trigger", () => {
  const event = {
    eventId: "50000000-0000-4000-8000-000000000141",
    ...scope,
    eventType: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
    aggregateId: "60000000-0000-5000-8000-000000000141",
    aggregateVersion: 1,
    idempotencyKey: "gmail-push:dedupe",
    payload: {
      contractVersion: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
      ...scope,
      trigger: "GMAIL_PUSH",
    },
    payloadSchemaVersion: 1,
    status: "processing",
    availableAt: new Date("2026-07-29T04:01:00.000Z"),
    attemptCount: 1,
  } as const satisfies ClaimedOutboxEvent;

  it("starts only incremental sync from the durable cursor context", async () => {
    const claim = vi.fn(async () => [event]);
    const mark = vi.fn(async () => true);
    const start = vi.fn(async () => undefined);
    const relay = createGmailPushIncrementalSyncOutboxRelay({
      repository: { claim, mark },
      incrementalSyncStarter: { start },
    });

    await expect(relay.runOnce({
      workerId: "gmail-push-relay",
      limit: 10,
      staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(claim).toHaveBeenCalledWith({
      workerId: "gmail-push-relay",
      limit: 10,
      staleClaimBefore: new Date(0),
      eventType: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
    });
    expect(start).toHaveBeenCalledWith({
      ...scope,
      actorId: "gmail-push-webhook",
    });
    expect(mark).toHaveBeenCalledWith({
      eventId: event.eventId,
      workerId: "gmail-push-relay",
      outcome: "published",
    });
  });

  it("wires the module-private relay to the incremental sync workflow starter", async () => {
    const initialSyncCompletedAt = new Date("2026-07-29T03:00:00.000Z");
    const syncedAt = new Date("2026-07-29T04:02:00.000Z");
    const listHistory = vi.fn<GmailSyncPort["listHistory"]>()
      .mockResolvedValue({
        kind: "page",
        latestHistoryId: "99142",
        messages: [],
      });
    const getMessage = vi.fn<GmailSyncPort["getMessage"]>();
    const persistPage = vi.fn<IncrementalMailSyncRepository["persistPage"]>()
      .mockImplementation(async (input) => ({
        state: "completed" as const,
        insertedMessages: 0,
        checkpoint: {
          historyId: input.latestHistoryId,
          nextPageToken: null,
          initialSyncCompletedAt,
          lastSyncedAt: syncedAt,
        },
      }));
    const claim = vi.fn(async () => [event]);
    const mark = vi.fn(async () => true);
    const relay = createGmailPushIncrementalSyncWorkflowRelay({
      repository: { claim, mark },
      workflowDependencies: {
        gmailSync: {
          listInitialMessages: vi.fn<GmailSyncPort["listInitialMessages"]>(),
          listHistory,
          getMessage,
          watch: vi.fn<GmailSyncPort["watch"]>(),
        },
        repository: {
          loadCheckpoint: vi.fn().mockResolvedValue({
            historyId: "99141",
            nextPageToken: null,
            initialSyncCompletedAt,
            lastSyncedAt: initialSyncCompletedAt,
          }),
          persistPage,
        },
        rawObjectStore: {
          putIfAbsent: vi.fn<IncrementalMailRawObjectStore["putIfAbsent"]>(),
        },
      },
      workflowOptions: { now: () => syncedAt },
    });

    await expect(relay.runOnce({
      workerId: "gmail-push-relay",
      limit: 1,
      staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(listHistory).toHaveBeenCalledWith({
      gmailConnectionId: scope.gmailConnectionId,
      startHistoryId: "99141",
      pageSize: 100,
    });
    expect(getMessage).not.toHaveBeenCalled();
    expect(persistPage).toHaveBeenCalledWith(expect.objectContaining({
      ...scope,
      actorId: "gmail-push-webhook",
      latestHistoryId: "99142",
    }));
    expect(mark).toHaveBeenCalledWith({
      eventId: event.eventId,
      workerId: "gmail-push-relay",
      outcome: "published",
    });
  });

  it("fails closed on payload scope changes and releases for retry", async () => {
    const changed = {
      ...event,
      payload: {
        ...event.payload,
        websiteProjectId: "30000000-0000-4000-8000-000000000999",
      },
    };
    const claim = vi.fn(async () => [changed]);
    const mark = vi.fn(async () => true);
    const start = vi.fn(async () => undefined);
    const retryAt = new Date("2026-07-29T04:02:00.000Z");
    const relay = createGmailPushIncrementalSyncOutboxRelay({
      repository: { claim, mark },
      incrementalSyncStarter: { start },
      retryAt: () => retryAt,
    });

    await expect(relay.runOnce({
      workerId: "gmail-push-relay",
      limit: 1,
      staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(start).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith({
      eventId: event.eventId,
      workerId: "gmail-push-relay",
      outcome: "failed",
      retryAt,
    });
  });
});
