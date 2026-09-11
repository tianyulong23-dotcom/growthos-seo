import { describe, expect, it } from "vitest";

import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
  isBacklinksWorkflowId,
} from "../../src/modules/backlinks/workflows/namespaces.js";

describe("recommendation pool V2 Temporal registration", () => {
  it("registers a distinct workflow, activities, signal, and query", () => {
    expect(backlinksRuntimeContract.workflows.recommendationPoolV2).toEqual({
      workflowType: "backlinksRecommendationPoolV2Workflow",
      workflow: "recommendation-pool-v2",
    });
    expect(
      backlinksRuntimeContract.activities
        .executeRecommendationPoolV2DiscoveryRound,
    ).toBe("backlinksExecuteRecommendationPoolV2DiscoveryRound");
    expect(
      backlinksRuntimeContract.signals.recommendationPoolV2Superseded,
    ).toBe("backlinksRecommendationPoolV2Superseded");
    expect(
      backlinksRuntimeContract.queries.recommendationPoolV2SupersessionStatus,
    ).toBe("backlinksRecommendationPoolV2SupersessionStatus");
  });

  it("builds an accepted durable workflow identity", () => {
    const workflowId = buildBacklinksWorkflowId({
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      workflow: "recommendation-pool-v2",
      instanceId: "generation-1",
    });

    expect(workflowId).toBe(
      "backlinks:organization-1:workspace-1:project-1:" +
        "recommendation-pool-v2:v1:generation-1",
    );
    expect(isBacklinksWorkflowId(workflowId)).toBe(true);
  });
});
