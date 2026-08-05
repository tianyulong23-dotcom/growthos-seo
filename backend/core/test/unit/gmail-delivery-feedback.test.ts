import { describe, expect, it, vi } from "vitest";

import {
  recordDeliveryFeedback,
  releaseEmailSuppression,
  type DeliveryFeedbackRepository,
} from "../../src/modules/backlinks/application/commands/delivery-feedback.command.js";
import {
  SuppressionReleaseError,
  deliveryFeedbackKinds,
  evaluateDeliveryFeedbackPolicy,
  suppressionReleaseActorRoles,
} from "../../src/modules/backlinks/domain/sending/delivery-feedback.js";

const context = {
  organizationId: "organization-120",
  workspaceId: "workspace-120",
  websiteProjectId: "project-120",
};

const target = {
  targetType: "EMAIL" as const,
  targetHmac: "a".repeat(64),
  hashKeyVersion: 1,
};

describe("BL-AI-120 delivery feedback suppression policy", () => {
  it("suppresses hard bounces, complaints, and unsubscribes immediately", () => {
    for (const kind of [
      deliveryFeedbackKinds.hardBounce,
      deliveryFeedbackKinds.complaint,
      deliveryFeedbackKinds.unsubscribe,
    ]) {
      expect(evaluateDeliveryFeedbackPolicy({
        kind,
        softBounceCount: 0,
      })).toMatchObject({ action: "SUPPRESS" });
    }
  });

  it("thresholds soft bounces over a fixed 30-day window", () => {
    expect(evaluateDeliveryFeedbackPolicy({
      kind: deliveryFeedbackKinds.softBounce,
      softBounceCount: 2,
    })).toEqual({
      action: "RECORD_ONLY",
      softBounceThreshold: 3,
      softBounceWindowDays: 30,
    });
    expect(evaluateDeliveryFeedbackPolicy({
      kind: deliveryFeedbackKinds.softBounce,
      softBounceCount: 3,
    })).toEqual({
      action: "SUPPRESS",
      reason: "SOFT_BOUNCE_THRESHOLD",
      softBounceThreshold: 3,
      softBounceWindowDays: 30,
    });
  });

  it("delegates the opaque feedback command without a plaintext email", async () => {
    const record = vi.fn(async () => ({
      feedbackId: "feedback-120",
      action: "SUPPRESS" as const,
      suppressionReason: "HARD_BOUNCE" as const,
    }));
    const repository: DeliveryFeedbackRepository = {
      record,
      release: vi.fn(),
    };
    const input = {
      ...context,
      target,
      feedbackId: "provider-event-120",
      kind: deliveryFeedbackKinds.hardBounce,
      observedAt: new Date("2026-07-28T08:00:00.000Z"),
      recordedAt: new Date("2026-07-28T08:01:00.000Z"),
      actorId: "worker-120",
    };

    await expect(
      recordDeliveryFeedback(repository, input),
    ).resolves.toEqual({
      feedbackId: "feedback-120",
      action: "SUPPRESS",
      suppressionReason: "HARD_BOUNCE",
    });
    expect(repository.record).toHaveBeenCalledWith(input);
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      "person@example.test",
    );
  });

  it("never delegates an ordinary-user release of an unsubscribe", async () => {
    const repository: DeliveryFeedbackRepository = {
      record: vi.fn(),
      release: vi.fn(),
    };

    await expect(releaseEmailSuppression(repository, {
      ...context,
      suppressionId: "suppression-120",
      suppressionReason: "UNSUBSCRIBE",
      actorRole: suppressionReleaseActorRoles.ordinaryUser,
      releaseReason: "mistakenly requested",
      releasedAt: new Date("2026-07-28T08:02:00.000Z"),
      actorId: "user-120",
    })).rejects.toMatchObject({
      code: "SUPPRESSION_UNSUBSCRIBE_RELEASE_FORBIDDEN",
    } satisfies Partial<SuppressionReleaseError>);
    expect(repository.release).not.toHaveBeenCalled();
  });

  it("allows only a compliance administrator to delegate an unsubscribe release", async () => {
    const repository: DeliveryFeedbackRepository = {
      record: vi.fn(),
      release: vi.fn(async () => ({
        suppressionId: "suppression-120",
        reason: "UNSUBSCRIBE",
        status: "RELEASED",
        version: 2,
      })),
    };
    const input = {
      ...context,
      suppressionId: "suppression-120",
      suppressionReason: "UNSUBSCRIBE" as const,
      actorRole: suppressionReleaseActorRoles.complianceAdministrator,
      releaseReason: "verified consent repair",
      releasedAt: new Date("2026-07-28T08:03:00.000Z"),
      actorId: "compliance-120",
    };

    await expect(
      releaseEmailSuppression(repository, input),
    ).resolves.toEqual({
      suppressionId: "suppression-120",
      reason: "UNSUBSCRIBE",
      status: "RELEASED",
      version: 2,
    });
    expect(repository.release).toHaveBeenCalledWith(input);
  });
});
