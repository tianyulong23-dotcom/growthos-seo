import { describe, expect, it, vi } from "vitest";

import type {
  PlacementStaticMonitorActivity,
  PlacementStaticMonitorActivityResult,
} from "../../src/modules/backlinks/application/activities/placement-static-monitor.activity.js";
import type {
  PlacementMonitorExecution,
  PlacementMonitorRepository,
  PlacementMonitorRunRecord,
} from "../../src/modules/backlinks/application/repositories/placement-monitor.repository.js";
import {
  calculateMonitoringRetryDelaySeconds,
  runPlacementMonitorWorkflow,
  type PlacementMonitorWorkflowInput,
} from "../../src/modules/backlinks/application/workflows/placement-monitor.workflow.js";

const input: PlacementMonitorWorkflowInput = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  placementId: "placement-1",
  monitorPolicyId: "policy-1",
  policyVersion: "placement-monitoring-v1",
  scheduledFor: new Date("2026-07-28T09:00:00.000Z"),
  runId: "run-1",
  observationId: "observation-1",
  workerId: "monitor-worker-1",
  now: new Date("2026-07-28T09:00:05.000Z"),
};

const execution: PlacementMonitorExecution = {
  runId: input.runId,
  placementId: input.placementId,
  monitorPolicyId: input.monitorPolicyId,
  policyVersion: input.policyVersion,
  scheduledFor: input.scheduledFor,
  executionMode: "static",
  attemptCount: 1,
  sourcePageUrl: "https://publisher.example/article",
  targetUrl: "https://owner.example/guide",
  healthStatus: "active",
  placementVersion: 1,
  normalIntervalSeconds: 86_400,
  suspectedRecheckIntervalSeconds: 3_600,
  jitterWindowSeconds: 3_600,
  retryInitialDelaySeconds: 60,
  retryMaxDelaySeconds: 3_600,
  retryBackoffMultiplier: 2,
  maxRetryAttempts: 3,
  lossConfirmationCount: 2,
  changeConfirmationCount: 2,
  recentSamePolicyObservations: [],
  previousSuccessfulObservation: null,
};

function observation(
  overrides: Partial<PlacementStaticMonitorActivityResult> = {},
): PlacementStaticMonitorActivityResult {
  return {
    result: "present",
    failureCode: null,
    retryable: false,
    evidenceSnapshot: {
      contractVersion: "placement.monitor-observation.v1",
      schemaVersion: 1,
    },
    evidenceSnapshotHash: "a".repeat(64),
    evidenceFingerprint: "b".repeat(64),
    evidenceContractVersion: "placement.monitor-observation.v1",
    evidenceSchemaVersion: 1,
    observedAt: new Date("2026-07-28T09:00:04.000Z"),
    ...overrides,
  };
}

function runRecord(
  overrides: Partial<PlacementMonitorRunRecord> = {},
): PlacementMonitorRunRecord {
  return {
    runId: input.runId,
    status: "SUCCEEDED",
    attemptCount: 1,
    nextRetryAt: null,
    retryAfterSeconds: null,
    errorCode: null,
    observationResult: "present",
    ...overrides,
  };
}

function repository(
  prepared: Awaited<ReturnType<PlacementMonitorRepository["prepare"]>>,
) {
  const value: PlacementMonitorRepository = {
    prepare: vi.fn(async () => prepared),
    scheduleRetry: vi.fn(async (retryInput) => runRecord({
      status: "RETRY_WAIT",
      attemptCount: retryInput.expectedAttemptCount,
      nextRetryAt: retryInput.nextRetryAt,
      retryAfterSeconds: retryInput.retryAfterSeconds,
      errorCode: retryInput.errorCode,
      observationResult: null,
    })),
    complete: vi.fn(async (completeInput) => runRecord({
      status: completeInput.terminalStatus,
      attemptCount: completeInput.expectedAttemptCount,
      errorCode: completeInput.terminalStatus === "FAILED"
        ? completeInput.observation.failureCode
        : null,
      observationResult: completeInput.observation.result,
    })),
  };
  return value;
}

function activity(
  result: PlacementStaticMonitorActivityResult,
): PlacementStaticMonitorActivity {
  return { execute: vi.fn(async () => result) };
}

