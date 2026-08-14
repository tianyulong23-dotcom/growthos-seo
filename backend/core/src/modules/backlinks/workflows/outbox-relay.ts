import type { BacklinkProjectAnalysisInput } from "../activities/backlink-project-analysis.activity.js";
import type {
  ContactEnrichmentActivityInput,
} from "../activities/contact-enrichment.activity.js";
import {
  contactEnrichmentRequestedEventType,
} from "../application/commands/contact-enrichment.command.js";
import type {
  PlacementInitialValidationWorkflowInput,
} from "../application/workflows/placement-initial-validation.workflow.js";
import type {
  PlacementMonitorWorkflowInput,
} from "../application/workflows/placement-monitor.workflow.js";
import type {
  PlacementMonitoringInitializationWorkflowInput,
} from "../application/workflows/placement-monitoring-initialization.workflow.js";
import type {
  GmailSendWorkflowInput,
} from "../application/workflows/send-workflow.js";
import type {
  BacklinkRecommendationRefillInput,
} from "./definitions/backlink-recommendation-refill.orchestration.js";
import { commercialSupplyPublishedTarget } from "../domain/recommendations/commercial-refill-cycle.js";
import {
  sendIntentCreatedEventType,
} from "../application/services/send-intent.repository.js";
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
export const BACKLINK_RECOMMENDATION_REFILL_REQUESTED =
  "backlinks.recommendation-refill.requested.v1";
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
  sourceOutboxEventId: string;
  requestedAt: Date;
  placementId: string;
  candidateId: string;
  opportunityId: string | null;
  initialValidationId: string;
}>;
type ReverifyPlacementMonitoringRequest = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  requestKind: "reverify";
  placementId: string;
  candidateId: string;
  opportunityId: string | null;
  initialValidationId: string;
  monitorRunId: string;
  monitorPolicyId: string;
  policyVersion: string;
  scheduledFor: Date;
  observationId: string;
  executionMode: "static";
  browserFallbackAllowed: boolean;
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
type PlacementInitialValidationStarter = Readonly<{
  start(input: PlacementInitialValidationWorkflowInput): Promise<unknown>;
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
type GmailSendConsumer = Readonly<{
  consume(input: GmailSendWorkflowInput): Promise<unknown>;
}>;
type RecommendationRefillConsumer = Readonly<{
  consume(input: BacklinkRecommendationRefillInput): Promise<unknown>;
}>;
type ContactEnrichmentConsumer = Readonly<{
  consume(input: ContactEnrichmentActivityInput): Promise<unknown>;
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

function requireNullablePayloadString(
  payload: Record<string, unknown>,
  field: string,
): void {
  if (
    !(field in payload)
    || (
      payload[field] !== null
      && typeof payload[field] !== "string"
    )
  ) {
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
    "initialValidationId",
    "websiteProjectId",
  ]);
  requireNullablePayloadString(payload, "opportunityId");
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
      || typeof payload.browserFallbackAllowed !== "boolean"
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
      opportunityId: payload.opportunityId === null
        ? null
        : payload.opportunityId as string,
      initialValidationId: payload.initialValidationId as string,
      monitorRunId: payload.monitorRunId as string,
      monitorPolicyId: payload.monitorPolicyId as string,
      policyVersion: payload.policyVersion as string,
      scheduledFor,
      observationId: payload.observationId as string,
      executionMode: "static",
      browserFallbackAllowed: payload.browserFallbackAllowed,
    };
  }
  return {
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    websiteProjectId: event.websiteProjectId,
    sourceOutboxEventId: event.eventId,
    requestedAt: event.availableAt,
    placementId: payload.placementId as string,
    candidateId: payload.candidateId as string,
    opportunityId: payload.opportunityId === null
      ? null
      : payload.opportunityId as string,
    initialValidationId: payload.initialValidationId as string,
  };
}

function workflowAlreadyStarted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "WorkflowExecutionAlreadyStartedError"
    || /workflow execution.*already (?:started|exists)/iu.test(error.message);
}

