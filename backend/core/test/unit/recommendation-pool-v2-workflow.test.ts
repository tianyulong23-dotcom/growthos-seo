import { describe, expect, it, vi } from "vitest";

import { createRecommendationPoolV2Activities } from "../../src/modules/backlinks/activities/recommendation-pool-v2.activity.js";
import { createRecommendationFeedCommands } from "../../src/modules/backlinks/application/commands/recommendation-feed.command.js";
import {
  runRecommendationPoolV2Workflow,
  type RecommendationPoolV2GenerationFinalization,
  type RecommendationPoolV2WorkflowActivities,
  type RecommendationPoolV2WorkflowInput,
} from "../../src/modules/backlinks/application/services/recommendation-pool-v2-workflow.service.js";
import { buildRecommendationPoolV2ReleaseMetricPersistence } from "../../src/modules/backlinks/application/services/recommendation-pool-v2-release-snapshot.service.js";
import type { ResolvedProjectContext } from "../../src/modules/backlinks/ports/project-context.port.js";

const input: RecommendationPoolV2WorkflowInput = Object.freeze({
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  generationContractId: "generation-1",
  recommendationContextVersionId: "context-1",
  visiblePoolGeneration: 2,
  inputPinId: "pin-1",
  jobId: "job-1",
  workflowId: "workflow-1",
  actorId: "actor-1",
  rounds: Object.freeze([
    Object.freeze({
      round: 1 as const,
      requestFingerprint: "fingerprint-round-1",
      idempotencyKey: "generation-1:round:1",
      maxCostMicros: 1_000_000,
    }),
    Object.freeze({
      round: 2 as const,
      requestFingerprint: "fingerprint-round-2",
      idempotencyKey: "generation-1:round:2",
      maxCostMicros: 1_000_000,
    }),
  ]),
});

const finalization = (
  reason: RecommendationPoolV2GenerationFinalization["discoveryTerminalReason"],
  totalSettledCostMicros = 2_000_000,
  effectiveUniqueCandidateCount = 105,
): RecommendationPoolV2GenerationFinalization =>
  Object.freeze({
    effectiveUniqueCandidateCount,
    discoveryTerminalReason: reason,
    totalSettledCostMicros,
    discoveryCompletedAt: "2026-08-28T00:00:00.000Z",
    preparationStartedAt: "2026-08-28T00:00:00.000Z",
    preparationDeadlineAt: "2026-08-29T00:00:00.000Z",
    batches: canonicalBatches(effectiveUniqueCandidateCount),
  });

function canonicalBatches(
  effectiveUniqueCandidateCount: number,
): readonly Readonly<{
  batchId: string;
  ordinal: number;
  originalBatchSize: number;
}>[] {
  if (effectiveUniqueCandidateCount === 0) return Object.freeze([]);
  const batchSize =
    effectiveUniqueCandidateCount < 25
      ? effectiveUniqueCandidateCount
      : Math.min(100, Math.ceil(effectiveUniqueCandidateCount / 5));
  const batches = [];
  for (
    let offset = 0, ordinal = 1;
    offset < effectiveUniqueCandidateCount;
    offset += batchSize, ordinal += 1
  ) {
    batches.push(
      Object.freeze({
        batchId: `batch-${ordinal}`,
        ordinal,
        originalBatchSize: Math.min(
          batchSize,
          effectiveUniqueCandidateCount - offset,
        ),
      }),
    );
  }
  return Object.freeze(batches);
}

