import { describe, expect, it, vi } from "vitest";

import {
  createTemporalRecommendationPoolV2Starter,
  type RecommendationPoolV2WorkflowLaunchInput,
} from "../../src/modules/backlinks/workflows/recommendation-pool-v2.starter.js";
import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "../../src/modules/backlinks/workflows/namespaces.js";

const input: RecommendationPoolV2WorkflowLaunchInput = Object.freeze({
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  generationContractId: "generation-1",
  recommendationContextVersionId: "context-1",
  visiblePoolGeneration: 1,
  inputPinId: "input-pin-1",
  jobId: "job-1",
  actorId: "cutover-test",
  rounds: Object.freeze([
    Object.freeze({
      round: 1,
      requestFingerprint: "request-fingerprint-1",
      idempotencyKey: "round-1",
      maxCostMicros: 1_000_000,
    }),
    Object.freeze({
      round: 2,
      requestFingerprint: "request-fingerprint-2",
      idempotencyKey: "round-2",
      maxCostMicros: 1_000_000,
    }),
  ]),
});

describe("recommendation pool V2 Temporal starter", () => {
  it("starts the canonical V2 workflow with durable lineage", async () => {
    const start = vi.fn(async () => undefined);
    const starter = createTemporalRecommendationPoolV2Starter(
      { start },
      backlinksRuntimeContract.taskQueue,
    );

    const result = await starter.start(input);

    const workflowId = buildBacklinksWorkflowId({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      workflow: "recommendation-pool-v2",
      instanceId: input.generationContractId,
    });
    expect(result).toEqual({ workflowId, status: "started" });
    expect(start).toHaveBeenCalledWith(
      backlinksRuntimeContract.workflows.recommendationPoolV2.workflowType,
      {
        workflowId,
        taskQueue: backlinksRuntimeContract.taskQueue,
        args: [{ ...input, workflowId }],
      },
    );
  });

  it("converges concurrent starts without creating a second workflow", async () => {
    const error = new Error("workflow execution already started");
    error.name = "WorkflowExecutionAlreadyStartedError";
    const starter = createTemporalRecommendationPoolV2Starter(
      { start: vi.fn(async () => Promise.reject(error)) },
      backlinksRuntimeContract.taskQueue,
    );

    await expect(starter.start(input)).resolves.toMatchObject({
      status: "already_started",
    });
  });

  it("rejects a task queue outside the shared Backlinks runtime", () => {
    expect(() =>
      createTemporalRecommendationPoolV2Starter(
        { start: vi.fn(async () => undefined) },
        "growthos.backlinks.v2",
      ),
    ).toThrow("BACKLINKS_TASK_QUEUE_INVALID");
  });
});
