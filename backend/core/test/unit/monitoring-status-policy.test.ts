import { describe, expect, it } from "vitest";

import {
  decidePlacementMonitoringStatus,
  placementMonitoringStatusPolicyVersion,
  type PlacementMonitoringStatusEvidence,
} from "../../src/modules/backlinks/domain/monitoring/status-policy.js";

const firstObservedAt = new Date("2026-07-28T01:00:00.000Z");
const secondObservedAt = new Date("2026-07-28T02:00:00.000Z");
const thirdObservedAt = new Date("2026-07-28T03:00:00.000Z");

function evidence(
  result: PlacementMonitoringStatusEvidence["result"],
  evidenceFingerprint: string,
  observedAt: Date,
): PlacementMonitoringStatusEvidence {
  return { result, evidenceFingerprint, observedAt };
}

describe("BL-AI-153 placement monitoring status policy", () => {
  it("requires two matching absence observations before confirming lost", () => {
    const first = decidePlacementMonitoringStatus({
      currentHealthStatus: "active",
      currentObservation: evidence("absent", "missing-v1", firstObservedAt),
      recentSamePolicyObservations: [],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    });

    expect(first).toEqual({
      policyVersion: placementMonitoringStatusPolicyVersion,
      nextHealthStatus: "suspected_lost",
      confirmationType: "lost",
      matchingEvidenceCount: 1,
      requiredConfirmationCount: 2,
      reasonCode: "LOSS_REQUIRES_CONFIRMATION",
      shouldRecheckSoon: true,
    });

    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: "suspected_lost",
      currentObservation: evidence("absent", "missing-v1", secondObservedAt),
      recentSamePolicyObservations: [
        evidence("absent", "missing-v1", firstObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toMatchObject({
      nextHealthStatus: "lost",
      confirmationType: "lost",
      matchingEvidenceCount: 2,
      reasonCode: "LOSS_CONFIRMED",
      shouldRecheckSoon: false,
    });
  });

  it("requires matching structural-change evidence independently of loss", () => {
    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: "active",
      currentObservation: evidence(
        "changed",
        "nofollow-change",
        secondObservedAt,
      ),
      recentSamePolicyObservations: [
        evidence("absent", "nofollow-change", firstObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toMatchObject({
      nextHealthStatus: "suspected_changed",
      confirmationType: "changed",
      matchingEvidenceCount: 1,
      reasonCode: "CHANGE_REQUIRES_CONFIRMATION",
    });

    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: "suspected_changed",
      currentObservation: evidence(
        "changed",
        "nofollow-change",
        secondObservedAt,
      ),
      recentSamePolicyObservations: [
        evidence("changed", "nofollow-change", firstObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toMatchObject({
      nextHealthStatus: "changed",
      confirmationType: "changed",
      matchingEvidenceCount: 2,
      reasonCode: "CHANGE_CONFIRMED",
      shouldRecheckSoon: false,
    });
  });

  it("restarts confirmation when the deterministic fingerprint changes", () => {
    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: "suspected_changed",
      currentObservation: evidence(
        "changed",
        "canonical-change",
        secondObservedAt,
      ),
      recentSamePolicyObservations: [
        evidence("changed", "nofollow-change", firstObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toMatchObject({
      nextHealthStatus: "suspected_changed",
      matchingEvidenceCount: 1,
      reasonCode: "CHANGE_REQUIRES_CONFIRMATION",
    });
  });

  it("does not count or erase inaccessible checks between matching evidence", () => {
    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: "suspected_lost",
      currentObservation: evidence("absent", "missing-v1", thirdObservedAt),
      recentSamePolicyObservations: [
        evidence("inaccessible", "timeout", secondObservedAt),
        evidence("absent", "missing-v1", firstObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toMatchObject({
      nextHealthStatus: "lost",
      matchingEvidenceCount: 2,
      reasonCode: "LOSS_CONFIRMED",
    });
  });

  it.each([
    "active",
    "suspected_changed",
    "changed",
    "suspected_lost",
    "lost",
  ] as const)("keeps %s unchanged after one inaccessible result", (status) => {
    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: status,
      currentObservation: evidence(
        "inaccessible",
        "network-timeout",
        secondObservedAt,
      ),
      recentSamePolicyObservations: [
        evidence("absent", "missing-v1", firstObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toEqual({
      policyVersion: placementMonitoringStatusPolicyVersion,
      nextHealthStatus: status,
      confirmationType: null,
      matchingEvidenceCount: 0,
      requiredConfirmationCount: null,
      reasonCode: "INACCESSIBLE_PRESERVES_STATUS",
      shouldRecheckSoon: true,
    });
  });

  it("uses the versioned policy confirmation thresholds", () => {
    expect(decidePlacementMonitoringStatus({
      currentHealthStatus: "suspected_lost",
      currentObservation: evidence("absent", "missing-v1", thirdObservedAt),
      recentSamePolicyObservations: [
        evidence("absent", "missing-v1", secondObservedAt),
        evidence("absent", "missing-v1", firstObservedAt),
      ],
      lossConfirmationCount: 3,
      changeConfirmationCount: 4,
    })).toMatchObject({
      nextHealthStatus: "lost",
      matchingEvidenceCount: 3,
      requiredConfirmationCount: 3,
      reasonCode: "LOSS_CONFIRMED",
    });
  });

  it("clears suspected states on present evidence without emitting recovery", () => {
    for (
      const currentHealthStatus of [
        "pending_verification",
        "active",
        "suspected_changed",
        "suspected_lost",
      ] as const
    ) {
      expect(decidePlacementMonitoringStatus({
        currentHealthStatus,
        currentObservation: evidence(
          "present",
          "healthy-v1",
          secondObservedAt,
        ),
        recentSamePolicyObservations: [],
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
      })).toMatchObject({
        nextHealthStatus: "active",
        confirmationType: null,
        reasonCode: "PLACEMENT_PRESENT",
        shouldRecheckSoon: false,
      });
    }
  });

  it("leaves confirmed recovery and restoration for BL-AI-154", () => {
    for (
      const [currentHealthStatus, result] of [
        ["changed", "present"],
        ["lost", "present"],
        ["lost", "changed"],
      ] as const
    ) {
      expect(decidePlacementMonitoringStatus({
        currentHealthStatus,
        currentObservation: evidence(
          result,
          "healthy-v1",
          secondObservedAt,
        ),
        recentSamePolicyObservations: [],
        lossConfirmationCount: 2,
        changeConfirmationCount: 2,
      })).toMatchObject({
        nextHealthStatus: currentHealthStatus,
        confirmationType: null,
        reasonCode: "RECOVERY_EVENT_REQUIRED",
        shouldRecheckSoon: false,
      });
    }
  });

  it.each([
    { lossConfirmationCount: 1, changeConfirmationCount: 2 },
    { lossConfirmationCount: 2, changeConfirmationCount: 11 },
  ])("rejects confirmation thresholds outside persistence bounds", (policy) => {
    expect(() => decidePlacementMonitoringStatus({
      currentHealthStatus: "active",
      currentObservation: evidence("absent", "missing-v1", firstObservedAt),
      recentSamePolicyObservations: [],
      ...policy,
    })).toThrow(TypeError);
  });

  it("rejects duplicate or out-of-order observation times", () => {
    expect(() => decidePlacementMonitoringStatus({
      currentHealthStatus: "active",
      currentObservation: evidence("absent", "missing-v1", secondObservedAt),
      recentSamePolicyObservations: [
        evidence("absent", "missing-v1", secondObservedAt),
      ],
      lossConfirmationCount: 2,
      changeConfirmationCount: 2,
    })).toThrow(TypeError);
  });
});