function activities(
  overrides: Partial<RecommendationPoolV2WorkflowActivities> = {},
): RecommendationPoolV2WorkflowActivities {
  let preparedBatchCount = 0;
  return createRecommendationPoolV2Activities({
    loadGeneration: vi.fn(async () => ({ status: "ready" as const })),
    executeDiscoveryRound: vi.fn(async (round) =>
      round.round === 1
        ? {
            round: 1 as const,
            requestFingerprint: round.requestFingerprint,
            chargeState: "settled" as const,
            costMicros: 1_000_000,
            totalUniqueCandidateCount: 40,
            pathsExhausted: false,
            completedWindows: [
              {
                completed: true,
                rawCandidateCount: 100,
                canonicalCandidateCount: 100,
                newUniqueCount: 10,
              },
            ],
          }
        : {
            round: 2 as const,
            requestFingerprint: round.requestFingerprint,
            chargeState: "settled" as const,
            costMicros: 1_000_000,
            totalUniqueCandidateCount: 105,
            pathsExhausted: false,
            completedWindows: [
              {
                completed: true,
                rawCandidateCount: 100,
                canonicalCandidateCount: 100,
                newUniqueCount: 65,
              },
            ],
          },
    ),
    finalizeGeneration: vi.fn(async (request) =>
      finalization(
        request.terminalReason,
        request.totalSettledCostMicros,
        request.rounds.at(-1)?.totalUniqueCandidateCount ?? 0,
      ),
    ),
    prepareCanonicalBatches: vi.fn(async (request) => {
      preparedBatchCount = request.batchIds.length;
    }),
    inspectCanonicalBatchPreparation: vi.fn(async () => {
      return {
        databaseNow: "2026-08-28T01:00:00.000Z",
        state: "AVAILABLE" as const,
        terminalBatchCount: preparedBatchCount,
        totalBatchCount: preparedBatchCount,
      };
    }),
    convergeCanonicalBatchPreparation: vi.fn(async () => undefined),
    activateGeneration: vi.fn(async () => undefined),
    completeGenerationWithoutPublication: vi.fn(async () => undefined),
    failGeneration: vi.fn(async () => undefined),
    completeGenerationSupersession: vi.fn(async () => undefined),
    ...overrides,
  });
}

const hooks = {
  terminalSemanticsVersion: 2 as const,
  readSupersession: () => undefined,
  waitForPreparationPoll: vi.fn(async () => undefined),
};

