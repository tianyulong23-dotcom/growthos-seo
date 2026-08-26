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
  type RecommendationRefillSupersessionSignal,
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
    organizationId: inputScope.organizationId,
    workspaceId: inputScope.workspaceId,
    websiteProjectId: inputScope.websiteProjectId,
    workflow: "recommendation-refill",
    instanceId: "018f0000-0000-7000-8000-000000000005",
  }),
  correlationId: "correlation-061",
  actorId: "worker-061",
  refillWindowKey: "2026-07-25T08:00Z/15m",
  lowWatermark: 9,
  highWatermark: 10,
};
const supersession: RecommendationRefillSupersessionSignal = {
  contractVersion: 1,
  ...inputScope,
  jobId: input.jobId,
  workflowId: input.workflowId,
  oldContext: {
    contextVersionId: input.recommendationContextVersionId,
    snapshotVersion: 7,
    profileVersionId: "profile-v3",
    promotionTargetVersionId: "promotion-v2",
    generationInputFingerprint: "generation-v7",
  },
  authoritativeContext: {
    contextVersionId: "018f0000-0000-7000-8000-000000000006",
    snapshotVersion: 8,
    profileVersionId: "profile-v4",
    promotionTargetVersionId: "promotion-v2",
    generationInputFingerprint: "generation-v8",
  },
  actorId: "reconciler-061",
  correlationId: "supersede-correlation-061",
  requestId: "supersede-request-061",
  idempotencyKey:
    `recommendation-refill.supersede:${input.jobId}:`
    + "018f0000-0000-7000-8000-000000000006",
  lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
  auditEventId: "018f0000-0000-7000-8000-000000000008",
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
  options: Readonly<{
    fail?: boolean;
    failure?: Error;
    candidates?: readonly RecommendationEvidenceCandidate[];
    outcome?: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED";
  }> = {},
) {
  const inventory = new Set(readyIds);
  const windows = new Map<string, string>();
  let plannedWindow = false;
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
    if (inventory.size >= request.highWatermark) {
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
    if (options.failure !== undefined) {
      throw options.failure;
    }
    if (options.fail === true) {
      throw new Error("FAKE_PROVIDER_UNAVAILABLE");
    }
    return {
      candidates: options.candidates ?? refillCandidates(),
      provider: {
        source: "provider" as const,
        acquiredAt: "2026-08-04T00:00:00.000Z",
        costMicros: 12_000,
        requestFingerprint: "request-fingerprint",
      },
    };
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
  const planRecommendationRefillSupply = vi.fn(async () => {
    if (!plannedWindow) {
      plannedWindow = true;
      return {
        status: "execute",
        source: "paid",
        refillWindowKey: input.refillWindowKey,
        refillTier: "exact_product_target_market",
        refillRound: 1,
        refillWindow: 1,
        requestedCandidateCount: input.highWatermark - inventory.size,
      } as const;
    }
    return {
      status: "complete",
      outcome: options.outcome ?? "TARGET_REACHED",
      publishedCount: inventory.size,
    } as const;
  });
  const completeRecommendationRefillSupply = vi.fn(async () => undefined);
  const completeRecommendationRefillSupersession = vi.fn(async () => ({
    status: "cancelled" as const,
    replayed: false,
  }));
  const waitForRecommendationRefillRetry = vi.fn(async () => undefined);
  const recordRecommendationRefillFailure = vi.fn(async () => ({
    status: "failed" as const,
  }));
  const activities: BacklinkRecommendationRefillActivities = {
    reserveRecommendationRefill,
    executeRecommendationRefill,
    storeReadyRecommendations,
    planRecommendationRefillSupply,
    completeRecommendationRefillSupply,
    completeRecommendationRefillSupersession,
    waitForRecommendationRefillRetry,
    recordRecommendationRefillFailure,
  };
  return {
    activities,
    inventory,
    reserveRecommendationRefill,
    executeRecommendationRefill,
    storeReadyRecommendations,
    planRecommendationRefillSupply,
    completeRecommendationRefillSupply,
    completeRecommendationRefillSupersession,
    waitForRecommendationRefillRetry,
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
    expect(bundle.code).toContain(
      backlinksRuntimeContract.signals.recommendationRefillSuperseded,
    );
    expect(bundle.code).toContain(
      backlinksRuntimeContract.queries.recommendationRefillSupersessionStatus,
    );
    expect(bundle.code).toContain(
      "backlinks-recommendation-refill-existing-window-once-v2",
    );
    expect(bundle.code).toContain(
      "backlinks-recommendation-refill-existing-window-terminal-v1",
    );

    const recoveryBundle = await bundleWorkflowCode({
      workflowsPath: resolve(
        "src/modules/backlinks/workflows/definitions/recovery.ts",
      ),
    });
    expect(recoveryBundle.code).toContain(
      backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
    );
    const recoveryWorkflows = await import(
      "../../../src/modules/backlinks/workflows/definitions/recovery.js"
    );
    expect(Object.keys(recoveryWorkflows)).toEqual([
      backlinksRuntimeContract.workflows.recommendationRefill.workflowType,
    ]);

    const readyIds = Array.from({ length: 8 }, (_, index) => `ready-${index + 1}`);
    const fake = fakeActivities(readyIds);
    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).resolves.toEqual({
      status: "completed",
      readyCount: 8,
      jobId: input.jobId,
      addedCount: 2,
      evaluatedCount: 4,
      excludedCount: 1,
      insufficientDataCount: 1,
      outcome: "TARGET_REACHED",
      publishedCount: 10,
    });
    expect(
      fake.storeReadyRecommendations.mock.calls[0]?.[0].recommendations.map(
        ({ hostnameAscii }) => hostnameAscii,
      ),
    ).toEqual(["alpha.com", "zeta.com"]);
    expect(fake.inventory).toEqual(new Set([
      ...readyIds,
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
    expect(fake.storeReadyRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ finalizeJob: false }),
    );
    expect(fake.completeRecommendationRefillSupply).toHaveBeenCalledOnce();
  }, 60_000);

  it("does not refill when published inventory reaches the requested target", async () => {
    const readyIds = Array.from(
      { length: input.highWatermark },
      (_, index) => `ready-${index + 1}`,
    );
    const fake = fakeActivities(readyIds);
    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).resolves.toEqual({
      status: "inventory_sufficient",
      readyCount: input.highWatermark,
    });
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
  });

  it("stores an empty result without reporting target completion", async () => {
    const fake = fakeActivities([], { candidates: [] });
    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).resolves.toEqual({
      status: "incomplete",
      readyCount: 0,
      jobId: input.jobId,
      addedCount: 0,
      evaluatedCount: 0,
      excludedCount: 0,
      insufficientDataCount: 0,
      outcome: "TARGET_REACHED",
      publishedCount: 0,
    });
    expect(fake.storeReadyRecommendations).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendations: [],
        evaluationSummary: {
          evaluated: 0,
          ready: 0,
          excluded: 0,
          insufficientData: 0,
        },
      }),
    );
  });

  it("does not report completion when governed supply stops below target", async () => {
    const fake = fakeActivities([], {
      candidates: [],
      outcome: "SUPPLY_FLOOR_REACHED",
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
    )).resolves.toMatchObject({
      status: "incomplete",
      outcome: "SUPPLY_FLOOR_REACHED",
      publishedCount: 0,
    });
    expect(fake.completeRecommendationRefillSupply).toHaveBeenCalledOnce();
  });

  it("finishes the current job when its approved budget is exhausted", async () => {
    const fake = fakeActivities([]);
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "wait",
      outcome: "PAUSED_BUDGET",
      reason: "budget",
      retryAfterMs: 60_000,
      publishedCount: 0,
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
    )).resolves.toEqual({
      status: "incomplete",
      readyCount: 0,
      jobId: input.jobId,
      addedCount: 0,
      evaluatedCount: 0,
      excludedCount: 0,
      insufficientDataCount: 0,
      outcome: "PAUSED_BUDGET",
      publishedCount: 0,
    });
    expect(fake.completeRecommendationRefillSupply).toHaveBeenCalledWith({
      ...input,
      jobId: input.jobId,
      outcome: "PAUSED_BUDGET",
      publishedCount: 0,
      addedCount: 0,
      evaluatedCount: 0,
      excludedCount: 0,
      insufficientDataCount: 0,
    });
    expect(fake.waitForRecommendationRefillRetry).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
  });

  it("waits once for provider recovery and continues as new", async () => {
    const fake = fakeActivities([]);
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "wait",
      outcome: "PROVIDER_PAUSED",
      reason: "provider",
      retryAfterMs: 60_000,
      publishedCount: 0,
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
    )).resolves.toEqual({
      status: "continue_as_new",
      reason: "wait",
      input: {
        ...input,
        continuation: {
          jobId: input.jobId,
          readyCount: 0,
          addedCount: 0,
          evaluatedCount: 0,
          excludedCount: 0,
          insufficientDataCount: 0,
        },
      },
    });
    expect(fake.planRecommendationRefillSupply).toHaveBeenCalledOnce();
    expect(fake.waitForRecommendationRefillRetry).toHaveBeenCalledOnce();
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
  });

  it("preserves counters and skips reservation after a bounded slice", async () => {
    const fake = fakeActivities([]);
    const first = await runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      { maxSteps: 1 },
    );
    expect(first).toMatchObject({
      status: "continue_as_new",
      reason: "step_limit",
      input: {
        continuation: {
          jobId: input.jobId,
          readyCount: 0,
          addedCount: 2,
          evaluatedCount: 4,
          excludedCount: 1,
          insufficientDataCount: 1,
          lastExecutedRefillWindowKey: input.refillWindowKey,
        },
      },
    });
    if (first.status !== "continue_as_new") {
      throw new Error("Expected recommendation refill continuation");
    }
    expect(first.input.continuation).not.toHaveProperty("refillTier");
    expect(first.input.continuation).not.toHaveProperty("refillRound");

    await expect(runBacklinkRecommendationRefillWorkflow(
      first.input,
      fake.activities,
      { maxSteps: 1 },
    )).resolves.toEqual({
      status: "incomplete",
      readyCount: 0,
      jobId: input.jobId,
      addedCount: 2,
      evaluatedCount: 4,
      excludedCount: 1,
      insufficientDataCount: 1,
      outcome: "TARGET_REACHED",
      publishedCount: 2,
    });
    expect(fake.reserveRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.planRecommendationRefillSupply).toHaveBeenCalledTimes(2);
  });

  it("waits instead of executing the same refill window twice", async () => {
    const fake = fakeActivities([]);
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "execute",
      source: "paid",
      refillWindowKey: input.refillWindowKey,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      requestedCandidateCount: 10,
    });

    await expect(runBacklinkRecommendationRefillWorkflow({
      ...input,
      continuation: {
        jobId: input.jobId,
        readyCount: 0,
        addedCount: 0,
        evaluatedCount: 0,
        excludedCount: 0,
        insufficientDataCount: 0,
        lastExecutedRefillWindowKey: input.refillWindowKey,
      },
    }, fake.activities)).resolves.toMatchObject({
      status: "continue_as_new",
      reason: "wait",
      input: {
        continuation: {
          lastExecutedRefillWindowKey: input.refillWindowKey,
        },
      },
    });
    expect(fake.waitForRecommendationRefillRetry).toHaveBeenCalledWith({
      retryAfterMs: 60_000,
      reason: "provider",
    });
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
  });

  it("executes and publishes an existing-evidence window only once", async () => {
    const fake = fakeActivities([]);
    const existingEvidenceWindow =
      "commercial-existing:project-1:context-1:g1";
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "execute",
      source: "existing",
      refillWindowKey: existingEvidenceWindow,
      requestedCandidateCount: 10,
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      {
        ...input,
        refillWindowKey: existingEvidenceWindow,
      },
      fake.activities,
    )).resolves.toEqual({
      status: "incomplete",
      readyCount: 0,
      jobId: input.jobId,
      addedCount: 2,
      evaluatedCount: 4,
      excludedCount: 1,
      insufficientDataCount: 1,
      outcome: "SUPPLY_FLOOR_REACHED",
      terminalReason: "EXISTING_EVIDENCE_WINDOW_COMPLETED",
      publishedCount: 2,
    });
    expect(fake.planRecommendationRefillSupply).toHaveBeenCalledOnce();
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).toHaveBeenCalledOnce();
    expect(fake.completeRecommendationRefillSupply).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalReason: "EXISTING_EVIDENCE_WINDOW_COMPLETED",
        publishedCount: 2,
      }),
    );
    expect(fake.waitForRecommendationRefillRetry).not.toHaveBeenCalled();
  });

  it("terminates an existing-evidence window with explicit no progress", async () => {
    const fake = fakeActivities([]);
    const existingEvidenceWindow =
      "commercial-existing:project-1:context-1:g1";
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "execute",
      source: "existing",
      refillWindowKey: existingEvidenceWindow,
      requestedCandidateCount: 10,
    });
    fake.storeReadyRecommendations.mockResolvedValueOnce({ addedCount: 0 });

    await expect(runBacklinkRecommendationRefillWorkflow(
      {
        ...input,
        refillWindowKey: existingEvidenceWindow,
      },
      fake.activities,
    )).resolves.toMatchObject({
      status: "incomplete",
      addedCount: 0,
      outcome: "SUPPLY_FLOOR_REACHED",
      terminalReason: "EXISTING_EVIDENCE_NO_PROGRESS",
      publishedCount: 0,
    });
    expect(fake.planRecommendationRefillSupply).toHaveBeenCalledOnce();
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).toHaveBeenCalledOnce();
  });

  it("does not re-execute an existing-evidence key carried by continuation", async () => {
    const fake = fakeActivities([]);
    const existingEvidenceWindow =
      "commercial-existing:project-1:context-1:g1";
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "execute",
      source: "existing",
      refillWindowKey: existingEvidenceWindow,
      requestedCandidateCount: 10,
    });

    await expect(runBacklinkRecommendationRefillWorkflow({
      ...input,
      continuation: {
        jobId: input.jobId,
        readyCount: 0,
        addedCount: 2,
        evaluatedCount: 4,
        excludedCount: 1,
        insufficientDataCount: 1,
        lastExecutedRefillWindowKey: existingEvidenceWindow,
        executedRefillWindowKeys: [existingEvidenceWindow],
      },
    }, fake.activities)).resolves.toMatchObject({
      status: "incomplete",
      jobId: input.jobId,
      addedCount: 2,
      terminalReason: "EXISTING_EVIDENCE_NO_PROGRESS",
      publishedCount: 2,
    });
    expect(fake.waitForRecommendationRefillRetry).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
    expect(fake.completeRecommendationRefillSupply).toHaveBeenCalledOnce();
  });

  it("preserves the existing-window command sequence for pre-patch histories", async () => {
    const fake = fakeActivities([]);
    const existingEvidenceWindow =
      "commercial-existing:project-1:context-1:g1";
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "execute",
      source: "existing",
      refillWindowKey: existingEvidenceWindow,
      requestedCandidateCount: 10,
    });

    await expect(runBacklinkRecommendationRefillWorkflow({
      ...input,
      continuation: {
        jobId: input.jobId,
        readyCount: 0,
        addedCount: 0,
        evaluatedCount: 0,
        excludedCount: 0,
        insufficientDataCount: 0,
        lastExecutedRefillWindowKey: existingEvidenceWindow,
        executedRefillWindowKeys: [existingEvidenceWindow],
      },
    }, fake.activities, {
      maxSteps: 1,
      allowExistingEvidenceWindowReplay: true,
      enforceExistingEvidenceWindowOnce: false,
      completeExistingEvidenceWindow: () => false,
    })).resolves.toMatchObject({
      status: "continue_as_new",
      reason: "step_limit",
      input: {
        continuation: {
          lastExecutedRefillWindowKey: existingEvidenceWindow,
          executedRefillWindowKeys: [existingEvidenceWindow],
        },
      },
    });
    expect(fake.waitForRecommendationRefillRetry).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).toHaveBeenCalledOnce();
  });

  it("does not repeat a paid window after an existing-evidence step", async () => {
    const fake = fakeActivities([]);
    const existingEvidenceWindow =
      "commercial-existing:project-1:context-1:g1";
    fake.planRecommendationRefillSupply
      .mockResolvedValueOnce({
        status: "execute",
        source: "paid",
        refillWindowKey: input.refillWindowKey,
        refillTier: "exact_product_target_market",
        refillRound: 1,
        refillWindow: 1,
        requestedCandidateCount: 10,
      })
      .mockResolvedValueOnce({
        status: "execute",
        source: "existing",
        refillWindowKey: existingEvidenceWindow,
        requestedCandidateCount: 10,
      })
      .mockResolvedValueOnce({
        status: "execute",
        source: "paid",
        refillWindowKey: input.refillWindowKey,
        refillTier: "exact_product_target_market",
        refillRound: 1,
        refillWindow: 1,
        requestedCandidateCount: 10,
      });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
    )).resolves.toMatchObject({
      status: "incomplete",
      terminalReason: "EXISTING_EVIDENCE_WINDOW_COMPLETED",
    });
    expect(fake.executeRecommendationRefill).toHaveBeenCalledTimes(2);
    expect(fake.executeRecommendationRefill.mock.calls.map(
      ([request]) => [request.source, request.refillWindowKey],
    )).toEqual([
      ["paid", input.refillWindowKey],
      ["existing", existingEvidenceWindow],
    ]);
    expect(fake.planRecommendationRefillSupply).toHaveBeenCalledTimes(2);
    expect(fake.waitForRecommendationRefillRetry).not.toHaveBeenCalled();
  });

  it("preserves historical execution before the no-progress patch", async () => {
    const fake = fakeActivities([]);
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "execute",
      source: "paid",
      refillWindowKey: input.refillWindowKey,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      requestedCandidateCount: 10,
    });

    await expect(runBacklinkRecommendationRefillWorkflow({
      ...input,
      continuation: {
        jobId: input.jobId,
        readyCount: 0,
        addedCount: 0,
        evaluatedCount: 0,
        excludedCount: 0,
        insufficientDataCount: 0,
        lastExecutedRefillWindowKey: input.refillWindowKey,
      },
    }, fake.activities, {
      maxSteps: 1,
      enableNoProgressGuard: false,
    })).resolves.toMatchObject({
      status: "continue_as_new",
      reason: "step_limit",
    });
    expect(fake.waitForRecommendationRefillRetry).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).toHaveBeenCalledOnce();
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
      rootCause: "PROVIDER_UNAVAILABLE",
      recovery: "WAIT_PROVIDER",
      diagnosticId: expect.stringMatching(/^refill-/),
      message:
        "The recommendation provider is unavailable. Retry after recovery.",
    });
  });

  it("lets authoritative supersession win after a historical provider failure", async () => {
    const failure = new Error("FAKE_PROVIDER_TIMEOUT");
    const fake = fakeActivities(["ready-1"], { failure });
    fake.recordRecommendationRefillFailure.mockResolvedValue({
      status: "superseded",
      supersession,
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
    )).resolves.toEqual({
      status: "cancelled",
      reason: "superseded_project_context",
      jobId: input.jobId,
      supersession,
    });
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.recordRecommendationRefillFailure).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
  });

  it("waits for provider reconciliation instead of recording ordinary failure", async () => {
    const failure = new Error("FAKE_PROVIDER_TIMEOUT");
    const fake = fakeActivities(["ready-1"], { failure });
    fake.recordRecommendationRefillFailure.mockResolvedValue({
      status: "awaiting_provider_reconciliation",
      supersession,
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
    )).resolves.toMatchObject({
      status: "continue_as_new",
      reason: "wait",
      input: {
        continuation: { supersession },
      },
    });
    expect(fake.waitForRecommendationRefillRetry).toHaveBeenCalledWith({
      retryAfterMs: 30_000,
      reason: "project_context",
    });
  });

  it("records language input requirements as project context recovery", async () => {
    const failure = new Error(
      "WEBSITE_PROJECT_DISCOVERY_LANGUAGE_INPUT_REQUIRED "
        + "owner=WEBSITE_PROJECT",
    );
    const fake = fakeActivities(["ready-1"], { failure });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input, fake.activities,
    )).rejects.toBe(failure);
    expect(fake.recordRecommendationRefillFailure).toHaveBeenCalledWith({
      ...input,
      jobId: input.jobId,
      errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED",
      rootCause: "PROJECT_CONTEXT_REQUIRED",
      recovery: "COMPLETE_PROJECT_CONTEXT",
      diagnosticId: expect.stringMatching(/^refill-/),
      message:
        "Complete the current project context before resuming this operation.",
    });
  });

  it("cooperatively cancels before reserving or calling a provider", async () => {
    const fake = fakeActivities([]);

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      { readSupersession: () => supersession },
    )).resolves.toEqual({
      status: "cancelled",
      reason: "superseded_project_context",
      jobId: input.jobId,
      supersession,
    });
    expect(fake.completeRecommendationRefillSupersession).toHaveBeenCalledOnce();
    expect(fake.reserveRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.planRecommendationRefillSupply).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
  });

  it("checks supersession after planning and before provider execution", async () => {
    const fake = fakeActivities([]);
    let reads = 0;

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      {
        readSupersession: () => (++reads >= 3 ? supersession : undefined),
      },
    )).resolves.toMatchObject({
      status: "cancelled",
      reason: "superseded_project_context",
    });
    expect(fake.planRecommendationRefillSupply).toHaveBeenCalledOnce();
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
  });

  it("settles a completed provider activity before storing stale candidates", async () => {
    const fake = fakeActivities([]);
    let reads = 0;

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      {
        readSupersession: () => (++reads >= 4 ? supersession : undefined),
      },
    )).resolves.toMatchObject({
      status: "cancelled",
      reason: "superseded_project_context",
    });
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
    expect(fake.storeReadyRecommendations).not.toHaveBeenCalled();
  });

  it("wakes a waiting workflow and prevents continuation after supersession", async () => {
    const fake = fakeActivities([]);
    let received: RecommendationRefillSupersessionSignal | undefined;
    fake.planRecommendationRefillSupply.mockResolvedValue({
      status: "wait",
      outcome: "PROVIDER_PAUSED",
      reason: "provider",
      retryAfterMs: 60_000,
      publishedCount: 0,
    });
    fake.waitForRecommendationRefillRetry.mockImplementation(async () => {
      received = supersession;
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      { readSupersession: () => received },
    )).resolves.toMatchObject({
      status: "cancelled",
      reason: "superseded_project_context",
    });
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
  });

  it("carries supersession across continue-as-new while provider reconciliation is pending", async () => {
    const fake = fakeActivities([]);
    fake.completeRecommendationRefillSupersession.mockResolvedValue({
      status: "awaiting_provider_reconciliation",
      replayed: false,
    });

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      { readSupersession: () => supersession },
    )).resolves.toMatchObject({
      status: "continue_as_new",
      reason: "wait",
      input: {
        continuation: { supersession },
      },
    });
    expect(fake.waitForRecommendationRefillRetry).toHaveBeenCalledWith({
      retryAfterMs: 30_000,
      reason: "project_context",
    });
    expect(fake.reserveRecommendationRefill).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).not.toHaveBeenCalled();
  });

  it("ignores a mismatched project signal and keeps the current workflow", async () => {
    const fake = fakeActivities([]);
    const mismatched = {
      ...supersession,
      websiteProjectId: "018f0000-0000-7000-8000-000000000099",
    };

    await expect(runBacklinkRecommendationRefillWorkflow(
      input,
      fake.activities,
      { readSupersession: () => mismatched },
    )).resolves.toMatchObject({
      status: "incomplete",
      outcome: "TARGET_REACHED",
    });
    expect(fake.completeRecommendationRefillSupersession).not.toHaveBeenCalled();
    expect(fake.executeRecommendationRefill).toHaveBeenCalledOnce();
  });
});
