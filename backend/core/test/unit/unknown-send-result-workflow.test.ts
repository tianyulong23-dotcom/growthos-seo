import { describe, expect, it, vi } from "vitest";

import {
  runUnknownSendResultWorkflow,
  unknownSendResultWorkflowId,
  type UnknownSendResultWorkflowActivities,
} from "../../src/modules/backlinks/application/workflows/unknown-send-result-workflow.js";

const sendIntentId = "018f0000-0000-7000-8000-000000000119";
const workflowInput = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000004",
  actorId: "operator-bl-ai-119",
  sendIntentId,
};
const attempt = {
  sendIntentId,
  attemptId: "018f0000-0000-7000-8000-000000000219",
  attemptNo: 1,
  fencingToken: 1,
  rfcMessageId: `<${sendIntentId}.1@send.growthos.invalid>`,
  errorCode: "GMAIL_SEND_TIMEOUT",
  status: "DELIVERY_UNKNOWN" as const,
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
    const recoverDispatch =
      vi.fn<UnknownSendResultWorkflowActivities["recoverDispatch"]>();

    await expect(runUnknownSendResultWorkflow(
      workflowInput,
      { load, query, recoverDispatch, reconcile },
    )).resolves.toEqual({
      outcome: "completed",
      providerMessageId: "gmail-message-119",
      providerThreadId: "gmail-thread-119",
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(query).toHaveBeenCalledWith({
      ...workflowInput,
      rfcMessageId: attempt.rfcMessageId,
    });
    expect(reconcile).toHaveBeenCalledWith({
      ...workflowInput,
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
      recoverDispatch: vi.fn(),
      reconcile: vi.fn(),
    };

    await expect(runUnknownSendResultWorkflow(
      workflowInput,
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
      recoverDispatch: vi.fn(),
      reconcile,
    };

    await expect(runUnknownSendResultWorkflow({
      ...workflowInput,
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
      ...workflowInput,
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
      recoverDispatch: vi.fn(),
      reconcile: vi.fn(),
    };

    await expect(runUnknownSendResultWorkflow(
      workflowInput,
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

  it("routes a stale dispatch through exact Gmail recovery", async () => {
    const dispatchAttempt = {
      ...attempt,
      status: "DISPATCHING" as const,
      errorCode: "GMAIL_SEND_DISPATCH_STALLED",
    };
    const recoverDispatch =
      vi.fn<UnknownSendResultWorkflowActivities["recoverDispatch"]>()
        .mockResolvedValue({
          outcome: "retry_scheduled",
          retryAfterSeconds: 5,
        });
    const activities: UnknownSendResultWorkflowActivities = {
      load: vi.fn().mockResolvedValue({
        state: "pending",
        attempt: dispatchAttempt,
      }),
      query: vi.fn().mockResolvedValue({ kind: "not_found" }),
      recoverDispatch,
      reconcile: vi.fn(),
    };

    await expect(runUnknownSendResultWorkflow(
      workflowInput,
      activities,
    )).resolves.toEqual({
      outcome: "retry_scheduled",
      retryAfterSeconds: 5,
    });
    expect(recoverDispatch).toHaveBeenCalledWith({
      context: workflowInput,
      attempt: dispatchAttempt,
      queryResult: { kind: "not_found" },
    });
    expect(activities.reconcile).not.toHaveBeenCalled();
  });
});
