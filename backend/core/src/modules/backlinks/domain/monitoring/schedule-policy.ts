export const monitoringScheduleAlgorithmVersion =
  "placement-monitoring-schedule.v1";

export const placementMonitoringHealthStatuses = [
  "pending_verification",
  "active",
  "suspected_changed",
  "changed",
  "suspected_lost",
  "lost",
] as const;
export type PlacementMonitoringHealthStatus =
  (typeof placementMonitoringHealthStatuses)[number];

export type MonitoringSchedulePolicyInput = Readonly<{
  placementId: string;
  policyVersion: string;
  healthStatus: PlacementMonitoringHealthStatus;
  baseAt: Date;
  normalIntervalSeconds: number;
  suspectedRecheckIntervalSeconds: number;
  jitterWindowSeconds: number;
}>;

export type MonitoringSchedule = Readonly<{
  algorithmVersion: typeof monitoringScheduleAlgorithmVersion;
  scheduleClass: "normal" | "suspected_recheck";
  intervalSeconds: number;
  jitterSeconds: number;
  nextCheckAt: Date;
}>;

function requireInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the supported policy bounds`);
  }
}

function deterministicHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function calculateNextMonitoringSchedule(
  input: MonitoringSchedulePolicyInput,
): MonitoringSchedule {
  if (input.placementId.trim().length === 0) {
    throw new TypeError("placementId is required");
  }
  if (input.policyVersion.trim().length === 0) {
    throw new TypeError("policyVersion is required");
  }
  if (
    !placementMonitoringHealthStatuses.includes(input.healthStatus) ||
    !Number.isFinite(input.baseAt.getTime())
  ) {
    throw new TypeError("healthStatus and baseAt must be valid");
  }

  requireInteger(
    "normalIntervalSeconds",
    input.normalIntervalSeconds,
    300,
    2_592_000,
  );
  requireInteger(
    "suspectedRecheckIntervalSeconds",
    input.suspectedRecheckIntervalSeconds,
    60,
    input.normalIntervalSeconds,
  );
  requireInteger(
    "jitterWindowSeconds",
    input.jitterWindowSeconds,
    0,
    input.normalIntervalSeconds,
  );

  const suspected = input.healthStatus === "suspected_changed" ||
    input.healthStatus === "suspected_lost";
  const intervalSeconds = suspected
    ? input.suspectedRecheckIntervalSeconds
    : input.normalIntervalSeconds;
  const effectiveJitterWindow = Math.min(
    input.jitterWindowSeconds,
    intervalSeconds,
  );
  const seed = [
    monitoringScheduleAlgorithmVersion,
    input.placementId,
    input.policyVersion,
    input.healthStatus,
    input.baseAt.toISOString(),
  ].join("\u001f");
  const jitterSeconds = effectiveJitterWindow === 0
    ? 0
    : deterministicHash(seed) % (effectiveJitterWindow + 1);

  return Object.freeze({
    algorithmVersion: monitoringScheduleAlgorithmVersion,
    scheduleClass: suspected ? "suspected_recheck" : "normal",
    intervalSeconds,
    jitterSeconds,
    nextCheckAt: new Date(
      input.baseAt.getTime() + (intervalSeconds + jitterSeconds) * 1_000,
    ),
  });
}
