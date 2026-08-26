import { describe, expect, it } from "vitest";

import {
  buildCommercialRefillWindowKey,
  calculateCommercialSupplySampleSize,
  commercialRefillTiers,
  nextCommercialRefillTier,
  parseCommercialRefillAttempts,
  parseCommercialRefillWindowKey,
  planCommercialSupplyOperation,
  type CommercialRefillAttempt,
} from "../../src/modules/backlinks/domain/recommendations/commercial-refill-cycle.js";

const basePlan = {
  projectContextReady: true,
  targetPublishedCount: 10,
  publishedCount: 2,
  rawCandidateCount: 40,
  fitCandidateCount: 10,
  readyFitCandidateCount: 0,
  contactReadyCount: 5,
  providerState: "available" as const,
  paidCursor: {
    tier: "exact_product_target_market" as const,
    round: 1,
  },
  resourceCursor: {
    tier: "curated_resource_library" as const,
    round: 1,
  },
  attempts: [] as readonly CommercialRefillAttempt[],
  candidateLimit: 200,
};

function emptyAttempt(
  tier: CommercialRefillAttempt["tier"],
  window: number,
  round = 1,
): CommercialRefillAttempt {
  return {
    tier,
    round,
    window,
    rawCandidateCount: 20,
    eligibleCandidateCount: 0,
  };
}

function zeroRawRound(round: number): readonly CommercialRefillAttempt[] {
  return commercialRefillTiers.flatMap((tier) => [
    { ...emptyAttempt(tier, 1, round), rawCandidateCount: 0 },
    { ...emptyAttempt(tier, 2, round), rawCandidateCount: 0 },
  ]);
}

