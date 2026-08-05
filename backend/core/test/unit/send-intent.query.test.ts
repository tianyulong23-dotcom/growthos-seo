import { describe, expect, it, vi } from "vitest";

import {
  createSendIntentQuery,
} from "../../src/modules/backlinks/application/queries/send-intent.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const context = {
  actor: createActorContext({
    userId: "user-send-query",
    sessionId: "session-send-query",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: "organization-send-query",
    workspaceId: "workspace-send-query",
  }),
  project: createProjectContext({
    websiteProjectId: "project-send-query",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-send-query",
    promotionTargetVersionId: "target-send-query",
  }),
};

describe("Send Intent query", () => {
  it("returns the latest persisted attempt without exposing the recipient", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        sendIntentId: "018f0000-0000-7000-8000-000000000114",
        draftId: "018f0000-0000-7000-8000-000000000314",
        status: "PROVIDER_ACCEPTED",
        version: 3,
        requestedSendAt: new Date("2026-08-03T01:00:00.000Z"),
        updatedAt: new Date("2026-08-03T01:00:02.000Z"),
        attemptId: "018f0000-0000-7000-8000-000000000714",
        attemptNo: 1,
        attemptStatus: "PROVIDER_ACCEPTED",
        rfcMessageId: "<send-114@example.com>",
        providerMessageId: "gmail-message-114",
        providerThreadId: "gmail-thread-114",
        errorCode: null,
        startedAt: new Date("2026-08-03T01:00:01.000Z"),
        completedAt: new Date("2026-08-03T01:00:02.000Z"),
        retryEligibleAt: null,
      }],
    }));

    const result = await createSendIntentQuery({ query }).getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000114",
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("backlink_send_attempts"),
      [
        "organization-send-query",
        "workspace-send-query",
        "project-send-query",
        "018f0000-0000-7000-8000-000000000114",
      ],
    );
    expect(result).toEqual({
      sendIntentId: "018f0000-0000-7000-8000-000000000114",
      draftId: "018f0000-0000-7000-8000-000000000314",
      status: "PROVIDER_ACCEPTED",
      version: 3,
      requestedSendAt: "2026-08-03T01:00:00.000Z",
      updatedAt: "2026-08-03T01:00:02.000Z",
      attempt: {
        attemptId: "018f0000-0000-7000-8000-000000000714",
        attemptNo: 1,
        status: "PROVIDER_ACCEPTED",
        rfcMessageId: "<send-114@example.com>",
        providerMessageId: "gmail-message-114",
        providerThreadId: "gmail-thread-114",
        errorCode: null,
        startedAt: "2026-08-03T01:00:01.000Z",
        completedAt: "2026-08-03T01:00:02.000Z",
        retryEligibleAt: null,
      },
    });
    expect(result).not.toHaveProperty("recipient");
  });

  it("returns a tenant-scoped not-found error", async () => {
    const query = createSendIntentQuery({
      query: async () => ({ rows: [] }),
    });

    await expect(query.getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000999",
    )).rejects.toMatchObject({
      code: "BACKLINK_NOT_FOUND",
    });
  });
});
