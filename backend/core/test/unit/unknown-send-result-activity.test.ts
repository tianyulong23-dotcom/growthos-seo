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
  rfcMessageId:
    "<018f0000-0000-7000-8000-000000000119.1@send.growthos.invalid>",
  errorCode: "GMAIL_SEND_TIMEOUT",
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
    const activity = new UnknownSendResultActivity({
      repository,
      contextResolver: { resolve: vi.fn().mockResolvedValue(context) },
      gmailQuery,
      clock: () => new Date("2026-07-28T10:15:00.000Z"),
    });

    await expect(activity.load({ sendIntentId: attempt.sendIntentId }))
      .resolves.toEqual({ state: "pending", attempt });
    await expect(activity.query({
      sendIntentId: attempt.sendIntentId,
      rfcMessageId: attempt.rfcMessageId,
    })).resolves.toEqual({ kind: "not_found" });
    await activity.reconcile({
      attempt,
      decision: {
        outcome: "CONFIRMED_NOT_SENT",
        evidenceReference: "case:ops-119",
      },
    });

    expect(gmailQuery.findByRfcMessageId).toHaveBeenCalledWith({
      gmailConnectionId: context.gmailConnectionId,
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
});
