import { describe, expect, it, vi } from "vitest";

import {
  UnknownSendResultActivity,
} from "../../src/modules/backlinks/application/activities/unknown-send-result-activity.js";
import type {
  SendReconciliationRepository,
} from "../../src/modules/backlinks/application/services/send-reconciliation.repository.js";
import type {
  GmailSentMessageQueryPort,
} from "../../src/modules/backlinks/ports/gmail-sent-message-query.port.js";

const context = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000004",
  actorId: "operator-bl-ai-119",
};
const attempt = {
  sendIntentId: "018f0000-0000-7000-8000-000000000119",
  attemptId: "018f0000-0000-7000-8000-000000000219",
  attemptNo: 1,
  fencingToken: 1,
  rfcMessageId:
    "<018f0000-0000-7000-8000-000000000119.1@send.growthos.invalid>",
  errorCode: "GMAIL_SEND_TIMEOUT",
  status: "DELIVERY_UNKNOWN" as const,
};

describe("BL-AI-119 unknown send result activity", () => {
  it("uses trusted context to query Gmail and records an evidenced decision", async () => {
    const repository: SendReconciliationRepository = {
      load: vi.fn().mockResolvedValue({ state: "pending", attempt }),
      reconcile: vi.fn().mockResolvedValue({
        outcome: "completed",
        providerMessageId: "gmail-message-119",
        providerThreadId: null,
        rfcMessageId: attempt.rfcMessageId,
      }),
    };
    const gmailQuery: GmailSentMessageQueryPort = {
      findByRfcMessageId: vi.fn().mockResolvedValue({ kind: "not_found" }),
    };
    const dispatchRecovery = { settleAttempt: vi.fn() };
    const activity = new UnknownSendResultActivity({
      repository,
      gmailQuery,
      dispatchRecovery,
      clock: () => new Date("2026-07-28T10:15:00.000Z"),
    });

    await expect(activity.load({ ...context, sendIntentId: attempt.sendIntentId }))
      .resolves.toEqual({ state: "pending", attempt });
    await expect(activity.query({
      ...context,
      sendIntentId: attempt.sendIntentId,
      rfcMessageId: attempt.rfcMessageId,
    })).resolves.toEqual({ kind: "not_found" });
    await activity.reconcile({
      ...context,
      attempt,
      decision: {
        outcome: "CONFIRMED_NOT_SENT",
        evidenceReference: "case:ops-119",
      },
    });

    expect(gmailQuery.findByRfcMessageId).toHaveBeenCalledWith({
      ...context,
      sendIntentId: attempt.sendIntentId,
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(repository.reconcile).toHaveBeenCalledWith({
      ...context,
      attempt,
      decision: {
        outcome: "CONFIRMED_NOT_SENT",
        evidenceReference: "case:ops-119",
      },
      reconciledAt: new Date("2026-07-28T10:15:00.000Z"),
    });
  });

  it("settles a stale dispatch when Gmail already contains the Message-ID", async () => {
    const dispatchAttempt = {
      ...attempt,
      status: "DISPATCHING" as const,
      errorCode: "GMAIL_SEND_DISPATCH_STALLED",
    };
    const dispatchRecovery = {
      settleAttempt: vi.fn().mockResolvedValue({
        state: "completed",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
        rfcMessageId: dispatchAttempt.rfcMessageId,
      }),
    };
    const activity = new UnknownSendResultActivity({
      repository: {
        load: vi.fn(),
        reconcile: vi.fn(),
      },
      gmailQuery: { findByRfcMessageId: vi.fn() },
      dispatchRecovery,
    });

    await expect(activity.recoverDispatch({
      context,
      attempt: dispatchAttempt,
      queryResult: {
        kind: "found",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
        evidenceReference: "gmail:message/gmail-message-119",
      },
    })).resolves.toEqual({
      outcome: "completed",
      providerMessageId: "gmail-message-119",
      providerThreadId: "gmail-thread-119",
      rfcMessageId: dispatchAttempt.rfcMessageId,
    });
    expect(dispatchRecovery.settleAttempt).toHaveBeenCalledWith({
      context,
      attempt: {
        sendIntentId: dispatchAttempt.sendIntentId,
        attemptId: dispatchAttempt.attemptId,
        attemptNo: 1,
        fencingToken: 1,
        rfcMessageId: dispatchAttempt.rfcMessageId,
      },
      settlement: {
        status: "PROVIDER_ACCEPTED",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
      },
    });
  });

  it("retries only after Gmail explicitly reports the Message-ID absent", async () => {
    const dispatchAttempt = {
      ...attempt,
      status: "DISPATCHING" as const,
      errorCode: "GMAIL_SEND_DISPATCH_STALLED",
    };
    const dispatchRecovery = {
      settleAttempt: vi.fn().mockResolvedValue({
        state: "retry_scheduled",
        retryAfterSeconds: 5,
      }),
    };
    const activity = new UnknownSendResultActivity({
      repository: {
        load: vi.fn(),
        reconcile: vi.fn(),
      },
      gmailQuery: { findByRfcMessageId: vi.fn() },
      dispatchRecovery,
    });

    await expect(activity.recoverDispatch({
      context,
      attempt: dispatchAttempt,
      queryResult: { kind: "not_found" },
    })).resolves.toEqual({
      outcome: "retry_scheduled",
      retryAfterSeconds: 5,
    });
    expect(dispatchRecovery.settleAttempt).toHaveBeenCalledWith({
      context,
      attempt: {
        sendIntentId: dispatchAttempt.sendIntentId,
        attemptId: dispatchAttempt.attemptId,
        attemptNo: 1,
        fencingToken: 1,
        rfcMessageId: dispatchAttempt.rfcMessageId,
      },
      settlement: {
        status: "FAILED_RETRYABLE",
        errorCode: "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND",
        retryAfterSeconds: 5,
      },
    });
  });

  it("does not settle a stale dispatch when Gmail lookup is inconclusive", async () => {
    const dispatchRecovery = { settleAttempt: vi.fn() };
    const activity = new UnknownSendResultActivity({
      repository: {
        load: vi.fn(),
        reconcile: vi.fn(),
      },
      gmailQuery: { findByRfcMessageId: vi.fn() },
      dispatchRecovery,
    });

    await expect(activity.recoverDispatch({
      context,
      attempt: {
        ...attempt,
        status: "DISPATCHING",
        errorCode: "GMAIL_SEND_DISPATCH_STALLED",
      },
      queryResult: {
        kind: "inconclusive",
        code: "GMAIL_SEND_RECONCILIATION_UNAVAILABLE",
      },
    })).resolves.toEqual({
      outcome: "recheck_required",
      attemptId: attempt.attemptId,
      rfcMessageId: attempt.rfcMessageId,
      errorCode: "GMAIL_SEND_RECONCILIATION_UNAVAILABLE",
    });
    expect(dispatchRecovery.settleAttempt).not.toHaveBeenCalled();
  });
});
