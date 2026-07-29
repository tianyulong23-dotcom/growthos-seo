import { describe, expect, it, vi } from "vitest";

import {
  createPlacementTemporalActivities,
} from "../../src/modules/backlinks/workflows/placement.activities.js";

const scope = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
} as const;

describe("Placement Temporal activities", () => {
  it("delegates validation and monitoring to the existing Placement implementations", async () => {
    const validationRepository = {
      getCandidate: vi.fn(async () => ({ state: "not_found" as const })),
      record: vi.fn(),
    };
    const monitorRepository = {
      prepare: vi.fn(async () => ({ state: "not_eligible" as const })),
    };
    const staticMonitorActivity = { execute: vi.fn() };
    const activities = createPlacementTemporalActivities({
      validationRepository: validationRepository as never,
      safeFetch: { fetch: vi.fn() } as never,
      monitorRepository: monitorRepository as never,
      staticMonitorActivity: staticMonitorActivity as never,
    });

    await expect(activities.backlinksRunPlacementInitialValidationV1({
      ...scope,
      candidateId: "candidate-1",
      validationRunId: "validation-1",
      placementId: "placement-1",
      monitoringOutboxEventId: "outbox-1",
      placementLifecycleEventId: "placement-lifecycle-1",
      auditEventId: "audit-1",
      actorId: "temporal-worker",
      recordedAt: new Date("2026-07-29T10:00:00.000Z"),
    })).resolves.toEqual({
      outcome: "not_found",
      candidateId: "candidate-1",
    });

    await expect(activities.backlinksRunPlacementMonitoringV1({
      ...scope,
      placementId: "placement-1",
      monitorPolicyId: "policy-1",
      policyVersion: "placement-monitoring-v1",
      scheduledFor: new Date("2026-07-29T10:00:00.000Z"),
      runId: "run-1",
      observationId: "observation-1",
      workerId: "temporal-worker",
      now: new Date("2026-07-29T10:00:00.000Z"),
    })).resolves.toEqual({
      outcome: "not_eligible",
      placementId: "placement-1",
    });

    expect(staticMonitorActivity.execute).not.toHaveBeenCalled();
  });
});
