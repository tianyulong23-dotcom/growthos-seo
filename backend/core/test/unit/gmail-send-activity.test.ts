import { describe, expect, it, vi } from "vitest";

import {
  GmailSendActivity,
  type GmailSendCommandLoader,
  type SendExecutionContextResolver,
} from "../../src/modules/backlinks/application/activities/send-activity.js";
import type {
  SendAttemptRepository,
} from "../../src/modules/backlinks/application/services/send-attempt.repository.js";
import type {
  GmailSendPort,
} from "../../src/modules/backlinks/ports/gmail-send.port.js";

const context = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000004",
  actorId: "worker-bl-ai-118",
};
const attempt = {
  sendIntentId: "018f0000-0000-7000-8000-000000000118",
  attemptId: "018f0000-0000-7000-8000-000000000218",
  attemptNo: 1,
  fencingToken: 1,
  rfcMessageId:
    "<018f0000-0000-7000-8000-000000000118.1@send.growthos.invalid>",
};
const command = {
  gmailConnectionId: context.gmailConnectionId,
  rawBase64Url: "UmV2aWV3ZWQtbWVzc2FnZQ",
  rfcMessageId: attempt.rfcMessageId,
  requestId: attempt.attemptId,
};

const createActivity = () => {
  const repository: SendAttemptRepository = {
    claim: vi.fn().mockResolvedValue({
      state: "claimed",
      attempt,
    }),
    settle: vi.fn().mockResolvedValue({
      state: "completed",
      providerMessageId: "gmail-message-118",
      providerThreadId: null,
      rfcMessageId: attempt.rfcMessageId,
    }),
  };
  const contextResolver: SendExecutionContextResolver = {
    resolve: vi.fn().mockResolvedValue(context),
  };
  const commandLoader: GmailSendCommandLoader = {
    load: vi.fn().mockResolvedValue(command),
  };
  const gmail: GmailSendPort = {
    send: vi.fn().mockResolvedValue({
      kind: "accepted",
      providerMessageId: "gmail-message-118",
    }),
  };
  const activity = new GmailSendActivity({
    repository,
    contextResolver,
    commandLoader,
    gmail,
    clock: () => new Date("2026-07-28T09:18:00.000Z"),
  });
  return { activity, repository, contextResolver, commandLoader, gmail };
};

describe("BL-AI-118 Gmail Send Activity", () => {
  it("commits DISPATCHING before loading MIME and calling Gmail once", async () => {
    const fixture = createActivity();

    await expect(fixture.activity.claimAttempt({
      sendIntentId: attempt.sendIntentId,
      maxAttempts: 3,
    })).resolves.toEqual({ state: "claimed", attempt });
    await expect(fixture.activity.dispatchAttempt(attempt)).resolves.toEqual({
      kind: "accepted",
      providerMessageId: "gmail-message-118",
    });

    expect(fixture.repository.claim).toHaveBeenCalledWith({
      ...context,
      sendIntentId: attempt.sendIntentId,
      maxAttempts: 3,
      claimedAt: new Date("2026-07-28T09:18:00.000Z"),
    });
    expect(fixture.commandLoader.load).toHaveBeenCalledWith({
      context,
      attempt,
    });
    expect(fixture.gmail.send).toHaveBeenCalledTimes(1);
    expect(fixture.gmail.send).toHaveBeenCalledWith(command);
  });

  it("rejects a command that does not carry the claimed RFC Message-ID", async () => {
    const fixture = createActivity();
    vi.mocked(fixture.commandLoader.load).mockResolvedValue({
      ...command,
      rfcMessageId: "<different@send.growthos.invalid>",
    });

    await expect(fixture.activity.dispatchAttempt(attempt)).rejects.toThrow(
      "Gmail Send command does not match the claimed Attempt.",
    );
    expect(fixture.gmail.send).not.toHaveBeenCalled();
  });

  it("persists retry eligibility and provider receipt through the repository", async () => {
    const fixture = createActivity();

    await fixture.activity.settleAttempt({
      attempt,
      settlement: {
        status: "FAILED_RETRYABLE",
        errorCode: "GMAIL_SEND_RATE_LIMITED",
        retryAfterSeconds: 30,
      },
    });
    expect(fixture.repository.settle).toHaveBeenCalledWith({
      ...context,
      ...attempt,
      status: "FAILED_RETRYABLE",
      providerMessageId: null,
      providerThreadId: null,
      errorCode: "GMAIL_SEND_RATE_LIMITED",
      completedAt: new Date("2026-07-28T09:18:00.000Z"),
      retryEligibleAt: new Date("2026-07-28T09:18:30.000Z"),
    });
  });
});
