import { describe, expect, it, vi } from "vitest";

import {
  GmailSendActivity,
  type GmailSendCommandLoader,
  type GmailSendPolicyInputLoader,
} from "../../src/modules/backlinks/application/activities/send-activity.js";
import type {
  SendAttemptRepository,
} from "../../src/modules/backlinks/application/services/send-attempt.repository.js";
import type {
  GmailSendPort,
} from "../../src/modules/backlinks/ports/gmail-send.port.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
} from "../../src/modules/backlinks/ports/google-auth.port.js";

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
  const dispatchOrder: string[] = [];
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
  const commandLoader: GmailSendCommandLoader = {
    load: vi.fn().mockResolvedValue(command),
  };
  const connectionHealthCheck = {
    run: vi.fn().mockImplementation(async () => {
      dispatchOrder.push("health");
    }),
  };
  const acceptedSendHandler = {
    run: vi.fn().mockResolvedValue(undefined),
  };
  const commandContextCleanup = {
    run: vi.fn().mockResolvedValue(undefined),
  };
  const policyInputLoader: GmailSendPolicyInputLoader = {
    load: vi.fn().mockImplementation(async () => {
      dispatchOrder.push("policy");
      return {
        evaluatedAt: "2026-07-28T09:18:00.000Z",
        draft: {
          status: "approved",
          approvedVersionId:
            "018f0000-0000-7000-8000-000000000318",
          requestedVersionId:
            "018f0000-0000-7000-8000-000000000318",
        },
        suppression: { suppressed: false },
        connection: {
          connectionStatus: "CONNECTED",
          sendAvailability: "AVAILABLE",
        },
        quota: {
          status: "RESERVED",
          eligibleAt: "2026-07-28T09:17:00.000Z",
          expiresAt: "2026-07-28T09:28:00.000Z",
        },
        killSwitches: {
          GLOBAL: false,
          ORGANIZATION: false,
          WORKSPACE: false,
          WEBSITE_PROJECT: false,
          GMAIL_SEND: false,
        },
        cooldownUntil: null,
      };
    }),
  };
  const gmail: GmailSendPort = {
    send: vi.fn().mockImplementation(async () => {
      dispatchOrder.push("send");
      return {
        kind: "accepted" as const,
        providerMessageId: "gmail-message-118",
      };
    }),
  };
  const activity = new GmailSendActivity({
    repository,
    commandLoader,
    connectionHealthCheck,
    policyInputLoader,
    gmail,
    commandContextCleanup,
    acceptedSendHandler,
    clock: () => new Date("2026-07-28T09:18:00.000Z"),
  });
  return {
    activity,
    repository,
    commandLoader,
    connectionHealthCheck,
    acceptedSendHandler,
    commandContextCleanup,
    policyInputLoader,
    gmail,
    dispatchOrder,
  };
};

describe("BL-AI-118 Gmail Send Activity", () => {
  it("commits DISPATCHING before loading MIME and calling Gmail once", async () => {
    const fixture = createActivity();

    await expect(fixture.activity.claimAttempt({
      ...context,
      sendIntentId: attempt.sendIntentId,
      maxAttempts: 3,
    })).resolves.toEqual({ state: "claimed", attempt });
    await expect(fixture.activity.dispatchAttempt({
      context,
      attempt,
    })).resolves.toEqual({
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
    expect(fixture.commandContextCleanup.run).not.toHaveBeenCalled();
    expect(fixture.connectionHealthCheck.run).toHaveBeenCalledWith({
      context,
      attempt,
    });
    expect(fixture.dispatchOrder).toEqual(["health", "policy", "send"]);
  });

  it("settles a mismatched command as definitely not sent", async () => {
    const fixture = createActivity();
    vi.mocked(fixture.commandLoader.load).mockResolvedValue({
      ...command,
      rfcMessageId: "<different@send.growthos.invalid>",
    });

    await expect(fixture.activity.dispatchAttempt({
      context,
      attempt,
    })).resolves.toEqual({
      kind: "definitely_not_sent",
      code: "GMAIL_SEND_INVALID_REQUEST",
      retryable: false,
    });
    expect(fixture.gmail.send).not.toHaveBeenCalled();
  });

  it("settles a temporary OAuth refresh failure for bounded retry", async () => {
    const fixture = createActivity();
    vi.mocked(fixture.connectionHealthCheck.run).mockRejectedValue(
      new GoogleAuthError({
        operation: "refresh",
        code: googleAuthFailureCodes.temporaryFailure,
        retryable: true,
      }),
    );

    await expect(fixture.activity.dispatchAttempt({
      context,
      attempt,
    })).resolves.toEqual({
      kind: "definitely_not_sent",
      code: "GMAIL_SEND_TOKEN_REFRESH_FAILED",
      retryable: true,
    });
    expect(fixture.policyInputLoader.load).not.toHaveBeenCalled();
    expect(fixture.gmail.send).not.toHaveBeenCalled();
    expect(fixture.commandContextCleanup.run).toHaveBeenCalledWith({
      context,
      attempt,
    });
  });

  it("settles an expired OAuth grant without retrying", async () => {
    const fixture = createActivity();
    vi.mocked(fixture.connectionHealthCheck.run).mockRejectedValue(
      new GoogleAuthError({
        operation: "refresh",
        code: googleAuthFailureCodes.authExpired,
        retryable: false,
      }),
    );

    await expect(fixture.activity.dispatchAttempt({
      context,
      attempt,
    })).resolves.toEqual({
      kind: "definitely_not_sent",
      code: "GMAIL_SEND_REAUTH_REQUIRED",
      retryable: false,
    });
    expect(fixture.gmail.send).not.toHaveBeenCalled();
  });

  it("marks an unexpected provider exception as acceptance unknown", async () => {
    const fixture = createActivity();
    vi.mocked(fixture.gmail.send).mockRejectedValue(
      new Error("provider connection closed"),
    );

    await expect(fixture.activity.dispatchAttempt({
      context,
      attempt,
    })).resolves.toEqual({
      kind: "acceptance_unknown",
      code: "GMAIL_SEND_AMBIGUOUS_RESULT",
    });
  });

  it("persists retry eligibility and provider receipt through the repository", async () => {
    const fixture = createActivity();

    await fixture.activity.settleAttempt({
      context,
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
    expect(fixture.acceptedSendHandler.run).not.toHaveBeenCalled();
  });

  it("ensures reply polling after Gmail acceptance is persisted", async () => {
    const fixture = createActivity();

    await fixture.activity.settleAttempt({
      context,
      attempt,
      settlement: {
        status: "PROVIDER_ACCEPTED",
        providerMessageId: "gmail-message-118",
        providerThreadId: "gmail-thread-118",
      },
    });

    expect(fixture.acceptedSendHandler.run).toHaveBeenCalledWith({
      context,
      attempt,
      settlement: {
        status: "PROVIDER_ACCEPTED",
        providerMessageId: "gmail-message-118",
        providerThreadId: "gmail-thread-118",
      },
      result: {
        state: "completed",
        providerMessageId: "gmail-message-118",
        providerThreadId: null,
        rfcMessageId: attempt.rfcMessageId,
      },
    });
  });
});