export function createTemporalPlacementMonitoringInitializationConsumer(
  client: TemporalWorkflowClient,
  taskQueue: string,
  workerId: string,
): PlacementMonitoringRequestConsumer {
  assertBacklinksTaskQueue(taskQueue);
  const monitoringStarter = createTemporalPlacementMonitoringStarter(
    client,
    taskQueue,
  );
  return {
    async consume(input) {
      if ("requestKind" in input) {
        return monitoringStarter.start({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          placementId: input.placementId,
          monitorPolicyId: input.monitorPolicyId,
          policyVersion: input.policyVersion,
          scheduledFor: input.scheduledFor,
          runId: input.monitorRunId,
          observationId: input.observationId,
          workerId,
          now: new Date(),
        });
      }
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "placement-monitoring-initialization",
        instanceId: input.sourceOutboxEventId,
      });
      const workflowInput: PlacementMonitoringInitializationWorkflowInput = {
        ...input,
        requestedAt: input.requestedAt.toISOString(),
        projectionId: input.sourceOutboxEventId,
        workflowId,
        workerId,
      };
      try {
        await client.start(
          backlinksRuntimeContract.workflows
            .placementMonitoringInitialization.workflowType,
          {
            workflowId,
            taskQueue,
            args: [workflowInput],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
      }
      return {
        workflowId,
        projectionId: workflowInput.projectionId,
      };
    },
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

function parseGmailSendRequest(
  event: ClaimedOutboxEvent,
): GmailSendWorkflowInput {
  const payload = event.payload as Record<string, unknown> | null;
  if (
    event.eventType !== sendIntentCreatedEventType
    || event.payloadSchemaVersion !== 1
    || payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || typeof payload.sendIntentId !== "string"
    || typeof payload.gmailConnectionId !== "string"
    || typeof payload.actorId !== "string"
    || payload.sendIntentId !== event.aggregateId
  ) {
    throw new Error("BACKLINK_GMAIL_SEND_OUTBOX_EVENT_INVALID");
  }
  return {
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    websiteProjectId: event.websiteProjectId,
    sendIntentId: payload.sendIntentId,
    gmailConnectionId: payload.gmailConnectionId,
    actorId: payload.actorId,
  };
}

function parseRecommendationRefillRequest(
  event: ClaimedOutboxEvent,
): BacklinkRecommendationRefillInput {
  const payload = event.payload as Record<string, unknown> | null;
  const stringFields = [
    "organizationId",
    "workspaceId",
    "websiteProjectId",
    "recommendationContextVersionId",
    "jobId",
    "workflowId",
    "correlationId",
    "actorId",
    "refillWindowKey",
  ] as const;
  if (
    event.eventType !== BACKLINK_RECOMMENDATION_REFILL_REQUESTED
    || event.payloadSchemaVersion !== 1
    || payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.contractVersion !== BACKLINK_RECOMMENDATION_REFILL_REQUESTED
    || stringFields.some((field) => typeof payload[field] !== "string")
    || payload.organizationId !== event.organizationId
    || payload.workspaceId !== event.workspaceId
    || payload.websiteProjectId !== event.websiteProjectId
    || payload.jobId !== event.aggregateId
    || payload.workflowId !== event.idempotencyKey
    || !Number.isInteger(payload.visiblePoolGeneration)
    || Number(payload.visiblePoolGeneration) < 1
    || !Number.isInteger(payload.lowWatermark)
    || !Number.isInteger(payload.highWatermark)
    || Number(payload.lowWatermark) !== commercialSupplyPublishedTarget - 1
    || Number(payload.highWatermark) !== commercialSupplyPublishedTarget
  ) {
    throw new Error("BACKLINK_RECOMMENDATION_REFILL_OUTBOX_EVENT_INVALID");
  }
  return payload as BacklinkRecommendationRefillInput;
}

function parseContactEnrichmentRequest(
  event: ClaimedOutboxEvent,
): ContactEnrichmentActivityInput {
  const payload = event.payload as Record<string, unknown> | null;
  const stringFields = [
    "organizationId",
    "workspaceId",
    "websiteProjectId",
    "jobId",
    "actorId",
  ] as const;
  if (
    event.eventType !== contactEnrichmentRequestedEventType
    || event.payloadSchemaVersion !== 1
    || payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.contractVersion !== contactEnrichmentRequestedEventType
    || stringFields.some((field) => typeof payload[field] !== "string")
    || payload.organizationId !== event.organizationId
    || payload.workspaceId !== event.workspaceId
    || payload.websiteProjectId !== event.websiteProjectId
    || payload.jobId !== event.aggregateId
    || !Number.isInteger(payload.requestVersion)
    || Number(payload.requestVersion) < 1
  ) {
    throw new Error("BACKLINK_CONTACT_ENRICHMENT_OUTBOX_EVENT_INVALID");
  }
  return payload as ContactEnrichmentActivityInput;
}

export function createTemporalContactEnrichmentConsumer(
  client: TemporalWorkflowClient,
  taskQueue: string,
): ContactEnrichmentConsumer {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async consume(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "contact-enrichment",
        instanceId: `${input.jobId}-${input.requestVersion}`,
      });
      try {
        await client.start(
          backlinksRuntimeContract.workflows.contactEnrichment.workflowType,
          {
            workflowId,
            taskQueue,
            args: [input],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
      }
      return { workflowId };
    },
  };
}

export function createTemporalRecommendationRefillConsumer(
  client: TemporalWorkflowClient,
  taskQueue: string,
): RecommendationRefillConsumer {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async consume(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "recommendation-refill",
        instanceId: input.jobId,
      });
      if (workflowId !== input.workflowId) {
        throw new Error("BACKLINK_RECOMMENDATION_REFILL_WORKFLOW_ID_INVALID");
      }
      try {
        await client.start(
          backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
          {
            workflowId,
            taskQueue,
            args: [input],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
      }
      return { workflowId };
    },
  };
}

