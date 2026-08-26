import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BacklinkProjectAnalysisInput } from "../../../src/modules/backlinks/activities/backlink-project-analysis.activity.js";
import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import { createOutboxRepository } from "../../../src/modules/backlinks/db/repositories/outbox.repository.js";
import {
  BACKLINK_PLACEMENT_MONITORING_LIFECYCLE,
  BACKLINK_PLACEMENT_MONITORING_REQUESTED,
  BACKLINK_PROJECT_ANALYSIS_REQUESTED,
  BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
  createBacklinkOutboxRelay,
  createPlacementMonitoringLifecycleOutboxRelay,
  createPlacementMonitoringRequestedOutboxRelay,
  createRecommendationRefillOutboxRelay,
  createTemporalBacklinkProjectAnalysisStarter,
  createTemporalRecommendationRefillConsumer,
} from "../../../src/modules/backlinks/workflows/outbox-relay.js";
import {
  backlinksRuntimeContract,
  buildBacklinksRecoveryTaskQueue,
  buildBacklinksWorkflowId,
} from "../../../src/modules/backlinks/workflows/namespaces.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>; end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
  }>;
};
const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const scope = {
  organizationId: "10000000-0000-4000-8000-000000000040",
  workspaceId: "20000000-0000-4000-8000-000000000040",
  websiteProjectId: "30000000-0000-4000-8000-000000000040",
} as const;
const id = (prefix: number, sequence: number) =>
  `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

describe("BL-AI-040 Outbox Relay", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
  }, 120_000);
  beforeEach(() => client.query(
    `TRUNCATE backlink_audit_events, backlink_lifecycle_events,
       backlink_outbox_events, backlink_jobs RESTART IDENTITY CASCADE`,
  ));
  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  async function append(sequence: number) {
    const input: BacklinkProjectAnalysisInput = {
      ...scope, jobId: id(4, sequence),
      workflowId: buildBacklinksWorkflowId({
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        websiteProjectId: scope.websiteProjectId,
        workflow: "project-analysis",
        instanceId: id(4, sequence),
      }),
      snapshotVersion: sequence,
    };
    const repository = createOutboxRepository(client);
    const eventId = id(5, sequence);
    await repository.append({
      eventId, ...scope, eventType: BACKLINK_PROJECT_ANALYSIS_REQUESTED,
      aggregateId: input.jobId, aggregateVersion: 1,
      idempotencyKey: input.workflowId, payload: input,
      payloadSchemaVersion: 1, actorId: "relay-test",
    });
    return { eventId, input, repository };
  }

  it("reclaims a stale processing event after relay restart", async () => {
    const { eventId, input, repository } = await append(1);
    await repository.claim({
      workerId: "dead-relay", limit: 1,
      eventType: BACKLINK_PROJECT_ANALYSIS_REQUESTED,
    });
    const temporalStart = vi.fn(async () => undefined);
    const relay = createBacklinkOutboxRelay({
      repository,
      workflowStarter: createTemporalBacklinkProjectAnalysisStarter(
        { start: temporalStart }, backlinksRuntimeContract.taskQueue,
      ),
    });
    await expect(relay.runOnce({
      workerId: "restarted-relay", limit: 1,
      staleClaimBefore: new Date("2999-01-01"),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(temporalStart).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
      { workflowId: input.workflowId, taskQueue: backlinksRuntimeContract.taskQueue,
        args: [input] },
    );
    const stored = await client.query(
      "SELECT status, attempt_count FROM backlink_outbox_events WHERE id=$1",
      [eventId],
    );
    expect(stored.rows[0]).toEqual({ status: "published", attempt_count: 2 });
  });

  it("publishes a replay when the project-analysis Workflow already exists", async () => {
    const { eventId, repository } = await append(11);
    const alreadyStarted = new Error("workflow execution already started");
    alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
    const relay = createBacklinkOutboxRelay({
      repository,
      workflowStarter: createTemporalBacklinkProjectAnalysisStarter(
        {
          start: async () => {
            throw alreadyStarted;
          },
        },
        backlinksRuntimeContract.taskQueue,
      ),
    });

    await expect(relay.runOnce({
      workerId: "replay-relay",
      limit: 1,
      staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });

    const stored = await client.query(
      "SELECT status, attempt_count FROM backlink_outbox_events WHERE id=$1",
      [eventId],
    );
    expect(stored.rows[0]).toEqual({ status: "published", attempt_count: 1 });
  });

  it("canonicalizes a legacy project-analysis Workflow id before delivery", async () => {
    const temporalStart = vi.fn(async () => undefined);
    const starter = createTemporalBacklinkProjectAnalysisStarter(
      { start: temporalStart },
      backlinksRuntimeContract.taskQueue,
    );
    const input: BacklinkProjectAnalysisInput = {
      ...scope,
      jobId: id(4, 12),
      workflowId: [
        "backlinks",
        scope.workspaceId,
        scope.websiteProjectId,
        "project-analysis",
        "v1",
        id(4, 12),
      ].join(":"),
      snapshotVersion: 12,
    };
    const workflowId = buildBacklinksWorkflowId({
      ...scope,
      workflow: "project-analysis",
      instanceId: input.jobId,
    });

    await expect(starter.start(input)).resolves.toBeUndefined();
    expect(temporalStart).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
      {
        workflowId,
        taskQueue: backlinksRuntimeContract.taskQueue,
        args: [{ ...input, workflowId }],
      },
    );
  });

  it("does not duplicate a Job when delivery repeats after its side effect", async () => {
    const { eventId, repository } = await append(2);
    const jobs = createJobRepository(client);
    const creates: boolean[] = [];
    let failAfterCreate = true;
    let delivery = 0;
    const relay = createBacklinkOutboxRelay({
      repository,
      retryAt: () => new Date(0),
      workflowStarter: { start: async (input) => {
        creates.push(await jobs.create({
          ...scope, jobId: delivery++ === 0 ? input.jobId : id(4, 20),
          jobType: "backlink_project_analysis",
          sourceObjectType: "website_project",
          sourceObjectId: input.websiteProjectId, workflowId: input.workflowId,
          correlationId: eventId, actorId: "relay-test",
        }));
        if (failAfterCreate) {
          failAfterCreate = false;
          throw new Error("relay crashed after workflow side effect");
        }
      } },
    });
    await expect(relay.runOnce({
      workerId: "first", limit: 1, staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 0, failed: 1 });
    await expect(relay.runOnce({
      workerId: "retry", limit: 1, staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(creates).toEqual([true, false]);
    const stored = await client.query(
      `SELECT count(job.id)::int AS job_count, outbox.status,
              outbox.attempt_count
         FROM backlink_outbox_events outbox
         LEFT JOIN backlink_jobs job
           ON job.workspace_id=outbox.workspace_id
          AND job.workflow_id=outbox.idempotency_key
        WHERE outbox.id=$1 GROUP BY outbox.status, outbox.attempt_count`,
      [eventId],
    );
    expect(stored.rows[0]).toEqual({
      job_count: 1, status: "published", attempt_count: 2,
    });
  });

  it("relays one recommendation refill request to its existing Temporal workflow", async () => {
    const repository = createOutboxRepository(client);
    const recommendationContextVersionId = id(6, 30);
    const jobId = id(4, 30);
    const eventId = id(5, 30);
    const workflowId = buildBacklinksWorkflowId({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      websiteProjectId: scope.websiteProjectId,
      workflow: "recommendation-refill",
      instanceId: jobId,
    });
    const payload = {
      contractVersion: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
      ...scope,
      recommendationContextVersionId,
      visiblePoolGeneration: 1,
      jobId,
      workflowId,
      correlationId: "request-recommendation-refill-30",
      actorId: "relay-test",
      refillWindowKey: "manual-2026-08-04",
      lowWatermark: 9,
      highWatermark: 10,
      supplyMode: "existing_evidence" as const,
    };
    await repository.append({
      eventId,
      ...scope,
      eventType: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
      aggregateId: jobId,
      aggregateVersion: 1,
      idempotencyKey: workflowId,
      payload,
      payloadSchemaVersion: 1,
      actorId: "relay-test",
    });
    const temporalStart = vi.fn(async () => undefined);
    const relay = createRecommendationRefillOutboxRelay({
      repository,
      consumer: createTemporalRecommendationRefillConsumer(
        { start: temporalStart },
        backlinksRuntimeContract.taskQueue,
      ),
    });

    await expect(relay.runOnce({
      workerId: "recommendation-refill-relay",
      limit: 1,
      staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(temporalStart).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
      {
        workflowId,
        taskQueue: backlinksRuntimeContract.taskQueue,
        args: [payload],
      },
    );
  });

  it("relays the persisted paid operation authorization to Temporal", async () => {
    const repository = createOutboxRepository(client);
    const recommendationContextVersionId = id(6, 32);
    const jobId = id(4, 32);
    const eventId = id(5, 32);
    const workflowId = buildBacklinksWorkflowId({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      websiteProjectId: scope.websiteProjectId,
      workflow: "recommendation-refill",
      instanceId: jobId,
    });
    const payload = {
      contractVersion: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
      ...scope,
      recommendationContextVersionId,
      visiblePoolGeneration: 1,
      jobId,
      workflowId,
      correlationId: "request-recommendation-refill-32",
      actorId: "relay-test",
      refillWindowKey: "manual-2026-08-20",
      lowWatermark: 0,
      highWatermark: 10,
      providerOperationId: `commercial-refill-operation:${jobId}`,
      providerBudgetAuthorization: {
        provider: "dataforseo" as const,
        reasonCode: "user_authorized_persistent_discovery" as const,
        maxPaidCalls: 3,
        maxCostMicros: 1_000_000,
        authorizedBy: "relay-test",
      },
    };
    await repository.append({
      eventId,
      ...scope,
      eventType: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
      aggregateId: jobId,
      aggregateVersion: 1,
      idempotencyKey: workflowId,
      payload,
      payloadSchemaVersion: 1,
      actorId: "relay-test",
    });
    const temporalStart = vi.fn(async () => undefined);
    const relay = createRecommendationRefillOutboxRelay({
      repository,
      consumer: createTemporalRecommendationRefillConsumer(
        { start: temporalStart },
        backlinksRuntimeContract.taskQueue,
      ),
    });

    await expect(relay.runOnce({
      workerId: "recommendation-refill-relay",
      limit: 1,
      staleClaimBefore: new Date(0),
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(temporalStart).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
      {
        workflowId,
        taskQueue: backlinksRuntimeContract.taskQueue,
        args: [payload],
      },
    );
  });

  it("isolates recovery relay dispatch to its exact job and outbox event", async () => {
    const repository = createOutboxRepository(client);
    const recommendationContextVersionId = id(6, 31);
    const jobId = id(4, 31);
    const unrelatedJobId = id(4, 32);
    const eventId = id(5, 31);
    const unrelatedEventId = id(5, 32);
    const appendRefill = async (
      refillJobId: string,
      refillEventId: string,
    ) => {
      const workflowId = buildBacklinksWorkflowId({
        ...scope,
        workflow: "recommendation-refill",
        instanceId: refillJobId,
      });
      await repository.append({
        eventId: refillEventId,
        ...scope,
        eventType: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
        aggregateId: refillJobId,
        aggregateVersion: 1,
        idempotencyKey: workflowId,
        payload: {
          contractVersion: BACKLINK_RECOMMENDATION_REFILL_REQUESTED,
          ...scope,
          recommendationContextVersionId,
          visiblePoolGeneration: 1,
          jobId: refillJobId,
          workflowId,
          correlationId: `recovery-${refillJobId}`,
          actorId: "relay-test",
          refillWindowKey: `manual-${refillJobId}`,
          lowWatermark: 9,
          highWatermark: 10,
        },
        payloadSchemaVersion: 1,
        actorId: "relay-test",
      });
      return workflowId;
    };
    const workflowId = await appendRefill(jobId, eventId);
    await appendRefill(unrelatedJobId, unrelatedEventId);
    const temporalStart = vi.fn(async () => undefined);
    const taskQueue = buildBacklinksRecoveryTaskQueue(jobId);
    const relay = createRecommendationRefillOutboxRelay({
      repository,
      consumer: createTemporalRecommendationRefillConsumer(
        { start: temporalStart },
        taskQueue,
        { expectedJobId: jobId },
      ),
    });

    await expect(relay.runOnce({
      workerId: "recommendation-refill-recovery",
      limit: 1,
      staleClaimBefore: new Date(0),
      eventId,
    })).resolves.toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(temporalStart).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
      {
        workflowId,
        taskQueue,
        args: [expect.objectContaining({ jobId })],
      },
    );
    expect((await client.query(
      `SELECT id,status FROM backlink_outbox_events ORDER BY id`,
    )).rows).toEqual([
      { id: eventId, status: "published" },
      { id: unrelatedEventId, status: "pending" },
    ]);
  });

  it("relays Placement monitoring request and lifecycle contracts to their owner consumers", async () => {
    const repository = createOutboxRepository(client);
    const placementId = id(6, 3);
    const requestedEventId = id(7, 3);
    const lifecycleEventId = id(8, 3);
    const monitorRunId = id(9, 3);
    const monitorPolicyId = id(6, 4);
    const observationId = id(7, 4);
    const reverifyRunId = id(9, 4);
    const reverifyObservationId = id(7, 5);
    const scheduledFor = "2026-07-29T10:00:00.000Z";
    await repository.append({
      eventId: requestedEventId,
      ...scope,
      eventType: BACKLINK_PLACEMENT_MONITORING_REQUESTED,
      aggregateId: placementId,
      aggregateVersion: 1,
      idempotencyKey: `placement-monitoring:${placementId}`,
      payload: {
        contractVersion: BACKLINK_PLACEMENT_MONITORING_REQUESTED,
        placementId,
        candidateId: id(6, 5),
        opportunityId: null,
        initialValidationId: id(6, 7),
        websiteProjectId: scope.websiteProjectId,
      },
      payloadSchemaVersion: 1,
      actorId: "relay-test",
    });
    await repository.append({
      eventId: id(7, 6),
      ...scope,
      eventType: BACKLINK_PLACEMENT_MONITORING_REQUESTED,
      aggregateId: placementId,
      aggregateVersion: 3,
      idempotencyKey: `placement-monitoring-reverify:${reverifyRunId}`,
      payload: {
        contractVersion: BACKLINK_PLACEMENT_MONITORING_REQUESTED,
        requestKind: "reverify",
        placementId,
        candidateId: id(6, 5),
        opportunityId: id(6, 6),
        initialValidationId: id(6, 7),
        websiteProjectId: scope.websiteProjectId,
        monitorRunId: reverifyRunId,
        monitorPolicyId,
        policyVersion: "placement-monitoring-v1",
        scheduledFor,
        observationId: reverifyObservationId,
        executionMode: "static",
        browserFallbackAllowed: false,
      },
      payloadSchemaVersion: 1,
      actorId: "relay-test",
    });
    await repository.append({
      eventId: lifecycleEventId,
      ...scope,
      eventType: BACKLINK_PLACEMENT_MONITORING_LIFECYCLE,
      aggregateId: placementId,
      aggregateVersion: 2,
      idempotencyKey: `placement-monitoring-lifecycle:${placementId}:${monitorRunId}`,
      payload: {
        contractVersion: BACKLINK_PLACEMENT_MONITORING_LIFECYCLE,
        lifecycleEventId: id(8, 4),
        lifecycleEventType: "placement.recovered",
        placementId,
        monitorRunId,
        monitorPolicyId,
        observationId,
        previousHealthStatus: "lost",
        healthStatus: "active",
        kpiProjection: { restoredAt: "2026-07-29T10:00:00.000Z" },
      },
      payloadSchemaVersion: 1,
      actorId: "relay-test",
    });
    const requested = vi.fn(async () => undefined);
    const lifecycle = vi.fn(async () => undefined);
    const requestedRelay = createPlacementMonitoringRequestedOutboxRelay({
      repository,
      consumer: { consume: requested },
    });
    const lifecycleRelay = createPlacementMonitoringLifecycleOutboxRelay({
      repository,
      consumer: { consume: lifecycle },
    });
    const runInput = {
      workerId: "placement-relay",
      limit: 10,
      staleClaimBefore: new Date(0),
    };

    await expect(requestedRelay.runOnce(runInput)).resolves.toEqual({
      claimed: 2, published: 2, failed: 0,
    });
    await expect(lifecycleRelay.runOnce(runInput)).resolves.toEqual({
      claimed: 1, published: 1, failed: 0,
    });
    expect(requested).toHaveBeenNthCalledWith(1, {
      ...scope,
      sourceOutboxEventId: requestedEventId,
      requestedAt: expect.any(Date),
      placementId,
      candidateId: id(6, 5),
      opportunityId: null,
      initialValidationId: id(6, 7),
    });
    expect(requested).toHaveBeenNthCalledWith(2, {
      ...scope,
      requestKind: "reverify",
      placementId,
      candidateId: id(6, 5),
      opportunityId: id(6, 6),
      initialValidationId: id(6, 7),
      monitorRunId: reverifyRunId,
      monitorPolicyId,
      policyVersion: "placement-monitoring-v1",
      scheduledFor: new Date(scheduledFor),
      observationId: reverifyObservationId,
      executionMode: "static",
      browserFallbackAllowed: false,
    });
    expect(lifecycle).toHaveBeenCalledWith({
      ...scope,
      lifecycleEventId: id(8, 4),
      lifecycleEventType: "placement.recovered",
      placementId,
      monitorRunId,
      monitorPolicyId,
      observationId,
      previousHealthStatus: "lost",
      healthStatus: "active",
      kpiProjection: { restoredAt: "2026-07-29T10:00:00.000Z" },
    });
  });
});
