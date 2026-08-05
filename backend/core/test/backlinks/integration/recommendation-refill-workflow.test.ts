import { resolve } from "node:path";

import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it, vi } from "vitest";

import type { EvidenceValue } from "../../../src/modules/backlinks/domain/evidence/evidence.js";
import type { RecommendationEvidenceCandidate } from "../../../src/modules/backlinks/domain/recommendations/evaluation.js";
import {
  recommendationGateRuleIds,
  type RecommendationGateRuleId,
  type RecommendationRuleFacts,
} from "../../../src/modules/backlinks/domain/recommendations/gates.js";
import {
  recommendationScoreComponentIds,
  type RecommendationScoreComponentId,
  type RecommendationScoreComponentInput,
} from "../../../src/modules/backlinks/domain/recommendations/scoring.js";
import {
  runBacklinkRecommendationRefillWorkflow,
  type BacklinkRecommendationRefillActivities,
  type BacklinkRecommendationRefillInput,
} from "../../../src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.js";
import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "../../../src/modules/backlinks/workflows/namespaces.js";

const sourceReleaseId = "dataforseo-2026-07-25";
const evidencePolicyVersion = "recommendation-evidence-policy.v1";
const inputScope = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
} as const;
const input: BacklinkRecommendationRefillInput = {
  ...inputScope,
  recommendationContextVersionId: "018f0000-0000-7000-8000-000000000004",
  jobId: "018f0000-0000-7000-8000-000000000005",
  workflowId: buildBacklinksWorkflowId({
    workspaceId: inputScope.workspaceId,
    websiteProjectId: inputScope.websiteProjectId,
    workflow: "recommendation-refill",
    instanceId: "018f0000-0000-7000-8000-000000000005",
  }),
  correlationId: "correlation-061",
  actorId: "worker-061",
  refillWindowKey: "2026-07-25T08:00Z/15m",
  lowWatermark: 2,
  highWatermark: 5,
};

function observed<T>(value: T, evidenceRef: string): EvidenceValue<T> {
  return {
    availability: "observed",
    value,
    sourceType: "dataforseo",
    sourceReleaseId,
    confidence: 0.95,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: [evidenceRef],
  };
}

function unavailable<T>(evidenceRef: string): EvidenceValue<T> {
  return {
    availability: "unavailable",
    reason: "partial_scan",
    sourceType: "dataforseo",
    sourceReleaseId,
    confidence: 0,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: [evidenceRef],
  };
}

function gates(
  overrides: Partial<Record<RecommendationGateRuleId, EvidenceValue<boolean>>>
  = {},
): RecommendationRuleFacts {
  return Object.fromEntries(recommendationGateRuleIds.map((ruleId) => [
    ruleId,
    {
      evidenceKey: `gate.${ruleId}`,
      result: overrides[ruleId] ?? observed(false, `gate:${ruleId}`),
    },
  ])) as unknown as RecommendationRuleFacts;
}

const componentValues: Readonly<
  Record<RecommendationScoreComponentId, number>
> = {
  graph_authority_diversity: 0.8,
  topic_content_editorial_quality: 0.7,
  outbound_commercialization: 0.9,
  network_risk: 0.6,
  technical_health: 1,
};

function components(
  overrides: Partial<
    Record<RecommendationScoreComponentId, EvidenceValue<number>>
  > = {},
): RecommendationScoreComponentInput[] {
  return recommendationScoreComponentIds.map((id) => ({
    id,
    evidence: overrides[id] ?? observed(componentValues[id], `score:${id}`),
    normalizedValue: overrides[id]?.availability === "unavailable"
      ? null
      : componentValues[id],
    normalizationRuleVersion: "recommendation-normalization.v1",
    reasonCode: `SUPPORTED_${id.toUpperCase()}`,
  }));
}

function candidate(
  hostnameAscii: string,
  options: Readonly<{
    gates?: RecommendationRuleFacts;
    components?: RecommendationScoreComponentInput[];
  }> = {},
): RecommendationEvidenceCandidate {
  return {
    hostnameAscii,
    sourceReleaseId,
    evidencePolicyVersion,
    gates: options.gates ?? gates(),
    components: options.components ?? components(),
  };
}

