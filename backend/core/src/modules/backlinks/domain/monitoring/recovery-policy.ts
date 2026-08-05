import type {
  PlacementMonitoringHealthStatus,
} from "./schedule-policy.js";
import type {
  PlacementMonitoringStatusDecision,
  PlacementMonitoringStatusResult,
} from "./status-policy.js";

export type PlacementMonitoringRecoveryProjection = Readonly<{
  eventType: "placement.recovered" | "placement.restored";
  nextHealthStatus: "active";
  reasonCode: "PLACEMENT_RECOVERED" | "PLACEMENT_RESTORED";
  kpiProjection: Readonly<{
    countsTowardKpi: true;
    recoveredPlacementCount: 0 | 1;
    restoredPlacementCount: 0 | 1;
  }>;
}>;

export type PlacementMonitoringRecoveryInput = Readonly<{
  currentHealthStatus: PlacementMonitoringHealthStatus;
  currentObservationResult: PlacementMonitoringStatusResult;
  statusDecision: PlacementMonitoringStatusDecision;
}>;

export function decidePlacementMonitoringRecovery(
  input: PlacementMonitoringRecoveryInput,
): PlacementMonitoringRecoveryProjection | null {
  if (
    input.statusDecision.reasonCode !== "RECOVERY_EVENT_REQUIRED"
    || input.currentObservationResult !== "present"
  ) {
    return null;
  }

  if (
    input.currentHealthStatus === "lost"
    && input.statusDecision.nextHealthStatus === "lost"
  ) {
    return Object.freeze({
      eventType: "placement.recovered",
      nextHealthStatus: "active",
      reasonCode: "PLACEMENT_RECOVERED",
      kpiProjection: {
        countsTowardKpi: true as const,
        recoveredPlacementCount: 1 as const,
        restoredPlacementCount: 0 as const,
      },
    });
  }

  if (
    input.currentHealthStatus === "changed"
    && input.statusDecision.nextHealthStatus === "changed"
  ) {
    return Object.freeze({
      eventType: "placement.restored",
      nextHealthStatus: "active",
      reasonCode: "PLACEMENT_RESTORED",
      kpiProjection: {
        countsTowardKpi: true as const,
        recoveredPlacementCount: 0 as const,
        restoredPlacementCount: 1 as const,
      },
    });
  }

  return null;
}
