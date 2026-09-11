import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  patched: vi.fn(),
  condition: vi.fn(async () => undefined),
  run: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
  patched: mocked.patched,
  condition: mocked.condition,
  defineQuery: vi.fn(),
  defineSignal: vi.fn(),
  proxyActivities: () => ({}),
  setHandler: vi.fn(),
}));
vi.mock("../../src/modules/backlinks/application/services/recommendation-pool-v2-workflow.service.js", () => ({
  runRecommendationPoolV2Workflow: mocked.run,
}));

import {
  backlinksRecommendationPoolV2Workflow,
  recommendationPoolV2PublicationPollingPatchId,
} from "../../src/modules/backlinks/workflows/definitions/recommendation-pool-v2.workflow.js";
import type { RecommendationPoolV2WorkflowInput } from "../../src/modules/backlinks/workflows/recommendation-pool-v2.starter.js";
import type { RecommendationPoolV2WorkflowHooks } from "../../src/modules/backlinks/application/services/recommendation-pool-v2-workflow.service.js";
import { recommendationPoolV2OperationalPolicy } from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-v2-policy.js";

describe("versioned publication polling", () => {
  it.each([
    { patched: false, requested: 900_000, expected: 900_000 },
    { patched: true, requested: 900_000, expected: 5_000 },
    { patched: true, requested: 1_200, expected: 1_200 },
  ])("preserves history and deadline: $patched/$requested", async (sample) => {
    vi.clearAllMocks();
    mocked.patched.mockImplementation((id: string) =>
      id === recommendationPoolV2PublicationPollingPatchId ? sample.patched : true);
    mocked.run.mockImplementation(async (_input, _activities, hooks: RecommendationPoolV2WorkflowHooks) => {
      await hooks.waitForPreparationPoll({ delayMs: sample.requested });
      return { status: "superseded" };
    });
    await backlinksRecommendationPoolV2Workflow({} as RecommendationPoolV2WorkflowInput);
    expect(mocked.condition).toHaveBeenCalledWith(expect.any(Function), sample.expected);
    expect(recommendationPoolV2OperationalPolicy.contactPreparation.pollIntervalMs)
      .toBe(900_000);
  });
});
