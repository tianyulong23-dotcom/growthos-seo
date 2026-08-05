import { describe, expect, it, vi } from "vitest";

import {
  runUnknownSendResultWorkflow,
  unknownSendResultWorkflowId,
  type UnknownSendResultWorkflowActivities,
} from "../../src/modules/backlinks/application/workflows/unknown-send-result-workflow.js";

const sendIntentId = "018f0000-0000-7000-8000-000000000119";
const attempt = {
  sendIntentId,
  attemptId: "018f0000-0000-7000-8000-000000000219",
  rfcMessageId: `<${sendIntentId}.1@send.growthos.invalid>`,
  errorCode: "GMAIL_SEND_TIMEOUT",
};

describe("BL-AI-119 unknown send result workflow", () => {
  it("uses one stable Workflow ID per Send Intent", () => {
    expect(unknownSendResultWorkflowId(sendIntentId)).toBe(
      `send-reconciliation/${sendIntentId}`,
    );
  });

  it("records a Gmail Message-ID match without dispatching another send", async () => {
    const load = vi.fn<UnknownSendResultWorkflowActivities["load"]>()
      .mockResolvedValue({ state: "pending", attempt });
    const query = vi.fn<UnknownSendResultWorkflowActivities["query"]>()
      .mockResolvedValue({
        kind: "found",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
        evidenceReference: "gmail:message/gmail-message-119",
      });
    const reconcile = vi.fn<UnknownSendResultWorkflowActivities["reconcile"]>()
      .mockResolvedValue({
        outcome: "completed",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
        rfcMessageId: attempt.rfcMessageId,
      });

    await expect(runUnknownSendResultWorkflow(
      { sendIntentId },
      { load, query, reconcile },
    )).resolves.toEqual({
      outcome: "completed",
      providerMessageId: "gmail-message-119",
      providerThreadId: "gmail-thread-119",
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(query).toHaveBeenCalledWith({
      sendIntentId,
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(reconcile).toHaveBeenCalledWith({
      attempt,
      decision: {
        outcome: "PROVIDER_ACCEPTED",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
        evidenceReference: "gmail:message/gmail-message-119",
      },
    });
  });

  it("requires manual confirmation when Gmail cannot prove the outcome", async () => {
    const activities: UnknownSendResultWorkflowActivities = {
      load: vi.fn().mockResolvedValue({ state: "pending", attempt }),
      query: vi.fn().mockResolvedValue({ kind: "not_found" }),
      reconcile: vi.fn(),
    };

    await expect(runUnknownSendResultWorkflow(
      { sendIntentId },
      activities,
    )).resolves.toEqual({
      outcome: "manual_confirmation_required",
      attemptId: attempt.attemptId,
      rfcMessageId: attempt.rfcMessageId,
      errorCode: attempt.errorCode,
    });
    expect(activities.reconcile).not.toHaveBeenCalled();
  });

  it("allows an evidenced manual confirmed-not-sent decision to end the Intent", async () => {
    const reconcile = vi.fn<UnknownSendResultWorkflowActivities["reconcile"]>()
      .mockResolvedValue({
        outcome: "failed_final",
        errorCode: "GMAIL_SEND_RECONCILED_NOT_SENT",
        rfcMessageId: attempt.rfcMessageId,
      });
    const activities: UnknownSendResultWorkflowActivities = {
      load: vi.fn().mockResolvedValue({ state: "pending", attempt }),
      query: vi.fn(),
      reconcile,
    };

    await expect(runUnknownSendResultWorkflow({
      sendIntentId,
      manualDecision: {
        outcome: "CONFIRMED_NOT_SENT",
        evidenceReference: "case:ops-119",
      },
    }, activities)).resolves.toEqual({
      outcome: "failed_final",
      errorCode: "GMAIL_SEND_RECONCILED_NOT_SENT",
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(activities.query).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith({
      attempt,
      decision: {
        outcome: "CONFIRMED_NOT_SENT",
        evidenceReference: "case:ops-119",
      },
    });
  });

  it("replays a recorded reconciliation without another Gmail query or write", async () => {
    const activities: UnknownSendResultWorkflowActivities = {
      load: vi.fn().mockResolvedValue({
        state: "reconciled",
        outcome: "completed",
        providerMessageId: "gmail-message-119",
        providerThreadId: null,
        rfcMessageId: attempt.rfcMessageId,
      }),
      query: vi.fn(),
      reconcile: vi.fn(),
    };

    await expect(runUnknownSendResultWorkflow(
      { sendIntentId },
      activities,
    )).resolves.toEqual({
      outcome: "completed",
      providerMessageId: "gmail-message-119",
      providerThreadId: null,
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(activities.query).not.toHaveBeenCalled();
    expect(activities.reconcile).not.toHaveBeenCalled();
  });
});
