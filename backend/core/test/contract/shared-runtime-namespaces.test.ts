import { describe, expect, it, vi } from "vitest";

import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
  isBacklinksWorkflowId,
} from "../../src/modules/backlinks/workflows/namespaces.js";
import {
  BACKLINK_PLACEMENT_MONITORING_LIFECYCLE,
  BACKLINK_PLACEMENT_MONITORING_REQUESTED,
  BACKLINK_PROJECT_ANALYSIS_REQUESTED,
  createTemporalBacklinkProjectAnalysisStarter,
  createTemporalPlacementMonitoringInitializationConsumer,
  createTemporalPlacementMonitoringStarter,
} from "../../src/modules/backlinks/workflows/outbox-relay.js";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000006",
  workspaceId: "20000000-0000-4000-8000-000000000006",
  websiteProjectId: "30000000-0000-4000-8000-000000000006",
} as const;

describe("BL-AI-ARCH-006 shared runtime namespaces", () => {
  it("does not advertise a retired recommendation workflow or activity", () => {
    expect(backlinksRuntimeContract.workflows).not.toHaveProperty("recommendationRefill");
    expect(Object.values(backlinksRuntimeContract.activities).some((name) => name.includes("RecommendationRefill"))).toBe(false);
    expect(backlinksRuntimeContract.signals).not.toHaveProperty("recommendationRefillSuperseded");
    expect(isBacklinksWorkflowId("backlinks:org:ws:project:recommendation-refill:v1:job")).toBe(false);
    expect(isBacklinksWorkflowId("backlinks:org:ws:project:recommendation-pool-v2:v1:job")).toBe(true);
  });
  it("fixes the Backlinks queue, Worker permissions, and Provider Kill Switch", () => {
    expect(backlinksRuntimeContract).toMatchObject({
      moduleId: "backlinks",
      taskQueue: "growthos.backlinks.v1",
      databaseRole: "growthos_backlinks_writer",
      allowedSchemas: ["backlinks"],
      providers: {
        dataForSeo: {
          providerId: "dataforseo",
          killSwitch: "backlinks.dataforseo.v1",
        },
      },
    });
  });

  it("builds and validates module-scoped Workflow IDs", () => {
    const workflowId = buildBacklinksWorkflowId({
      ...scope,
      workflow: "project-analysis",
      instanceId: "40000000-0000-4000-8000-000000000006",
    });

    expect(workflowId).toBe(
      "backlinks:10000000-0000-4000-8000-000000000006:" +
        "20000000-0000-4000-8000-000000000006:" +
        "30000000-0000-4000-8000-000000000006:project-analysis:v1:" +
        "40000000-0000-4000-8000-000000000006",
    );
    expect(isBacklinksWorkflowId(workflowId)).toBe(true);
    expect(isBacklinksWorkflowId("content:workspace:project:analysis:v1:job")).toBe(false);
    expect(isBacklinksWorkflowId("backlink-recommendation-refill/job")).toBe(false);
  });

  it("starts only the registered Workflow type on the registered queue", async () => {
    const start = vi.fn(async () => undefined);
    const workflowId = buildBacklinksWorkflowId({
      ...scope,
      workflow: "project-analysis",
      instanceId: "40000000-0000-4000-8000-000000000007",
    });
    const input = {
      ...scope,
      jobId: "40000000-0000-4000-8000-000000000007",
      workflowId,
      snapshotVersion: 1,
    };
    const starter = createTemporalBacklinkProjectAnalysisStarter(
      { start },
      backlinksRuntimeContract.taskQueue,
    );

    await starter.start(input);
    expect(start).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
      {
        workflowId,
        taskQueue: "growthos.backlinks.v1",
        args: [input],
      },
    );
    expect(BACKLINK_PROJECT_ANALYSIS_REQUESTED).toBe(
      "backlinks.project-analysis.requested.v1",
    );
    await expect(starter.start({
      ...input,
      workflowId: "audit:workspace:project:analysis:v1:job",
    })).rejects.toThrow("BACKLINKS_WORKFLOW_ID_INVALID");
  });

  it("reserves Placement workflow IDs and monitoring dispatch for the same queue", async () => {
    const start = vi.fn(async () => undefined);
    const input = {
      ...scope,
      placementId: "40000000-0000-4000-8000-000000000008",
      monitorPolicyId: "40000000-0000-4000-8000-000000000009",
      policyVersion: "placement-monitoring-v1",
      scheduledFor: new Date("2026-07-29T10:00:00.000Z"),
      runId: "40000000-0000-4000-8000-000000000010",
      observationId: "40000000-0000-4000-8000-000000000011",
      workerId: "backlinks-worker",
      now: new Date("2026-07-29T10:00:00.000Z"),
    };
    const starter = createTemporalPlacementMonitoringStarter(
      { start },
      backlinksRuntimeContract.taskQueue,
    );

    await starter.start(input);
    expect(start).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.placementMonitoring.workflowType,
      {
        workflowId: buildBacklinksWorkflowId({
          ...scope,
          workflow: "placement-monitoring",
          instanceId: input.runId,
        }),
        taskQueue: backlinksRuntimeContract.taskQueue,
        args: [input],
      },
    );
    expect(
      buildBacklinksWorkflowId({
        ...scope,
        workflow: "placement-initial-validation",
        instanceId: input.placementId,
      }),
    ).toContain(":placement-initial-validation:v1:");
    expect(BACKLINK_PLACEMENT_MONITORING_REQUESTED).toBe(
      "backlinks.placement-monitoring.requested.v1",
    );
    expect(BACKLINK_PLACEMENT_MONITORING_LIFECYCLE).toBe(
      "backlinks.placement-monitoring.lifecycle.v1",
    );
  });

  it("uses the Outbox ID for idempotent monitoring projection dispatch", async () => {
    const start = vi.fn(async () => undefined);
    const sourceOutboxEventId =
      "40000000-0000-4000-8000-000000000012";
    const consumer = createTemporalPlacementMonitoringInitializationConsumer(
      { start },
      backlinksRuntimeContract.taskQueue,
      "worker-1",
    );

    await consumer.consume({
      ...scope,
      sourceOutboxEventId,
      requestedAt: new Date("2026-07-31T06:00:00.000Z"),
      placementId: "40000000-0000-4000-8000-000000000013",
      candidateId: "40000000-0000-4000-8000-000000000014",
      opportunityId: "40000000-0000-4000-8000-000000000015",
      initialValidationId: "40000000-0000-4000-8000-000000000016",
    });

    const workflowId = buildBacklinksWorkflowId({
      ...scope,
      workflow: "placement-monitoring-initialization",
      instanceId: sourceOutboxEventId,
    });
    expect(start).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows
        .placementMonitoringInitialization.workflowType,
      {
        workflowId,
        taskQueue: backlinksRuntimeContract.taskQueue,
        args: [expect.objectContaining({
          sourceOutboxEventId,
          projectionId: sourceOutboxEventId,
          workflowId,
          workerId: "worker-1",
          requestedAt: "2026-07-31T06:00:00.000Z",
        })],
      },
    );
  });
});
