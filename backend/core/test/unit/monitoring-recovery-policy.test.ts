import { describe, expect, it } from "vitest";

import {
  decidePlacementMonitoringRecovery,
} from "../../src/modules/backlinks/domain/monitoring/recovery-policy.js";
import type {
  PlacementMonitoringStatusDecision,
} from "../../src/modules/backlinks/domain/monitoring/status-policy.js";

const recoveryRequired: PlacementMonitoringStatusDecision = {
  policyVersion: "placement-monitoring-status.v1",
  nextHealthStatus: "lost",
  confirmationType: null,
  matchingEvidenceCount: 0,
  requiredConfirmationCount: null,
  reasonCode: "RECOVERY_EVENT_REQUIRED",
  shouldRecheckSoon: false,
};

describe("BL-AI-154 Placement monitoring recovery policy", () => {
  it("projects Lost plus healthy evidence to active with a recovered KPI fact", () => {
    expect(decidePlacementMonitoringRecovery({
      currentHealthStatus: "lost",
      currentObservationResult: "present",
      statusDecision: recoveryRequired,
    })).toEqual({
      eventType: "placement.recovered",
      nextHealthStatus: "active",
      reasonCode: "PLACEMENT_RECOVERED",
      kpiProjection: {
        countsTowardKpi: true,
        recoveredPlacementCount: 1,
        restoredPlacementCount: 0,
      },
    });
  });

  it("projects Changed plus healthy evidence to active with a restored KPI fact", () => {
    expect(decidePlacementMonitoringRecovery({
      currentHealthStatus: "changed",
      currentObservationResult: "present",
      statusDecision: {
        ...recoveryRequired,
        nextHealthStatus: "changed",
      },
    })).toEqual({
      eventType: "placement.restored",
      nextHealthStatus: "active",
      reasonCode: "PLACEMENT_RESTORED",
      kpiProjection: {
        countsTowardKpi: true,
        recoveredPlacementCount: 0,
        restoredPlacementCount: 1,
      },
    });
  });

  it("does not replace Lost history with changed evidence", () => {
    expect(decidePlacementMonitoringRecovery({
      currentHealthStatus: "lost",
      currentObservationResult: "changed",
      statusDecision: recoveryRequired,
    })).toBeNull();
  });
});