export function createTemporalGmailSendConsumer(
  client: TemporalWorkflowClient,
  taskQueue: string,
): GmailSendConsumer {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async consume(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "gmail-send",
        instanceId: input.sendIntentId,
      });
      try {
        await client.start(
          backlinksRuntimeContract.workflows.gmailSend.workflowType,
          {
            workflowId,
            taskQueue,
            args: [input],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
      }
      return { workflowId };
    },
  };
}

export function createTemporalBacklinkProjectAnalysisStarter(
  client: TemporalWorkflowClient,
  taskQueue: string,
): WorkflowStarter {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async start(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "project-analysis",
        instanceId: input.jobId,
      });
      assertBacklinksWorkflowId(workflowId);
      const legacyWorkflowId = [
        "backlinks",
        input.workspaceId,
        input.websiteProjectId,
        "project-analysis",
        "v1",
        input.jobId,
      ].join(":");
      if (
        input.workflowId !== workflowId
        && input.workflowId !== legacyWorkflowId
      ) {
        assertBacklinksWorkflowId(input.workflowId);
        throw new Error("BACKLINKS_PROJECT_ANALYSIS_WORKFLOW_ID_MISMATCH");
      }
      const canonicalInput = { ...input, workflowId };
      try {
        return await client.start(
          backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
          { workflowId, taskQueue, args: [canonicalInput] },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
        return { workflowId, state: "existing" as const };
      }
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
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "placement-monitoring",
        instanceId: input.runId,
      });
      assertBacklinksWorkflowId(workflowId);
      try {
        return await client.start(
          backlinksRuntimeContract.workflows.placementMonitoring.workflowType,
          {
            workflowId,
            taskQueue,
            args: [input],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
        return { workflowId, state: "existing" as const };
      }
    },
  };
}

export function createTemporalPlacementInitialValidationStarter(
  client: TemporalWorkflowClient,
  taskQueue: string,
): PlacementInitialValidationStarter {
  assertBacklinksTaskQueue(taskQueue);
  return {
    async start(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "placement-initial-validation",
        instanceId: input.candidateId,
      });
      assertBacklinksWorkflowId(workflowId);
      try {
        return await client.start(
          backlinksRuntimeContract.workflows
            .placementInitialValidation.workflowType,
          {
            workflowId,
            taskQueue,
            args: [input],
          },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
        return { workflowId, state: "existing" as const };
      }
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

export function createGmailSendOutboxRelay(options: Readonly<{
  repository: RelayRepository;
  consumer: GmailSendConsumer;
  retryAt?: () => Date;
}>) {
  return createPlacementOutboxRelay({
    repository: options.repository,
    eventType: sendIntentCreatedEventType,
    consume: (input) => options.consumer.consume(input),
    parse: parseGmailSendRequest,
    ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
  });
}

export function createRecommendationRefillOutboxRelay(options: Readonly<{
  repository: RelayRepository;
  consumer: RecommendationRefillConsumer;
  retryAt?: () => Date;
}>) {
  return createPlacementOutboxRelay({
    repository: options.repository,
    eventType: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
    consume: (input) => options.consumer.consume(input),
    parse: parseRecommendationRefillRequest,
    ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
  });
}

export function createContactEnrichmentOutboxRelay(options: Readonly<{
  repository: RelayRepository;
  consumer: ContactEnrichmentConsumer;
  retryAt?: () => Date;
}>) {
  return createPlacementOutboxRelay({
    repository: options.repository,
    eventType: contactEnrichmentRequestedEventType,
    consume: (input) => options.consumer.consume(input),
    parse: parseContactEnrichmentRequest,
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
