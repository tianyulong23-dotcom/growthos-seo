import { describe, expect, it } from "vitest";

import {
  calculateNextMonitoringSchedule,
  monitoringScheduleAlgorithmVersion,
} from "../../src/modules/backlinks/domain/monitoring/schedule-policy.js";

const placementId = "018f0000-0000-7000-8000-000000000601";
const policyVersion = "placement-monitoring-v1";
const baseAt = new Date("2026-07-27T09:00:00Z");

describe("BL-AI-151 monitoring schedule policy", () => {
  it("produces a replay-stable daily jitter for the same policy input", () => {
    const input = {
      placementId,
      policyVersion,
      healthStatus: "active" as const,
      baseAt,
      normalIntervalSeconds: 86_400,
      suspectedRecheckIntervalSeconds: 3_600,
      jitterWindowSeconds: 3_600,
    };

    const schedule = calculateNextMonitoringSchedule(input);

    expect(schedule).toEqual({
      algorithmVersion: monitoringScheduleAlgorithmVersion,
      scheduleClass: "normal",
      intervalSeconds: 86_400,
      jitterSeconds: 1_707,
      nextCheckAt: new Date("2026-07-28T09:28:27.000Z"),
    });
    expect(calculateNextMonitoringSchedule(input)).toEqual(schedule);
  });

  it("uses the bounded shorter interval for suspected states", () => {
    expect(calculateNextMonitoringSchedule({
      placementId,
      policyVersion,
      healthStatus: "suspected_lost",
      baseAt,
      normalIntervalSeconds: 86_400,
      suspectedRecheckIntervalSeconds: 3_600,
      jitterWindowSeconds: 3_600,
    })).toEqual({
      algorithmVersion: monitoringScheduleAlgorithmVersion,
      scheduleClass: "suspected_recheck",
      intervalSeconds: 3_600,
      jitterSeconds: 3_512,
      nextCheckAt: new Date("2026-07-27T10:58:32.000Z"),
    });
  });

  it("supports an exact non-jittered schedule", () => {
    expect(calculateNextMonitoringSchedule({
      placementId,
      policyVersion,
      healthStatus: "active",
      baseAt,
      normalIntervalSeconds: 86_400,
      suspectedRecheckIntervalSeconds: 3_600,
      jitterWindowSeconds: 0,
    }).nextCheckAt).toEqual(new Date("2026-07-28T09:00:00.000Z"));
  });

  it.each([
    { placementId: "", normalIntervalSeconds: 86_400 },
    { placementId, normalIntervalSeconds: 299 },
    { placementId, normalIntervalSeconds: 86_400, suspectedRecheckIntervalSeconds: 59 },
    { placementId, normalIntervalSeconds: 300, suspectedRecheckIntervalSeconds: 301 },
    { placementId, normalIntervalSeconds: 300, jitterWindowSeconds: 301 },
  ])("rejects an invalid persisted policy: %#", (override) => {
    expect(() => calculateNextMonitoringSchedule({
      placementId,
      policyVersion,
      healthStatus: "active",
      baseAt,
      normalIntervalSeconds: 86_400,
      suspectedRecheckIntervalSeconds: 3_600,
      jitterWindowSeconds: 3_600,
      ...override,
    })).toThrow(TypeError);
  });
});
