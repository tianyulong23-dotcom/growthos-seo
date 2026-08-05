import { describe, expect, it, vi } from "vitest";

import {
  runGmailSendWorkflow,
  sendIntentWorkflowId,
  type SendWorkflowActivities,
} from "../../src/modules/backlinks/application/workflows/send-workflow.js";
import {
  gmailSendFailureCodes,
} from "../../src/modules/backlinks/ports/gmail-send.port.js";

const sendIntentId = "018f0000-0000-7000-8000-000000000118";
const workflowInput = {
  sendIntentId,
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000004",
  actorId: "worker-bl-ai-118",
};
const attempt = (attemptNo: number) => ({
  sendIntentId,
  attemptId:
    `018f0000-0000-7000-8000-${String(200 + attemptNo).padStart(12, "0")}`,
  attemptNo,
  fencingToken: attemptNo,
  rfcMessageId: `<${sendIntentId}.${attemptNo}@send.growthos.invalid>`,
});

describe("BL-AI-118 Gmail Send Workflow", () => {
  it("uses one stable Workflow ID per Send Intent", () => {
    expect(sendIntentWorkflowId(sendIntentId)).toBe(
      `send-intent/${sendIntentId}`,
    );
  });

  it("persists an accepted Gmail Message ID and does not resend a completed Intent", async () => {
    const claimAttempt = vi.fn<SendWorkflowActivities["claimAttempt"]>()
      .mockResolvedValueOnce({ state: "claimed", attempt: attempt(1) })
      .mockResolvedValueOnce({
        state: "already_completed",
        providerMessageId: "gmail-message-118",
        providerThreadId: "gmail-thread-118",
        rfcMessageId: attempt(1).rfcMessageId,
      });
    const dispatchAttempt = vi.fn<
      SendWorkflowActivities["dispatchAttempt"]
    >().mockResolvedValue({
      kind: "accepted",
      providerMessageId: "gmail-message-118",
      providerThreadId: "gmail-thread-118",
    });
    const settleAttempt = vi.fn<
      SendWorkflowActivities["settleAttempt"]
    >().mockResolvedValue({
      state: "completed",
      providerMessageId: "gmail-message-118",
      providerThreadId: "gmail-thread-118",
      rfcMessageId: attempt(1).rfcMessageId,
    });
    const activities = {
      claimAttempt,
      dispatchAttempt,
      settleAttempt,
    };

    await expect(runGmailSendWorkflow(workflowInput, activities))
      .resolves.toEqual({
        outcome: "completed",
        providerMessageId: "gmail-message-118",
        providerThreadId: "gmail-thread-118",
        rfcMessageId: attempt(1).rfcMessageId,
      });
    await expect(runGmailSendWorkflow(workflowInput, activities))
      .resolves.toEqual({
        outcome: "already_completed",
        providerMessageId: "gmail-message-118",
        providerThreadId: "gmail-thread-118",
        rfcMessageId: attempt(1).rfcMessageId,
      });
    expect(dispatchAttempt).toHaveBeenCalledTimes(1);
    expect(settleAttempt).toHaveBeenCalledWith({
      context: {
        organizationId: workflowInput.organizationId,
        workspaceId: workflowInput.workspaceId,
        websiteProjectId: workflowInput.websiteProjectId,
        gmailConnectionId: workflowInput.gmailConnectionId,
        actorId: workflowInput.actorId,
      },
      attempt: attempt(1),
      settlement: {
        status: "PROVIDER_ACCEPTED",
        providerMessageId: "gmail-message-118",
        providerThreadId: "gmail-thread-118",
      },
    });
  });

  it("never retries an acceptance-unknown result", async () => {
    const activities: SendWorkflowActivities = {
      claimAttempt: vi.fn().mockResolvedValue({
        state: "claimed",
        attempt: attempt(1),
      }),
      dispatchAttempt: vi.fn().mockResolvedValue({
        kind: "acceptance_unknown",
        code: gmailSendFailureCodes.timeout,
      }),
      settleAttempt: vi.fn().mockResolvedValue({
        state: "reconciliation_required",
        attemptId: attempt(1).attemptId,
        rfcMessageId: attempt(1).rfcMessageId,
        errorCode: gmailSendFailureCodes.timeout,
      }),
    };

    await expect(runGmailSendWorkflow(workflowInput, activities))
      .resolves.toEqual({
        outcome: "reconciliation_required",
        attemptId: attempt(1).attemptId,
        rfcMessageId: attempt(1).rfcMessageId,
        errorCode: gmailSendFailureCodes.timeout,
      });
    expect(activities.dispatchAttempt).toHaveBeenCalledTimes(1);
    expect(activities.settleAttempt).toHaveBeenCalledWith({
      context: {
        organizationId: workflowInput.organizationId,
        workspaceId: workflowInput.workspaceId,
        websiteProjectId: workflowInput.websiteProjectId,
        gmailConnectionId: workflowInput.gmailConnectionId,
        actorId: workflowInput.actorId,
      },
      attempt: attempt(1),
      settlement: {
        status: "DELIVERY_UNKNOWN",
        errorCode: gmailSendFailureCodes.timeout,
      },
    });
  });

  it("retries only definitely-not-sent failures and stops at the configured bound", async () => {
    const wait = vi.fn(async () => undefined);
    const activities: SendWorkflowActivities = {
      claimAttempt: vi.fn()
        .mockResolvedValueOnce({ state: "claimed", attempt: attempt(1) })
        .mockResolvedValueOnce({ state: "claimed", attempt: attempt(2) })
        .mockResolvedValueOnce({ state: "claimed", attempt: attempt(3) }),
      dispatchAttempt: vi.fn().mockResolvedValue({
        kind: "definitely_not_sent",
        code: gmailSendFailureCodes.rateLimited,
        retryable: true,
        retryAfterSeconds: 30,
      }),
      settleAttempt: vi.fn()
        .mockResolvedValueOnce({
          state: "retry_scheduled",
          retryAfterSeconds: 30,
        })
        .mockResolvedValueOnce({
          state: "retry_scheduled",
          retryAfterSeconds: 30,
        })
        .mockResolvedValueOnce({
          state: "failed_final",
          errorCode: gmailSendFailureCodes.rateLimited,
        }),
    };

    await expect(runGmailSendWorkflow(
      workflowInput,
      activities,
      { maxAttempts: 3, wait },
    )).resolves.toEqual({
      outcome: "failed_final",
      errorCode: gmailSendFailureCodes.rateLimited,
    });
    expect(activities.dispatchAttempt).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 30_000);
    expect(activities.settleAttempt).toHaveBeenNthCalledWith(3, {
      context: {
        organizationId: workflowInput.organizationId,
        workspaceId: workflowInput.workspaceId,
        websiteProjectId: workflowInput.websiteProjectId,
        gmailConnectionId: workflowInput.gmailConnectionId,
        actorId: workflowInput.actorId,
      },
      attempt: attempt(3),
      settlement: {
        status: "FAILED_FINAL",
        errorCode: gmailSendFailureCodes.rateLimited,
      },
    });
  });

  it("returns an in-flight Attempt for reconciliation without calling Gmail", async () => {
    const activities: SendWorkflowActivities = {
      claimAttempt: vi.fn().mockResolvedValue({
        state: "reconciliation_required",
        attemptId: attempt(1).attemptId,
        rfcMessageId: attempt(1).rfcMessageId,
        status: "DISPATCHING",
      }),
      dispatchAttempt: vi.fn(),
      settleAttempt: vi.fn(),
    };

    await expect(runGmailSendWorkflow(workflowInput, activities))
      .resolves.toEqual({
        outcome: "reconciliation_required",
        attemptId: attempt(1).attemptId,
        rfcMessageId: attempt(1).rfcMessageId,
        errorCode: null,
      });
    expect(activities.dispatchAttempt).not.toHaveBeenCalled();
    expect(activities.settleAttempt).not.toHaveBeenCalled();
  });
});