function refillCandidates(): readonly RecommendationEvidenceCandidate[] {
  return [
    candidate("zeta.com"),
    candidate("unsafe.com", {
      gates: gates({
        unsafe_or_malicious: observed(true, "safety:unsafe.com"),
      }),
    }),
    candidate("missing.com", {
      components: components({
        graph_authority_diversity: unavailable("graph:missing.com"),
      }),
    }),
    candidate("alpha.com"),
  ];
}

function fakeActivities(
  readyIds: readonly string[],
  options: Readonly<{ fail?: boolean }> = {},
) {
  const inventory = new Set(readyIds);
  const windows = new Map<string, string>();
  const reserveRecommendationRefill = vi.fn(async (
    request: BacklinkRecommendationRefillInput,
  ) => {
    const existingJobId = windows.get(request.refillWindowKey);
    if (existingJobId !== undefined) {
      return {
        status: "already_started", readyCount: inventory.size,
        jobId: existingJobId,
      } as const;
    }
    if (inventory.size >= request.lowWatermark) {
      return {
        status: "inventory_sufficient", readyCount: inventory.size,
      } as const;
    }
    windows.set(request.refillWindowKey, request.jobId);
    return {
      status: "started", readyCount: inventory.size, jobId: request.jobId,
    } as const;
  });
  const executeRecommendationRefill = vi.fn(async (
    request: Parameters<
      BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
    >[0],
  ) => {
    void request;
    if (options.fail === true) {
      throw new Error("FAKE_PROVIDER_UNAVAILABLE");
    }
    return { candidates: refillCandidates() };
  });
  const storeReadyRecommendations = vi.fn(async (
    request: Parameters<
      BacklinkRecommendationRefillActivities["storeReadyRecommendations"]
    >[0],
  ) => {
    for (const recommendation of request.recommendations) {
      inventory.add(recommendation.hostnameAscii);
    }
    return { addedCount: request.recommendations.length };
  });
  const recordRecommendationRefillFailure = vi.fn(async () => undefined);
  const activities: BacklinkRecommendationRefillActivities = {
    reserveRecommendationRefill,
    executeRecommendationRefill,
    storeReadyRecommendations,
    recordRecommendationRefillFailure,
  };
  return {
    activities,
    inventory,
    reserveRecommendationRefill,
    executeRecommendationRefill,
    storeReadyRecommendations,
    recordRecommendationRefillFailure,
  };
}

describe("BacklinkRecommendationRefillWorkflow", () => {
  it("stores only deterministic Ready recommendations", async () => {
    const bundle = await bundleWorkflowCode({
      workflowsPath: resolve(
        "src/modules/backlinks/workflows/definitions/index.ts",
      ),
    });
    expect(bundle.code).toContain(
      backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
    );

    const fake = fakeActivities(["ready-1"]);
    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).resolves.toEqual({
      status: "completed",
      readyCount: 1,
      jobId: input.jobId,
      addedCount: 2,
      evaluatedCount: 4,
      excludedCount: 1,
      insufficientDataCount: 1,
    });
    expect(
      fake.storeReadyRecommendations.mock.calls[0]?.[0].recommendations.map(
        ({ hostnameAscii }) => hostnameAscii,
      ),
    ).toEqual(["alpha.com", "zeta.com"]);
    expect(fake.inventory).toEqual(new Set([
      "ready-1",
      "alpha.com",
      "zeta.com",
    ]));

    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).resolves.toMatchObject({
      status: "already_started", jobId: input.jobId,
    });
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).toHaveBeenCalledOnce();
  }, 60_000);

  it("does not refill when Ready inventory is at the low watermark", async () => {
    const fake = fakeActivities(["ready-1", "ready-2"]);
    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).resolves.toEqual({
      status: "inventory_sufficient", readyCount: 2,
    });
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
  });

  it("records failure without clearing existing Ready inventory", async () => {
    const fake = fakeActivities(["ready-1"], { fail: true });
    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).rejects.toThrow("FAKE_PROVIDER_UNAVAILABLE");
    expect([...fake.inventory]).toEqual(["ready-1"]);
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
    expect(fake.recordRecommendationRefillFailure).toHaveBeenCalledWith({
      ...input,
      jobId: input.jobId,
      errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED",
    });
  });
});