describe("commercial recommendation refill cycle", () => {
  it("builds a deterministic project/context/tier/round/window key", () => {
    const key = buildCommercialRefillWindowKey({
      websiteProjectId: "project-1",
      projectContextVersionId: "context-1",
      visiblePoolGeneration: 2,
      tier: "same_topic_target_market",
      round: 3,
      window: 4,
    });

    expect(key).toBe("commercial-refill:project-1:context-1:g2:t2:r3:w4");
    expect(parseCommercialRefillWindowKey(key)).toEqual({
      websiteProjectId: "project-1",
      projectContextVersionId: "context-1",
      visiblePoolGeneration: 2,
      tier: "same_topic_target_market",
      round: 3,
      window: 4,
    });
  });

  it("keeps legacy keys and attempts readable as window one", () => {
    expect(
      parseCommercialRefillWindowKey(
        "commercial-refill:project-1:context-1:t1:r1",
      ),
    ).toMatchObject({ visiblePoolGeneration: 1, window: 1 });
    expect(
      parseCommercialRefillAttempts([
        { tier: "exact_product_target_market", round: 1 },
        { tier: "invalid", round: 1 },
        { tier: "same_topic_target_market", round: 0 },
      ]),
    ).toEqual([
      {
        tier: "exact_product_target_market",
        round: 1,
        window: 1,
      },
    ]);
  });

  it("runs the existing resource tier before five paid tiers", () => {
    expect(commercialRefillTiers).toHaveLength(6);
    expect(commercialRefillTiers[0]).toBe("curated_resource_library");
    expect(nextCommercialRefillTier("curated_resource_library")).toBe(
      "exact_product_target_market",
    );
    expect(nextCommercialRefillTier("same_language_expansion")).toBeNull();
  });

  it("reuses an unfinished window on planning retries", () => {
    const attempts = [
      {
        tier: "exact_product_target_market" as const,
        round: 1,
        window: 1,
      },
    ];

    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        attempts,
      }),
    ).toMatchObject({
      kind: "execute",
      source: "paid",
      cursor: {
        tier: "exact_product_target_market",
        round: 1,
        window: 1,
      },
    });
  });

  it("advances only after two consecutive windows add no eligible domains", () => {
    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        attempts: [
          emptyAttempt("curated_resource_library", 1),
          emptyAttempt("curated_resource_library", 2),
          emptyAttempt("exact_product_target_market", 1),
        ],
      }),
    ).toMatchObject({
      kind: "execute",
      cursor: {
        tier: "exact_product_target_market",
        window: 2,
      },
    });

    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        attempts: [
          emptyAttempt("curated_resource_library", 1),
          emptyAttempt("curated_resource_library", 2),
          emptyAttempt("exact_product_target_market", 1),
          emptyAttempt("exact_product_target_market", 2),
        ],
      }),
    ).toMatchObject({
      kind: "execute",
      source: "paid",
      cursor: {
        tier: "same_topic_target_market",
        round: 1,
        window: 1,
      },
    });
  });

  it("sizes later windows from the observed full-funnel conversion", () => {
    const weak = calculateCommercialSupplySampleSize({
      targetPublishedCount: 10,
      publishedCount: 4,
      rawCandidateCount: 100,
      fitCandidateCount: 20,
      contactReadyCount: 4,
      candidateLimit: 500,
    });
    const strong = calculateCommercialSupplySampleSize({
      targetPublishedCount: 10,
      publishedCount: 4,
      rawCandidateCount: 40,
      fitCandidateCount: 24,
      contactReadyCount: 12,
      candidateLimit: 500,
    });

    expect(weak.requestedCandidateCount).toBeGreaterThan(
      strong.requestedCandidateCount,
    );
    expect(strong.rawToFitRate).toBeGreaterThan(weak.rawToFitRate);
    expect(strong.fitToContactRate).toBeGreaterThan(weak.fitToContactRate);
  });

  it("uses resources during a paid pause and preserves the paid cursor", () => {
    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        providerState: "budget_paused",
      }),
    ).toMatchObject({
      kind: "execute",
      source: "resource",
      cursor: {
        tier: "curated_resource_library",
        round: 1,
        window: 1,
      },
    });

    expect(planCommercialSupplyOperation(basePlan)).toMatchObject({
      kind: "execute",
      source: "resource",
      cursor: {
        tier: "curated_resource_library",
        round: 1,
        window: 1,
      },
    });
  });

  it("moves to paid discovery after the curated source is exhausted", () => {
    expect(planCommercialSupplyOperation({
      ...basePlan,
      attempts: [
        emptyAttempt("curated_resource_library", 1),
        emptyAttempt("curated_resource_library", 2),
      ],
    })).toMatchObject({
      kind: "execute",
      source: "paid",
      cursor: {
        tier: "exact_product_target_market",
        round: 1,
        window: 1,
      },
    });
  });

  it("reuses already assessed eligible candidates before any supply call", () => {
    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        readyFitCandidateCount: 3,
        providerState: "budget_paused",
      }),
    ).toMatchObject({
      kind: "execute",
      source: "existing",
      requestedCandidateCount: 3,
    });
  });

  it("starts a broader persisted round after both supplies stop below target", () => {
    const exhaustedAttempts = [
      emptyAttempt("same_language_expansion", 1),
      emptyAttempt("same_language_expansion", 2),
      emptyAttempt("curated_resource_library", 1),
      emptyAttempt("curated_resource_library", 2),
    ];
    const exhausted = {
      ...basePlan,
      paidCursor: {
        tier: "same_language_expansion" as const,
        round: 1,
      },
      attempts: exhaustedAttempts,
    };

    expect(planCommercialSupplyOperation(exhausted)).toEqual({
      kind: "execute",
      source: "resource",
      cursor: {
        tier: "curated_resource_library",
        round: 2,
        window: 1,
      },
      requestedCandidateCount: expect.any(Number),
    });
  });

  it("stops after two complete rounds return no raw supply", () => {
    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        paidCursor: {
          tier: "same_language_expansion",
          round: 3,
        },
        resourceCursor: {
          tier: "curated_resource_library",
          round: 3,
        },
        attempts: [...zeroRawRound(1), ...zeroRawRound(2)],
      }),
    ).toEqual({
      kind: "complete",
      outcome: "SUPPLY_FLOOR_REACHED",
    });
  });

  it("returns only the external project-context and target outcomes", () => {
    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        projectContextReady: false,
      }),
    ).toEqual({
      kind: "wait",
      outcome: "PROJECT_CONTEXT_REQUIRED",
      reason: "project_context",
    });
    expect(
      planCommercialSupplyOperation({
        ...basePlan,
        publishedCount: 10,
      }),
    ).toEqual({
      kind: "complete",
      outcome: "TARGET_REACHED",
    });
  });
});
