import { describe, expect, it } from "vitest";

import {
  decideRecommendationSecondRound,
  hasConsecutiveRecommendationLowYield,
  isRecommendationContactTerminal,
  recommendationDiscoveryBudgetPolicyVersion,
  recommendationPoolV2OperationalPolicy,
  recommendationPoolV2OperationalPolicyVersion,
  resolveRecommendationContactTerminalReason,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-v2-policy.js";

describe("recommendation pool V2 policy", () => {
  const round1Request = {
    canonicalRequestFingerprint: "request:round-1",
    keywordFingerprint: "keywords:commercial",
    competitorFingerprint: "competitors:primary",
    sourceType: "ranked_keywords",
    pageType: "domain",
    strategyVersion: "strategy.v1",
    countryCode: "US",
    languageCode: "en",
    businessDirectionFingerprint: "business:project-snapshot",
    authorizedCostMicros: 1_000_000,
  } as const;

  const round2Request = {
    ...round1Request,
    canonicalRequestFingerprint: "request:round-2",
    sourceType: "competitor_backlinks",
  } as const;

  const decisionInput = {
    policyVersion: recommendationDiscoveryBudgetPolicyVersion,
    round1UniqueCandidateCount: 40,
    round1SettledCostMicros: 1_000_000,
    generationSettledCostMicros: 1_000_000,
    chargeState: "settled",
    pathsExhausted: false,
    contextSuperseded: false,
    round1Request,
    round2Request,
    completedWindows: [] as const,
  } as const;

  it("freezes bounded V2 discovery and contact operational defaults", () => {
    expect(recommendationPoolV2OperationalPolicy).toEqual({
      version: recommendationPoolV2OperationalPolicyVersion,
      discovery: {
        maximumPaidRequests: 25,
        maximumRowsPerRequest: 100,
        rawObservationLimit: 2_500,
      },
      contactPreparation: {
        batchPreparationDeadlineHours: 24,
        pollIntervalMs: 900_000,
        maxPages: 8,
        maxDepth: 2,
        maxAttempts: 3,
        retryDelayMs: 30_000,
        staticFetchTimeoutMs: 12_000,
        browserWorkerTimeoutMs: 20_000,
        activityTimeoutMs: 480_000,
      },
    });
    expect(
      recommendationPoolV2OperationalPolicy.discovery.maximumPaidRequests
        * recommendationPoolV2OperationalPolicy.discovery.maximumRowsPerRequest,
    ).toBe(
      recommendationPoolV2OperationalPolicy.discovery.rawObservationLimit,
    );
  });

  it("requires two completed canonical-deduped low-yield windows", () => {
    expect(
      hasConsecutiveRecommendationLowYield([
        {
          completed: true,
          rawCandidateCount: 1_000,
          canonicalCandidateCount: 100,
          newUniqueCount: 4,
        },
      ]),
    ).toBe(false);
    expect(
      hasConsecutiveRecommendationLowYield([
        {
          completed: true,
          rawCandidateCount: 1_000,
          canonicalCandidateCount: 100,
          newUniqueCount: 4,
        },
        {
          completed: false,
          rawCandidateCount: 1_000,
          canonicalCandidateCount: 10,
          newUniqueCount: 0,
        },
        {
          completed: true,
          rawCandidateCount: 800,
          canonicalCandidateCount: 80,
          newUniqueCount: 3,
        },
      ]),
    ).toBe(true);
    expect(
      hasConsecutiveRecommendationLowYield([
        {
          completed: true,
          rawCandidateCount: 1_000,
          canonicalCandidateCount: 100,
          newUniqueCount: 4,
        },
        {
          completed: true,
          rawCandidateCount: 800,
          canonicalCandidateCount: 80,
          newUniqueCount: 4,
        },
      ]),
    ).toBe(false);
  });

  it("authorizes round two at the exact one-dollar round boundaries", () => {
    expect(decideRecommendationSecondRound(decisionInput)).toEqual({
      kind: "START_ROUND_2",
      policyVersion: recommendationDiscoveryBudgetPolicyVersion,
      round: 2,
      authorizedCostMicros: 1_000_000,
      canonicalRequestFingerprint: "request:round-2",
    });
  });

  it("rejects a round authorization above one dollar", () => {
    expect(() =>
      decideRecommendationSecondRound({
        ...decisionInput,
        round1Request: {
          ...round1Request,
          authorizedCostMicros: 1_000_001,
        },
      }),
    ).toThrow(/round 1 authorized cost/i);
    expect(() =>
      decideRecommendationSecondRound({
        ...decisionInput,
        round2Request: {
          ...round2Request,
          authorizedCostMicros: 1_000_001,
        },
      }),
    ).toThrow(/round 2 authorized cost/i);
  });

  it("fails closed for unknown or ambiguous settled charge", () => {
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        chargeState: "unknown_charge",
      }),
    ).toMatchObject({ kind: "STOP", reason: "UNKNOWN_CHARGE" });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        chargeState: "ambiguous_charge",
      }),
    ).toMatchObject({ kind: "STOP", reason: "UNKNOWN_CHARGE" });
  });

  it("requires a different canonical fingerprint and discovery dimension", () => {
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        round2Request: {
          ...round1Request,
          canonicalRequestFingerprint:
            round1Request.canonicalRequestFingerprint,
        },
      }),
    ).toMatchObject({ kind: "STOP", reason: "PATHS_EXHAUSTED" });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        round2Request: {
          ...round1Request,
          canonicalRequestFingerprint: "request:different-bytes-only",
        },
      }),
    ).toMatchObject({ kind: "STOP", reason: "PATHS_EXHAUSTED" });
  });

  it.each([
    ["countryCode", "GB"],
    ["languageCode", "de"],
    ["businessDirectionFingerprint", "business:changed"],
  ] as const)(
    "fails closed when round two changes protected %s",
    (field, value) => {
      expect(
        decideRecommendationSecondRound({
          ...decisionInput,
          round2Request: {
            ...round2Request,
            [field]: value,
          },
        }),
      ).toMatchObject({ kind: "STOP", reason: "REQUEST_SCOPE_CHANGED" });
    },
  );

  it("stops on cumulative budget, safe supply, hard cap, paths, and low yield", () => {
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        generationSettledCostMicros: 1_000_001,
      }),
    ).toMatchObject({ kind: "STOP", reason: "BUDGET_EXHAUSTED" });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        round1UniqueCandidateCount: 100,
      }),
    ).toMatchObject({ kind: "STOP", reason: "SAFE_SUPPLY_REACHED" });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        round1UniqueCandidateCount: 1_000,
      }),
    ).toEqual({
      kind: "STOP",
      reason: "CANDIDATE_LIMIT_REACHED",
      terminalFacts: {
        policyVersion: recommendationDiscoveryBudgetPolicyVersion,
        reason: "CANDIDATE_LIMIT_REACHED",
        uniqueCandidateCount: 1_000,
        settledCostMicros: 1_000_000,
        completedWindowCount: 0,
      },
    });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        pathsExhausted: true,
      }),
    ).toMatchObject({ kind: "STOP", reason: "PATHS_EXHAUSTED" });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        completedWindows: [
          {
            completed: true,
            rawCandidateCount: 1_000,
            canonicalCandidateCount: 100,
            newUniqueCount: 4,
          },
          {
            completed: true,
            rawCandidateCount: 500,
            canonicalCandidateCount: 100,
            newUniqueCount: 3,
          },
        ],
      }),
    ).toMatchObject({ kind: "STOP", reason: "LOW_YIELD" });
  });

  it("stops when settled generation cost is exactly at the cumulative cap", () => {
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        generationSettledCostMicros: 2_000_000,
        round2Request: {
          ...round2Request,
          authorizedCostMicros: 0,
        },
      }),
    ).toMatchObject({ kind: "STOP", reason: "BUDGET_EXHAUSTED" });
  });

  it("fails closed when settled generation cost exceeds the cumulative cap", () => {
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        generationSettledCostMicros: 2_000_001,
        round2Request: {
          ...round2Request,
          authorizedCostMicros: 0,
        },
      }),
    ).toMatchObject({ kind: "STOP", reason: "BUDGET_EXHAUSTED" });
  });

  it("prioritizes the cumulative budget terminal over paths and null requests", () => {
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        generationSettledCostMicros: 2_000_000,
        pathsExhausted: true,
      }),
    ).toMatchObject({ kind: "STOP", reason: "BUDGET_EXHAUSTED" });
    expect(
      decideRecommendationSecondRound({
        ...decisionInput,
        generationSettledCostMicros: 2_000_000,
        round2Request: null,
      }),
    ).toMatchObject({ kind: "STOP", reason: "BUDGET_EXHAUSTED" });
  });

  it("requires the generation-pinned policy version", () => {
    expect(() =>
      decideRecommendationSecondRound({
        ...decisionInput,
        policyVersion: "recommendation-discovery-budget.future",
      }),
    ).toThrow(/policy version/i);
  });

  it("recognizes only real contact terminal states", () => {
    expect(isRecommendationContactTerminal("completed")).toBe(true);
    expect(isRecommendationContactTerminal("partially_completed")).toBe(true);
    expect(isRecommendationContactTerminal("no_contact_found")).toBe(true);
    expect(isRecommendationContactTerminal("stale_context")).toBe(true);
    expect(isRecommendationContactTerminal("pending")).toBe(false);
    expect(isRecommendationContactTerminal("running")).toBe(false);
    expect(isRecommendationContactTerminal("retry_scheduled")).toBe(false);
  });

  it("uses a real partial terminal reason only after the deadline", () => {
    expect(
      resolveRecommendationContactTerminalReason({
        status: "retry_scheduled",
        terminalReasonCode: null,
        deadlineReached: false,
      }),
    ).toBeNull();
    expect(
      resolveRecommendationContactTerminalReason({
        status: "retry_scheduled",
        terminalReasonCode: null,
        deadlineReached: true,
      }),
    ).toBe("COMPLETED_PARTIAL");
  });
});