describe("BL-AI-152 Placement Monitor Workflow", () => {
  it("persists one static observation and advances the next schedule", async () => {
    const store = repository({ state: "ready", execution });
    const worker = activity(observation());

    const result = await runPlacementMonitorWorkflow(
      input,
      store,
      worker,
    );

    expect(worker.execute).toHaveBeenCalledWith({
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      sourcePageUrl: execution.sourcePageUrl,
      targetUrl: execution.targetUrl,
      previousSuccessfulObservation: null,
    });
    expect(store.complete).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      terminalStatus: "SUCCEEDED",
      expectedAttemptCount: 1,
      observationId: input.observationId,
      decisionFactId: expect.any(String),
      lossConfirmationCount: execution.lossConfirmationCount,
      changeConfirmationCount: execution.changeConfirmationCount,
      nextCheckAt: expect.any(Date),
    }));
    expect(result).toMatchObject({
      outcome: "completed",
      status: "SUCCEEDED",
      result: "present",
    });
  });

  it("replays a terminal run without another external fetch", async () => {
    const store = repository({
      state: "completed",
      run: runRecord(),
    });
    const worker = activity(observation());

    const result = await runPlacementMonitorWorkflow(
      input,
      store,
      worker,
    );

    expect(result).toMatchObject({
      outcome: "already_completed",
      status: "SUCCEEDED",
      result: "present",
    });
    expect(worker.execute).not.toHaveBeenCalled();
    expect(store.scheduleRetry).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      failureCode: "SAFE_FETCH_TIMEOUT",
      result: observation({
        result: "inaccessible",
        failureCode: "SAFE_FETCH_TIMEOUT",
        retryable: true,
      }),
    },
    {
      failureCode: "HTTP_429",
      result: observation({
        result: "inaccessible",
        failureCode: "HTTP_429",
        retryable: true,
      }),
    },
  ])("backs off a retryable $failureCode without writing an Observation", async ({
    result: activityResult,
  }) => {
    const store = repository({ state: "ready", execution });

    const result = await runPlacementMonitorWorkflow(
      input,
      store,
      activity(activityResult),
    );

    expect(store.scheduleRetry).toHaveBeenCalledOnce();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAttemptCount: 1,
        errorCode: activityResult.failureCode,
        retryAfterSeconds: expect.any(Number),
        nextRetryAt: expect.any(Date),
      }),
    );
    expect(result).toMatchObject({
      outcome: "retry_scheduled",
      status: "RETRY_WAIT",
      attemptCount: 1,
      errorCode: activityResult.failureCode,
    });
  });

  it("records inaccessible only after the retry budget is exhausted", async () => {
    const exhausted = {
      ...execution,
      attemptCount: 4,
    };
    const store = repository({ state: "ready", execution: exhausted });

    const result = await runPlacementMonitorWorkflow(
      input,
      store,
      activity(observation({
        result: "inaccessible",
        failureCode: "SAFE_FETCH_TIMEOUT",
        retryable: true,
      })),
    );

    expect(store.scheduleRetry).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      terminalStatus: "FAILED",
      expectedAttemptCount: 4,
      observation: expect.objectContaining({
        result: "inaccessible",
        failureCode: "SAFE_FETCH_TIMEOUT",
      }),
    }));
    expect(result).toMatchObject({
      outcome: "completed",
      status: "FAILED",
      result: "inaccessible",
    });
  });

  it("appends a recovery projection instead of overwriting Lost history", async () => {
    const recovered = {
      ...execution,
      healthStatus: "lost" as const,
      placementVersion: 7,
    };
    const store = repository({ state: "ready", execution: recovered });

    await runPlacementMonitorWorkflow(
      input,
      store,
      activity(observation()),
    );

    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      expectedPlacementVersion: 7,
      expectedHealthStatus: "lost",
      statusDecision: expect.objectContaining({
        reasonCode: "RECOVERY_EVENT_REQUIRED",
      }),
      recoveryProjection: expect.objectContaining({
        eventType: "placement.recovered",
        nextHealthStatus: "active",
        kpiProjection: {
          countsTowardKpi: true,
          recoveredPlacementCount: 1,
          restoredPlacementCount: 0,
        },
      }),
    }));
  });

  it.each([
    {
      name: "confirmed",
      currentHealthStatus: "suspected_changed" as const,
      activityResult: observation({ result: "present" }),
      recentSamePolicyObservations: [],
      eventType: "placement.confirmed",
      nextHealthStatus: "active",
    },
    {
      name: "changed",
      currentHealthStatus: "active" as const,
      activityResult: observation({ result: "changed" }),
      recentSamePolicyObservations: [{
        result: "changed" as const,
        evidenceFingerprint: "b".repeat(64),
        observedAt: new Date("2026-07-28T08:00:00.000Z"),
      }],
      eventType: "placement.changed",
      nextHealthStatus: "changed",
    },
    {
      name: "lost",
      currentHealthStatus: "active" as const,
      activityResult: observation({ result: "absent" }),
      recentSamePolicyObservations: [{
        result: "absent" as const,
        evidenceFingerprint: "b".repeat(64),
        observedAt: new Date("2026-07-28T08:00:00.000Z"),
      }],
      eventType: "placement.lost",
      nextHealthStatus: "lost",
    },
  ])("appends a real placement.$name Lifecycle fact", async ({
    currentHealthStatus,
    activityResult,
    recentSamePolicyObservations,
    eventType,
    nextHealthStatus,
  }) => {
    const store = repository({
      state: "ready",
      execution: {
        ...execution,
        healthStatus: currentHealthStatus,
        recentSamePolicyObservations,
      },
    });

    await runPlacementMonitorWorkflow(
      input,
      store,
      activity(activityResult),
    );

    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      recoveryProjection: expect.objectContaining({
        eventType,
        nextHealthStatus,
        kpiProjection: null,
        lifecycleEventId: expect.any(String),
        outboxEventId: null,
      }),
    }));
  });

  it("uses replay-stable bounded exponential backoff with jitter", () => {
    const first = calculateMonitoringRetryDelaySeconds({
      runId: input.runId,
      attemptCount: 1,
      retryInitialDelaySeconds: 60,
      retryMaxDelaySeconds: 3_600,
      retryBackoffMultiplier: 2,
    });
    const second = calculateMonitoringRetryDelaySeconds({
      runId: input.runId,
      attemptCount: 2,
      retryInitialDelaySeconds: 60,
      retryMaxDelaySeconds: 3_600,
      retryBackoffMultiplier: 2,
    });

    expect(first).toBe(calculateMonitoringRetryDelaySeconds({
      runId: input.runId,
      attemptCount: 1,
      retryInitialDelaySeconds: 60,
      retryMaxDelaySeconds: 3_600,
      retryBackoffMultiplier: 2,
    }));
    expect(first).toBeGreaterThanOrEqual(60);
    expect(second).toBeGreaterThanOrEqual(120);
    expect(second).toBeLessThanOrEqual(3_600);
  });
});
