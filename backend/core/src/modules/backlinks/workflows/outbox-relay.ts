import type { BacklinkProjectAnalysisInput } from "../activities/backlink-project-analysis.activity.js";
import type {
  PlacementMonitorWorkflowInput,
} from "../application/workflows/placement-monitor.workflow.js";
import type {
  ClaimedOutboxEvent,
  createOutboxRepository,
} from "../db/repositories/outbox.repository.js";
import {
  assertBacklinksTaskQueue,
  assertBacklinksWorkflowId,
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "./namespaces.js";

export const BACKLINK_PROJECT_ANALYSIS_REQUESTED =
  "backlinks.project-analysis.requested.v1";
export const BACKLINK_PLACEMENT_MONITORING_REQUESTED =
  "backlinks.placement-monitoring.requested.v1";
export const BACKLINK_PLACEMENT_MONITORING_LIFECYCLE =
  "backlinks.placement-monitoring.lifecycle.v1";
type RelayRepository = Pick<
  ReturnType<typeof createOutboxRepository>,
  "claim" | "mark"
>;
type WorkflowStarter = Readonly<{
  start(input: BacklinkProjectAnalysisInput): Promise<unknown>;
}>;
type InitialPlacementMonitoringRequest = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  placementId: string;
  candidateId: string;
  opportunityId: string;
  initialValidationId: string;
}>;
type ReverifyPlacementMonitoringRequest = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  requestKind: "reverify";
  placementId: string;
  candidateId: string;
  opportunityId: string;
  initialValidationId: string;
  monitorRunId: string;
  monitorPolicyId: string;
  policyVersion: string;
  scheduledFor: Date;
  observationId: string;
  executionMode: "static";
  browserFallbackAllowed: false;
}>;
export type PlacementMonitoringRequest =
  | InitialPlacementMonitoringRequest
  | ReverifyPlacementMonitoringRequest;
export type PlacementMonitoringLifecycle = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  lifecycleEventId: string;
  lifecycleEventType: string;
  placementId: string;
  monitorRunId: string;
  monitorPolicyId: string;
  observationId: string;
  previousHealthStatus: string;
  healthStatus: string;
  kpiProjection: Record<string, unknown>;
}>;
type PlacementMonitoringStarter = Readonly<{
  start(input: PlacementMonitorWorkflowInput): Promise<unknown>;
}>;
type PlacementMonitoringRequestConsumer = Readonly<{
  consume(input: PlacementMonitoringRequest): Promise<unknown>;
}>;
type PlacementMonitoringLifecycleConsumer = Readonly<{
  consume(input: PlacementMonitoringLifecycle): Promise<unknown>;
}>;
type TemporalWorkflowClient = Readonly<{
  start(type: string, options: Readonly<{
    workflowId: string; taskQueue: string; args: readonly unknown[];
  }>): Promise<unknown>;
}>;

function parseInput(event: ClaimedOutboxEvent): BacklinkProjectAnalysisInput {
  const payload = event.payload as Record<string, unknown> | null;
  const strings = ["organizationId", "workspaceId", "websiteProjectId",
    "jobId", "workflowId"] as const;
  if (event.eventType !== BACKLINK_PROJECT_ANALYSIS_REQUESTED ||
      event.payloadSchemaVersion !== 1 || payload === null ||
      typeof payload !== "object" ||
      strings.some((field) => typeof payload[field] !== "string") ||
      !Number.isInteger(payload.snapshotVersion) ||
      Number(payload.snapshotVersion) < 1) {
    throw new Error("BACKLINK_ANALYSIS_OUTBOX_EVENT_INVALID");
  }
  return payload as BacklinkProjectAnalysisInput;
}

function parseObjectPayload(event: ClaimedOutboxEvent): Record<string, unknown> {
  if (
    event.payload === null
    || typeof event.payload !== "object"
    || Array.isArray(event.payload)
    || event.payloadSchemaVersion !== 1
  ) {
    throw new Error("BACKLINK_PLACEMENT_OUTBOX_EVENT_INVALID");
  }
  return event.payload as Record<string, unknown>;
}

