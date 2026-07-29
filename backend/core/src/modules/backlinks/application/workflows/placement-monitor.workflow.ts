import { randomUUID } from "node:crypto";

import type {
  PlacementStaticMonitorActivity,
} from "../activities/placement-static-monitor.activity.js";
import type {
  PlacementMonitorRepository,
  PlacementMonitorRunRecord,
} from "../repositories/placement-monitor.repository.js";
import {
  calculateNextMonitoringSchedule,
} from "../../domain/monitoring/schedule-policy.js";
import {
  decidePlacementMonitoringStatus,
} from "../../domain/monitoring/status-policy.js";
import {
  decidePlacementMonitoringRecovery,
} from "../../domain/monitoring/recovery-policy.js";

export const placementMonitorWorkflowVersion =
  "placement-monitor-workflow.static.v1";

export type PlacementMonitorWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  placementId: string;
  monitorPolicyId: string;
  policyVersion: string;
  scheduledFor: Date;
  runId: string;
  observationId: string;
  workerId: string;
  now: Date;
}>;

export type MonitoringRetryDelayInput = Readonly<{
  runId: string;
  attemptCount: number;
  retryInitialDelaySeconds: number;
  retryMaxDelaySeconds: number;
  retryBackoffMultiplier: number;
}>;

function deterministicHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function requireRetryInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the supported retry bounds.`);
  }
}

export function calculateMonitoringRetryDelaySeconds(
  input: MonitoringRetryDelayInput,
): number {
  if (input.runId.trim().length === 0) {
    throw new TypeError("runId is required.");
  }
  requireRetryInteger("attemptCount", input.attemptCount, 1, 11);
  requireRetryInteger(
    "retryInitialDelaySeconds",
    input.retryInitialDelaySeconds,
    1,
    86_400,
  );
  requireRetryInteger(
    "retryMaxDelaySeconds",
    input.retryMaxDelaySeconds,
    input.retryInitialDelaySeconds,
    86_400,
  );
  requireRetryInteger(
    "retryBackoffMultiplier",
    input.retryBackoffMultiplier,
    2,
    10,
  );

  let exponentialDelay = input.retryInitialDelaySeconds;
  for (let attempt = 1; attempt < input.attemptCount; attempt += 1) {
    exponentialDelay = Math.min(
      input.retryMaxDelaySeconds,
      exponentialDelay * input.retryBackoffMultiplier,
    );
  }
  const jitterWindow = Math.min(
    Math.floor(exponentialDelay / 4),
    input.retryMaxDelaySeconds - exponentialDelay,
  );
  const jitterSeconds = jitterWindow === 0
    ? 0
    : deterministicHash([
        placementMonitorWorkflowVersion,
        input.runId,
        String(input.attemptCount),
      ].join("\u001f")) % (jitterWindow + 1);
  return exponentialDelay + jitterSeconds;
}

function completedResult(
  outcome: "completed" | "already_completed",
  run: PlacementMonitorRunRecord,
) {
  return {
    outcome,
    runId: run.runId,
    status: run.status,
    attemptCount: run.attemptCount,
    result: run.observationResult,
    errorCode: run.errorCode,
  } as const;
}

export async function runPlacementMonitorWorkflow(
  input: PlacementMonitorWorkflowInput,
  repository: PlacementMonitorRepository,
  activity: PlacementStaticMonitorActivity,
) {
  const prepared = await repository.prepare({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    placementId: input.placementId,
    monitorPolicyId: input.monitorPolicyId,
    policyVersion: input.policyVersion,
    scheduledFor: input.scheduledFor,
    runId: input.runId,
    workerId: input.workerId,
    now: input.now,
  });
  if (prepared.state === "not_eligible") {
    return {
      outcome: "not_eligible" as const,
      placementId: input.placementId,
    };
  }
  if (prepared.state === "completed") {
    return completedResult("already_completed", prepared.run);
  }
  if (prepared.state === "retry_wait") {
    return {
      outcome: "retry_wait" as const,
      ...prepared.run,
    };
  }
  if (prepared.state === "in_progress") {
    return {
      outcome: "in_progress" as const,
      ...prepared.run,
    };
  }

  const execution = prepared.execution;
  const observation = await activity.execute({
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    sourcePageUrl: execution.sourcePageUrl,
    targetUrl: execution.targetUrl,
    previousSuccessfulObservation:
      execution.previousSuccessfulObservation,
  });
  if (
    observation.result === "inaccessible"
    && observation.retryable
    && execution.attemptCount <= execution.maxRetryAttempts
  ) {
    if (observation.failureCode === null) {
      throw new Error("Retryable monitoring evidence requires an error code.");
    }
    const retryAfterSeconds = calculateMonitoringRetryDelaySeconds({
      runId: execution.runId,
      attemptCount: execution.attemptCount,
      retryInitialDelaySeconds: execution.retryInitialDelaySeconds,
      retryMaxDelaySeconds: execution.retryMaxDelaySeconds,
      retryBackoffMultiplier: execution.retryBackoffMultiplier,
    });
    const nextRetryAt = new Date(
      input.now.getTime() + retryAfterSeconds * 1_000,
    );
    const run = await repository.scheduleRetry({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      placementId: execution.placementId,
      monitorPolicyId: execution.monitorPolicyId,
      policyVersion: execution.policyVersion,
      scheduledFor: execution.scheduledFor,
      runId: execution.runId,
      expectedAttemptCount: execution.attemptCount,
      errorCode: observation.failureCode,
      retryAfterSeconds,
      nextRetryAt,
      workerId: input.workerId,
      recordedAt: input.now,
    });
    if (run.status !== "RETRY_WAIT") {
      return completedResult("already_completed", run);
    }
    return {
      outcome: "retry_scheduled" as const,
      ...run,
    };
  }

  const completedAt = observation.observedAt > input.now
    ? observation.observedAt
    : input.now;
  const statusDecision = decidePlacementMonitoringStatus({
    currentHealthStatus: execution.healthStatus,
    currentObservation: {
      result: observation.result,
      evidenceFingerprint: observation.evidenceFingerprint,
      observedAt: observation.observedAt,
    },
    recentSamePolicyObservations: execution.recentSamePolicyObservations,
    lossConfirmationCount: execution.lossConfirmationCount,
    changeConfirmationCount: execution.changeConfirmationCount,
  });
  const recovery = decidePlacementMonitoringRecovery({
    currentHealthStatus: execution.healthStatus,
    currentObservationResult: observation.result,
    statusDecision,
  });
  const schedule = calculateNextMonitoringSchedule({
    placementId: execution.placementId,
    policyVersion: execution.policyVersion,
    healthStatus: recovery?.nextHealthStatus
      ?? statusDecision.nextHealthStatus,
    baseAt: completedAt,
    normalIntervalSeconds: execution.normalIntervalSeconds,
    suspectedRecheckIntervalSeconds:
      execution.suspectedRecheckIntervalSeconds,
    jitterWindowSeconds: execution.jitterWindowSeconds,
  });
  const terminalStatus = observation.result === "inaccessible"
    && observation.retryable
    ? "FAILED" as const
    : "SUCCEEDED" as const;
  const nextHealthStatus = recovery?.nextHealthStatus
    ?? statusDecision.nextHealthStatus;
  const stateEventType = execution.healthStatus === nextHealthStatus
    ? null
    : nextHealthStatus === "active"
    ? "placement.confirmed" as const
    : nextHealthStatus === "changed"
    ? "placement.changed" as const
    : nextHealthStatus === "lost"
    ? "placement.lost" as const
    : null;
  const lifecycleProjection = recovery === null
    ? stateEventType === null
      ? null
      : {
          eventType: stateEventType,
          nextHealthStatus,
          reasonCode: statusDecision.reasonCode,
          kpiProjection: null,
          lifecycleEventId: randomUUID(),
          outboxEventId: null,
        }
    : {
        ...recovery,
        lifecycleEventId: randomUUID(),
        outboxEventId: randomUUID(),
      };
  const run = await repository.complete({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    placementId: execution.placementId,
    monitorPolicyId: execution.monitorPolicyId,
    policyVersion: execution.policyVersion,
    scheduledFor: execution.scheduledFor,
    runId: execution.runId,
    expectedAttemptCount: execution.attemptCount,
    observationId: input.observationId,
    expectedPlacementVersion: execution.placementVersion,
    expectedHealthStatus: execution.healthStatus,
    statusDecision,
    decisionFactId: randomUUID(),
    lossConfirmationCount: execution.lossConfirmationCount,
    changeConfirmationCount: execution.changeConfirmationCount,
    recoveryProjection: lifecycleProjection,
    observation,
    terminalStatus,
    nextCheckAt: schedule.nextCheckAt,
    workerId: input.workerId,
    completedAt,
  });
  return completedResult("completed", run);
}
