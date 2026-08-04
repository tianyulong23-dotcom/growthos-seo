import {
  placementMonitoringHealthStatuses,
  type PlacementMonitoringHealthStatus,
} from "./schedule-policy.js";

export const placementMonitoringStatusPolicyVersion =
  "placement-monitoring-status.v1";

export const placementMonitoringStatusDecisionFactEventType =
  "placement.monitoring.status_decided";

export const placementMonitoringStatusDecisionFactContractVersion =
  "placement.monitoring.status-decision.v1";

export const placementMonitoringStatusResults = [
  "present",
  "changed",
  "absent",
  "inaccessible",
] as const;
export type PlacementMonitoringStatusResult =
  (typeof placementMonitoringStatusResults)[number];

export type PlacementMonitoringStatusEvidence = Readonly<{
  result: PlacementMonitoringStatusResult;
  evidenceFingerprint: string;
  observedAt: Date;
}>;

export type PlacementMonitoringStatusPolicyInput = Readonly<{
  currentHealthStatus: PlacementMonitoringHealthStatus;
  currentObservation: PlacementMonitoringStatusEvidence;
  recentSamePolicyObservations:
    readonly PlacementMonitoringStatusEvidence[];
  lossConfirmationCount: number;
  changeConfirmationCount: number;
}>;

export type PlacementMonitoringStatusDecision = Readonly<{
  policyVersion: typeof placementMonitoringStatusPolicyVersion;
  nextHealthStatus: PlacementMonitoringHealthStatus;
  confirmationType: "changed" | "lost" | null;
  matchingEvidenceCount: number;
  requiredConfirmationCount: number | null;
  reasonCode:
    | "PLACEMENT_PRESENT"
    | "RECOVERY_EVENT_REQUIRED"
    | "INACCESSIBLE_PRESERVES_STATUS"
    | "CHANGE_REQUIRES_CONFIRMATION"
    | "CHANGE_CONFIRMED"
    | "LOSS_REQUIRES_CONFIRMATION"
    | "LOSS_CONFIRMED";
  shouldRecheckSoon: boolean;
}>;

function requireConfirmationCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 2 || value > 10) {
    throw new TypeError(`${name} is outside the supported policy bounds`);
  }
}

function requireEvidence(
  name: string,
  evidence: PlacementMonitoringStatusEvidence,
): void {
  if (!placementMonitoringStatusResults.includes(evidence.result)) {
    throw new TypeError(`${name}.result is invalid`);
  }
  if (evidence.evidenceFingerprint.trim().length === 0) {
    throw new TypeError(`${name}.evidenceFingerprint is required`);
  }
  if (!Number.isFinite(evidence.observedAt.getTime())) {
    throw new TypeError(`${name}.observedAt is invalid`);
  }
}

function validateInput(input: PlacementMonitoringStatusPolicyInput): void {
  if (
    !placementMonitoringHealthStatuses.includes(input.currentHealthStatus)
  ) {
    throw new TypeError("currentHealthStatus is invalid");
  }
  requireConfirmationCount(
    "lossConfirmationCount",
    input.lossConfirmationCount,
  );
  requireConfirmationCount(
    "changeConfirmationCount",
    input.changeConfirmationCount,
  );
  requireEvidence("currentObservation", input.currentObservation);

  let newerObservedAt = input.currentObservation.observedAt.getTime();
  for (
    const [index, observation]
      of input.recentSamePolicyObservations.entries()
  ) {
    requireEvidence(`recentSamePolicyObservations[${index}]`, observation);
    const observedAt = observation.observedAt.getTime();
    if (observedAt >= newerObservedAt) {
      throw new TypeError(
        "recentSamePolicyObservations must be strictly newest-first",
      );
    }
    newerObservedAt = observedAt;
  }
}

function countMatchingDeterministicEvidence(
  current: PlacementMonitoringStatusEvidence,
  recent: readonly PlacementMonitoringStatusEvidence[],
): number {
  let count = 1;
  for (const observation of recent) {
    if (observation.result === "inaccessible") continue;
    if (
      observation.result !== current.result
      || observation.evidenceFingerprint !== current.evidenceFingerprint
    ) {
      break;
    }
    count += 1;
  }
  return count;
}

function noConfirmationDecision(
  nextHealthStatus: PlacementMonitoringHealthStatus,
  reasonCode:
    | "PLACEMENT_PRESENT"
    | "RECOVERY_EVENT_REQUIRED"
    | "INACCESSIBLE_PRESERVES_STATUS",
  shouldRecheckSoon: boolean,
): PlacementMonitoringStatusDecision {
  return Object.freeze({
    policyVersion: placementMonitoringStatusPolicyVersion,
    nextHealthStatus,
    confirmationType: null,
    matchingEvidenceCount: 0,
    requiredConfirmationCount: null,
    reasonCode,
    shouldRecheckSoon,
  });
}

export function decidePlacementMonitoringStatus(
  input: PlacementMonitoringStatusPolicyInput,
): PlacementMonitoringStatusDecision {
  validateInput(input);

  if (input.currentObservation.result === "inaccessible") {
    return noConfirmationDecision(
      input.currentHealthStatus,
      "INACCESSIBLE_PRESERVES_STATUS",
      true,
    );
  }

  if (input.currentObservation.result === "present") {
    if (
      input.currentHealthStatus === "changed"
      || input.currentHealthStatus === "lost"
    ) {
      return noConfirmationDecision(
        input.currentHealthStatus,
        "RECOVERY_EVENT_REQUIRED",
        false,
      );
    }
    return noConfirmationDecision("active", "PLACEMENT_PRESENT", false);
  }

  if (
    input.currentHealthStatus === "lost"
    && input.currentObservation.result === "changed"
  ) {
    return noConfirmationDecision(
      "lost",
      "RECOVERY_EVENT_REQUIRED",
      false,
    );
  }

  const matchingEvidenceCount = countMatchingDeterministicEvidence(
    input.currentObservation,
    input.recentSamePolicyObservations,
  );
  const changed = input.currentObservation.result === "changed";
  const requiredConfirmationCount = changed
    ? input.changeConfirmationCount
    : input.lossConfirmationCount;
  const confirmed = matchingEvidenceCount >= requiredConfirmationCount;

  return Object.freeze({
    policyVersion: placementMonitoringStatusPolicyVersion,
    nextHealthStatus: changed
      ? confirmed ? "changed" : "suspected_changed"
      : confirmed ? "lost" : "suspected_lost",
    confirmationType: changed ? "changed" : "lost",
    matchingEvidenceCount,
    requiredConfirmationCount,
    reasonCode: changed
      ? confirmed ? "CHANGE_CONFIRMED" : "CHANGE_REQUIRES_CONFIRMATION"
      : confirmed ? "LOSS_CONFIRMED" : "LOSS_REQUIRES_CONFIRMATION",
    shouldRecheckSoon: !confirmed,
  });
}