function requirePayloadStrings(
  payload: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (fields.some((field) => typeof payload[field] !== "string")) {
    throw new Error("BACKLINK_PLACEMENT_OUTBOX_EVENT_INVALID");
  }
}

function parsePlacementMonitoringRequest(
  event: ClaimedOutboxEvent,
): PlacementMonitoringRequest {
  const payload = parseObjectPayload(event);
  if (
    event.eventType !== BACKLINK_PLACEMENT_MONITORING_REQUESTED
    || payload.contractVersion !== BACKLINK_PLACEMENT_MONITORING_REQUESTED
  ) {
    throw new Error("BACKLINK_PLACEMENT_OUTBOX_EVENT_INVALID");
  }
  requirePayloadStrings(payload, [
    "placementId",
    "candidateId",
    "opportunityId",
    "initialValidationId",
    "websiteProjectId",
  ]);
  if (payload.websiteProjectId !== event.websiteProjectId) {
    throw new Error("BACKLINK_PLACEMENT_OUTBOX_EVENT_INVALID");
  }
  if (payload.requestKind === "reverify") {
    requirePayloadStrings(payload, [
      "monitorRunId",
      "monitorPolicyId",
      "policyVersion",
      "scheduledFor",
      "observationId",
    ]);
    const scheduledFor = new Date(payload.scheduledFor as string);
    if (
      Number.isNaN(scheduledFor.getTime())
      || payload.executionMode !== "static"
      || payload.browserFallbackAllowed !== false
    ) {
      throw new Error("BACKLINK_PLACEMENT_OUTBOX_EVENT_INVALID");
    }
    return {
      organizationId: event.organizationId,
      workspaceId: event.workspaceId,
      websiteProjectId: event.websiteProjectId,
      requestKind: "reverify",
      placementId: payload.placementId as string,
      candidateId: payload.candidateId as string,
      opportunityId: payload.opportunityId as string,
      initialValidationId: payload.initialValidationId as string,
      monitorRunId: payload.monitorRunId as string,
      monitorPolicyId: payload.monitorPolicyId as string,
      policyVersion: payload.policyVersion as string,
      scheduledFor,
      observationId: payload.observationId as string,
      executionMode: "static",
      browserFallbackAllowed: false,
    };
  }
  return {
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    websiteProjectId: event.websiteProjectId,
    placementId: payload.placementId as string,
    candidateId: payload.candidateId as string,
    opportunityId: payload.opportunityId as string,
    initialValidationId: payload.initialValidationId as string,
  };
}

function parsePlacementMonitoringLifecycle(
  event: ClaimedOutboxEvent,
): PlacementMonitoringLifecycle {
  const payload = parseObjectPayload(event);
  if (
    event.eventType !== BACKLINK_PLACEMENT_MONITORING_LIFECYCLE
    || payload.contractVersion !== BACKLINK_PLACEMENT_MONITORING_LIFECYCLE
    || payload.kpiProjection === null
    || typeof payload.kpiProjection !== "object"
    || Array.isArray(payload.kpiProjection)
  ) {
    throw new Error("BACKLINK_PLACEMENT_OUTBOX_EVENT_INVALID");
  }
  requirePayloadStrings(payload, [
    "lifecycleEventId",
    "lifecycleEventType",
    "placementId",
    "monitorRunId",
    "monitorPolicyId",
    "observationId",
    "previousHealthStatus",
    "healthStatus",
  ]);
  return {
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    websiteProjectId: event.websiteProjectId,
    lifecycleEventId: payload.lifecycleEventId as string,
    lifecycleEventType: payload.lifecycleEventType as string,
    placementId: payload.placementId as string,
    monitorRunId: payload.monitorRunId as string,
    monitorPolicyId: payload.monitorPolicyId as string,
    observationId: payload.observationId as string,
    previousHealthStatus: payload.previousHealthStatus as string,
    healthStatus: payload.healthStatus as string,
    kpiProjection: payload.kpiProjection as Record<string, unknown>,
  };
}