describe("recommendation pool V2 workflow", () => {
  it("runs two distinct 1 USD rounds, caps total at 2 USD, and prepares current plus next", async () => {
    const activity = activities();
    const result = await runRecommendationPoolV2Workflow(
      input,
      activity,
      hooks,
    );

    expect(result).toEqual({
      status: "completed",
      discoveryTerminalReason: "SAFE_SUPPLY_REACHED",
      effectiveUniqueCandidateCount: 105,
      preparedBatchIds: ["batch-1", "batch-2"],
      totalSettledCostMicros: 2_000_000,
    });
    expect(result).not.toHaveProperty("provider");
    expect(result).not.toHaveProperty("endpoint");
    expect(result).not.toHaveProperty("requestRef");
    expect(activity.executeDiscoveryRound).toHaveBeenCalledTimes(2);
    expect(activity.finalizeGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        totalSettledCostMicros: 2_000_000,
        hardCandidateLimit: 1_000,
        rounds: [
          expect.objectContaining({ round: 1 }),
          expect.objectContaining({ round: 2 }),
        ],
      }),
    );
    expect(activity.prepareCanonicalBatches).toHaveBeenCalledWith(
      expect.objectContaining({ batchIds: ["batch-1", "batch-2"] }),
    );
    expect(activity.activateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        batchIds: ["batch-1", "batch-2"],
        publicationOutcome: "READY",
      }),
    );
  });

  it("reports a successful zero-valid result as exhausted, not input required", async () => {
    const activity = activities({
      executeDiscoveryRound: vi.fn(async (round) => ({
        round: round.round,
        requestFingerprint: round.requestFingerprint,
        chargeState: "settled" as const,
        costMicros: 0,
        totalUniqueCandidateCount: 0,
        pathsExhausted: true,
        completedWindows: [],
      })),
    });

    const firstRound = input.rounds[0];
    if (firstRound === undefined) {
      throw new Error("Expected at least one recommendation-pool V2 round.");
    }
    const result = await runRecommendationPoolV2Workflow(
      { ...input, rounds: [firstRound] },
      activity,
      hooks,
    );

    expect(result).toEqual({
      status: "completed",
      discoveryTerminalReason: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
      effectiveUniqueCandidateCount: 0,
      preparedBatchIds: [],
      totalSettledCostMicros: 0,
    });
    expect(activity.completeGenerationWithoutPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: input.jobId,
        generationContractId: input.generationContractId,
        reason: "NO_VALID_CANDIDATES_AFTER_EXHAUSTION",
      }),
    );
    expect(activity.prepareCanonicalBatches).not.toHaveBeenCalled();
    expect(activity.activateGeneration).not.toHaveBeenCalled();
  });

  it("preserves the legacy zero-valid activity contract for unpatched histories", async () => {
    const activity = activities({
      executeDiscoveryRound: vi.fn(async (round) => ({
        round: round.round,
        requestFingerprint: round.requestFingerprint,
        chargeState: "settled" as const,
        costMicros: 0,
        totalUniqueCandidateCount: 0,
        pathsExhausted: true,
        completedWindows: [],
      })),
    });
    const firstRound = input.rounds[0];
    if (firstRound === undefined) {
      throw new Error("Expected at least one recommendation-pool V2 round.");
    }

    const result = await runRecommendationPoolV2Workflow(
      { ...input, rounds: [firstRound] },
      activity,
      { ...hooks, terminalSemanticsVersion: 1 },
    );

    expect(result).toEqual({
      status: "input_required",
      reason: "RECOMMENDATION_POOL_V2_NO_NATIVE_CANDIDATES",
    });
    expect(activity.completeGenerationWithoutPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "RECOMMENDATION_POOL_V2_NO_NATIVE_CANDIDATES",
      }),
    );
  });

  it("publishes one to 99 admitted candidates as partial exhausted", async () => {
    const activity = activities({
      executeDiscoveryRound: vi.fn(async (round) => ({
        round: round.round,
        requestFingerprint: round.requestFingerprint,
        chargeState: "settled" as const,
        costMicros: 500_000,
        totalUniqueCandidateCount: 37,
        pathsExhausted: true,
        completedWindows: [
          {
            completed: true,
            rawCandidateCount: 100,
            canonicalCandidateCount: 37,
            newUniqueCount: 37,
          },
        ],
      })),
    });
    const firstRound = input.rounds[0];
    if (firstRound === undefined) {
      throw new Error("Expected at least one recommendation-pool V2 round.");
    }

    const result = await runRecommendationPoolV2Workflow(
      { ...input, rounds: [firstRound] },
      activity,
      hooks,
    );

    expect(result).toMatchObject({
      status: "partial_exhausted",
      effectiveUniqueCandidateCount: 37,
    });
    expect(activity.activateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationOutcome: "PARTIAL_EXHAUSTED",
      }),
    );
  });

  it("returns input required for missing seeds before any provider call", async () => {
    const activity = activities({
      loadGeneration: vi.fn(async () => ({
        status: "input_required" as const,
        reason: "DISCOVERY_SEEDS_REQUIRED",
      })),
    });

    const result = await runRecommendationPoolV2Workflow(
      input,
      activity,
      hooks,
    );

    expect(result).toEqual({
      status: "input_required",
      reason: "DISCOVERY_SEEDS_REQUIRED",
    });
    expect(activity.executeDiscoveryRound).not.toHaveBeenCalled();
    expect(activity.finalizeGeneration).not.toHaveBeenCalled();
  });

  it("does not execute round 2 when its request fingerprint is repeated", async () => {
    const activity = activities();
    const round1 = input.rounds[0];
    const round2 = input.rounds[1];
    if (round1 === undefined || round2 === undefined) {
      throw new Error("Test input requires two rounds");
    }
    const result = await runRecommendationPoolV2Workflow(
      {
        ...input,
        rounds: [
          round1,
          {
            ...round2,
            requestFingerprint: "fingerprint-round-1",
          },
        ],
      },
      activity,
      hooks,
    );

    expect(activity.executeDiscoveryRound).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "partial_exhausted",
      discoveryTerminalReason: "PATHS_EXHAUSTED",
    });
  });

  it("stops on unknown charge without starting round 2", async () => {
    const activity = activities({
      executeDiscoveryRound: vi.fn(async (round) => ({
        round: round.round,
        requestFingerprint: round.requestFingerprint,
        chargeState: "unknown_charge" as const,
        costMicros: null,
        totalUniqueCandidateCount: 20,
        pathsExhausted: false,
        completedWindows: [],
      })),
    });

    const result = await runRecommendationPoolV2Workflow(
      input,
      activity,
      hooks,
    );

    expect(activity.executeDiscoveryRound).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      discoveryTerminalReason: "UNKNOWN_CHARGE",
      totalSettledCostMicros: 0,
    });
    expect(activity.activateGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ publicationOutcome: "READY" }),
    );
  });

  it.each([
    {
      name: "hard candidate limit",
      result: {
        totalUniqueCandidateCount: 1_000,
        completedWindows: [],
      },
      reason: "CANDIDATE_LIMIT_REACHED",
      status: "completed",
    },
    {
      name: "two low-yield windows",
      result: {
        totalUniqueCandidateCount: 4,
        completedWindows: [
          {
            completed: true,
            rawCandidateCount: 100,
            canonicalCandidateCount: 100,
            newUniqueCount: 4,
          },
          {
            completed: true,
            rawCandidateCount: 100,
            canonicalCandidateCount: 100,
            newUniqueCount: 0,
          },
        ],
      },
      reason: "LOW_YIELD",
      status: "partial_exhausted",
    },
  ])("stops after round 1 for $name", async ({ result, reason, status }) => {
    const activity = activities({
      executeDiscoveryRound: vi.fn(async (round) => ({
        round: round.round,
        requestFingerprint: round.requestFingerprint,
        chargeState: "settled" as const,
        costMicros: 500_000,
        pathsExhausted: false,
        ...result,
      })),
    });

    const outcome = await runRecommendationPoolV2Workflow(
      input,
      activity,
      hooks,
    );

    expect(activity.executeDiscoveryRound).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      status,
      discoveryTerminalReason: reason,
    });
  });

  it("settles context supersession before any provider side effect", async () => {
    const activity = activities();
    const supersession = {
      contractVersion: 2 as const,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      generationContractId: input.generationContractId,
      oldRecommendationContextVersionId: input.recommendationContextVersionId,
      authoritativeRecommendationContextVersionId: "context-2",
      reason: "PROJECT_CONTEXT_SUPERSEDED" as const,
    };

    const result = await runRecommendationPoolV2Workflow(input, activity, {
      ...hooks,
      readSupersession: () => supersession,
    });

    expect(result).toEqual({ status: "superseded" });
    expect(activity.executeDiscoveryRound).not.toHaveBeenCalled();
    expect(activity.finalizeGeneration).not.toHaveBeenCalled();
    expect(activity.completeGenerationSupersession).toHaveBeenCalledOnce();
  });

  it("settles supersession when an in-flight provider activity is cancelled", async () => {
    let supersession: ReturnType<typeof createSupersession> | undefined;
    const activity = activities({
      executeDiscoveryRound: vi.fn(async () => {
        supersession = createSupersession();
        throw new Error("TEMPORAL_ACTIVITY_CANCELLED");
      }),
    });

    const result = await runRecommendationPoolV2Workflow(input, activity, {
      ...hooks,
      readSupersession: () => supersession,
    });

    expect(result).toEqual({ status: "superseded" });
    expect(activity.finalizeGeneration).not.toHaveBeenCalled();
    expect(activity.completeGenerationSupersession).toHaveBeenCalledOnce();
    expect(activity.failGeneration).not.toHaveBeenCalled();
  });

  it("projects and returns an unexpected workflow failure as FAILED", async () => {
    const failure = new Error("PROVIDER_LEASE_LINEAGE_REJECTED");
    const activity = activities({
      executeDiscoveryRound: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      runRecommendationPoolV2Workflow(input, activity, hooks),
    ).resolves.toEqual({
      status: "failed",
      failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
      failureMessage: failure.message,
      failureRetryable: false,
    });

    expect(activity.failGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        generationContractId: input.generationContractId,
        jobId: input.jobId,
        failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
        failureMessage: failure.message,
        failureRetryable: false,
      }),
    );
  });

  it("persists an explicit retryable failure classification", async () => {
    const failure = Object.assign(new Error("PROVIDER_TEMPORARILY_UNAVAILABLE"), {
      retryable: true,
    });
    const activity = activities({
      executeDiscoveryRound: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      runRecommendationPoolV2Workflow(input, activity, hooks),
    ).resolves.toMatchObject({
      status: "failed",
      failureRetryable: true,
    });
    expect(activity.failGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ failureRetryable: true }),
    );
  });

  it("uses database time to force 24h terminal partial convergence", async () => {
    let inspected = 0;
    const inspect = vi.fn(async () => {
      inspected += 1;
      return inspected === 1
        ? {
            databaseNow: "2026-08-29T00:00:00.000Z",
            state: "PREPARING" as const,
            terminalBatchCount: 1,
            totalBatchCount: 2,
          }
        : {
            databaseNow: "2026-08-29T00:00:01.000Z",
            state: "AVAILABLE" as const,
            terminalBatchCount: 2,
            totalBatchCount: 2,
          };
    });
    const converge = vi.fn(async () => undefined);
    const activity = activities({
      inspectCanonicalBatchPreparation: inspect,
      convergeCanonicalBatchPreparation: converge,
    });

    await runRecommendationPoolV2Workflow(input, activity, hooks);

    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({
        batchIds: ["batch-1", "batch-2"],
        terminalReason: "COMPLETED_PARTIAL",
      }),
    );
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("keeps get-more on the repository-only edge with zero provider calls", async () => {
    const provider = vi.fn();
    const getMore = vi.fn(async () => ({
      state: "RELEASED" as const,
      currentBatchOrdinal: 1,
      releasedBatchOrdinal: 2,
      replayed: false,
    }));
    const commands = createRecommendationFeedCommands({
      getMore,
      setArchived: vi.fn(),
      generateSeeds: vi.fn(),
      validateSeeds: vi.fn(),
    });
    const context = {
      actor: { userId: "user-1", roles: ["member"] },
      tenant: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
      },
      project: { websiteProjectId: input.websiteProjectId },
    } as unknown as ResolvedProjectContext;

    await commands.getMore({
      context,
      idempotencyKey: "get-more-1",
      requestId: "request-1",
    });

    expect(getMore).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
  });

  it("builds release persistence with migration-aligned snapshot keys", () => {
    const common = {
      provider: "dataforseo",
      endpoint: "/v3/backlinks/summary/live",
      market: "US",
      location: "United States",
      language: "en",
      observedAt: "2026-08-28T00:00:00.000Z",
      requestRef: "provider-request-1",
      artifactRef: "artifact-1",
    };
    const persistence = buildRecommendationPoolV2ReleaseMetricPersistence({
      traffic: { ...common, value: 125.5 },
      rank: { ...common, value: 42 },
      spam: { ...common, value: null },
    });

    expect(persistence).toEqual(
      expect.objectContaining({
        traffic_snapshot_ref: "artifact-1",
        rank_snapshot_ref: "artifact-1",
        spam_snapshot_ref: "artifact-1",
        traffic_organic_etv: 125.5,
        authority_rank: 42,
        spam_score: null,
        traffic_snapshot: expect.objectContaining({
          market: "US",
          language: "en",
          observedAt: "2026-08-28T00:00:00.000Z",
          provider: "dataforseo",
          endpoint: "/v3/backlinks/summary/live",
          requestRef: "provider-request-1",
          artifactRef: "artifact-1",
        }),
      }),
    );
  });

  it("refuses release persistence without a request or artifact reference", () => {
    const evidence = {
      value: null,
      provider: "dataforseo",
      endpoint: "/v3/backlinks/summary/live",
      market: "US",
      location: "United States",
      language: "en",
      observedAt: "2026-08-28T00:00:00.000Z",
    };

    expect(() =>
      buildRecommendationPoolV2ReleaseMetricPersistence({
        traffic: evidence,
        rank: evidence,
        spam: evidence,
      }),
    ).toThrow("requires requestRef or artifactRef");
  });
});

function createSupersession() {
  return {
    contractVersion: 2 as const,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    generationContractId: input.generationContractId,
    oldRecommendationContextVersionId: input.recommendationContextVersionId,
    authoritativeRecommendationContextVersionId: "context-2",
    reason: "PROJECT_CONTEXT_SUPERSEDED" as const,
  };
}