export function createTemporalBacklinkProjectAnalysisStarter(
  client: TemporalWorkflowClient,
  taskQueue: string,
): WorkflowStarter {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async start(input) {
      assertBacklinksWorkflowId(input.workflowId);
      return await client.start(
        backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
        { workflowId: input.workflowId, taskQueue, args: [input] },
      );
    },
  };
}

export function createTemporalPlacementMonitoringStarter(
  client: TemporalWorkflowClient,
  taskQueue: string,
): PlacementMonitoringStarter {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async start(input) {
      const workflowId = buildBacklinksWorkflowId({
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "placement-monitoring",
        instanceId: input.runId,
      });
      assertBacklinksWorkflowId(workflowId);
      return await client.start(
        backlinksRuntimeContract.workflows.placementMonitoring.workflowType,
        {
          workflowId,
          taskQueue,
          args: [input],
        },
      );
    },
  };
}

function createPlacementOutboxRelay<T>(options: Readonly<{
  repository: RelayRepository;
  eventType: string;
  consume(input: T): Promise<unknown>;
  parse(event: ClaimedOutboxEvent): T;
  retryAt?: () => Date;
}>) {
  const retryAt = options.retryAt ?? (() => new Date(Date.now() + 5_000));
  return {
    async runOnce(input: Readonly<{
      workerId: string; limit: number; staleClaimBefore: Date;
    }>) {
      const events = await options.repository.claim({
        ...input,
        eventType: options.eventType,
      });
      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          await options.consume(options.parse(event));
          const marked = await options.repository.mark({
            eventId: event.eventId,
            workerId: input.workerId,
            outcome: "published",
          });
          if (!marked) throw new Error("BACKLINK_OUTBOX_CLAIM_LOST");
          published += 1;
        } catch (error) {
          const marked = await options.repository.mark({
            eventId: event.eventId,
            workerId: input.workerId,
            outcome: "failed",
            retryAt: retryAt(),
          });
          if (!marked) throw error;
          failed += 1;
        }
      }
      return { claimed: events.length, published, failed };
    },
  };
}

export function createPlacementMonitoringRequestedOutboxRelay(options: Readonly<{
  repository: RelayRepository;
  consumer: PlacementMonitoringRequestConsumer;
  retryAt?: () => Date;
}>) {
  return createPlacementOutboxRelay({
    repository: options.repository,
    eventType: BACKLINK_PLACEMENT_MONITORING_REQUESTED,
    consume: (input) => options.consumer.consume(input),
    parse: parsePlacementMonitoringRequest,
    ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
  });
}

export function createPlacementMonitoringLifecycleOutboxRelay(options: Readonly<{
  repository: RelayRepository;
  consumer: PlacementMonitoringLifecycleConsumer;
  retryAt?: () => Date;
}>) {
  return createPlacementOutboxRelay({
    repository: options.repository,
    eventType: BACKLINK_PLACEMENT_MONITORING_LIFECYCLE,
    consume: (input) => options.consumer.consume(input),
    parse: parsePlacementMonitoringLifecycle,
    ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
  });
}

export function createBacklinkOutboxRelay(options: Readonly<{
  repository: RelayRepository;
  workflowStarter: WorkflowStarter;
  retryAt?: () => Date;
}>) {
  const retryAt = options.retryAt ?? (() => new Date(Date.now() + 5_000));
  return {
    async runOnce(input: Readonly<{
      workerId: string; limit: number; staleClaimBefore: Date;
    }>) {
      const events = await options.repository.claim({
        ...input, eventType: BACKLINK_PROJECT_ANALYSIS_REQUESTED,
      });
      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          await options.workflowStarter.start(parseInput(event));
          const marked = await options.repository.mark({
            eventId: event.eventId, workerId: input.workerId,
            outcome: "published",
          });
          if (!marked) throw new Error("BACKLINK_OUTBOX_CLAIM_LOST");
          published += 1;
        } catch (error) {
          const marked = await options.repository.mark({
            eventId: event.eventId, workerId: input.workerId,
            outcome: "failed", retryAt: retryAt(),
          });
          if (!marked) throw error;
          failed += 1;
        }
      }
      return { claimed: events.length, published, failed };
    },
  };
}
