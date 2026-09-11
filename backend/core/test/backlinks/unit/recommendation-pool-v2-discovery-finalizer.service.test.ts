import { describe, expect, it } from "vitest";

import {
  decideRecommendationPoolV2DiscoveryCompletion,
  type RecommendationPoolV2DiscoveryCompletionState,
  type RecommendationPoolV2ProposedRound2Path,
} from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-discovery-finalizer.service.js";
import { recommendationDiscoveryBudgetPolicyVersion } from "../../../src/modules/backlinks/domain/recommendations/recommendation-pool-v2-policy.js";

const round1Path = {
  canonicalRequestFingerprint: "request:round-1",
  canonicalPathFingerprint: "path:round-1",
  keywordFingerprint: "seed:commercial",
  competitorFingerprint: "seed:commercial",
  sourceType: "ranked_keywords",
  pageType: "domain",
  strategyVersion: "strategy.v1",
  countryCode: "US",
  languageCode: "en",
  businessDirectionFingerprint: "business:project-snapshot",
  authorizedCostMicros: 1_000_000,
} as const;

const round2Path = {
  ...round1Path,
  canonicalRequestFingerprint: "request:round-2",
  canonicalPathFingerprint: "path:round-2",
  sourceType: "competitor_backlinks",
} as const;

const baseState: RecommendationPoolV2DiscoveryCompletionState = {
  policyVersion: recommendationDiscoveryBudgetPolicyVersion,
  activeRound: 1,
  rounds: [
    {
      roundNumber: 1,
      requestPlan: round1Path,
      canonicalRequestFingerprints: [round1Path.canonicalRequestFingerprint],
      canonicalPathFingerprints: [round1Path.canonicalPathFingerprint],
      completedWindowCount: 1,
      completedRequestCount: 1,
      rawCandidateCount: 50,
      effectiveCandidateCount: 40,
      newUniqueCount: 30,
      duplicateCount: 10,
      authorizedCostMicros: 1_000_000,
      settledCostMicros: 1_000_000,
      chargeState: "SETTLED",
      completedAt: "2026-08-29T00:02:00.000Z",
    },
  ],
  completedWindows: [
    {
      completed: true,
      rawCandidateCount: 50,
      canonicalCandidateCount: 40,
      newUniqueCount: 30,
    },
  ],
  canonicalRequestSetFingerprint: "generation:set:round-1",
};
const baseRound = baseState.rounds[0];
if (baseRound === undefined) {
  throw new Error("The finalizer test fixture requires a completed Round 1.");
}

function decide(
  state: RecommendationPoolV2DiscoveryCompletionState = baseState,
  proposedRound2Path: RecommendationPoolV2ProposedRound2Path | null = round2Path,
) {
  return decideRecommendationPoolV2DiscoveryCompletion({
    state,
    proposedRound2Path,
    contextSuperseded: false,
  });
}

describe("recommendation pool V2 discovery finalizer policy", () => {
  it("returns a Round 2 plan only through the pinned B1 policy", () => {
    expect(decide()).toEqual({
      kind: "START_ROUND_2",
      policyVersion: recommendationDiscoveryBudgetPolicyVersion,
      round: 2,
      authorizedCostMicros: 1_000_000,
      canonicalRequestFingerprint: "request:round-2",
      canonicalPathFingerprint: "path:round-2",
      changedDimensions: ["SOURCE"],
    });
  });

  it("does not infer a keyword change from different Blueprint request bytes", () => {
    const blueprintRound1 = {
      ...round1Path,
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
    };
    const blueprintRound2 = {
      ...blueprintRound1,
      canonicalRequestFingerprint: "request:blueprint-round-2",
      canonicalPathFingerprint: "path:blueprint-round-2",
    };
    expect(
      decide(
        {
          ...baseState,
          rounds: [{
            ...baseRound,
            requestPlan: blueprintRound1,
            canonicalRequestFingerprints: [
              blueprintRound1.canonicalRequestFingerprint,
            ],
            canonicalPathFingerprints: [
              blueprintRound1.canonicalPathFingerprint,
            ],
          }],
        },
        blueprintRound2,
      ),
    ).toMatchObject({
      kind: "STOP",
      reason: "PATHS_EXHAUSTED",
    });
  });

  it("starts Blueprint Round 2 when the keyword fingerprint actually changes", () => {
    const blueprintRound1 = {
      ...round1Path,
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
    };
    const blueprintRound2 = {
      ...blueprintRound1,
      canonicalRequestFingerprint: "request:blueprint-round-2",
      canonicalPathFingerprint: "path:blueprint-round-2",
      keywordFingerprint: "keyword:round-2",
    };

    expect(
      decide(
        {
          ...baseState,
          rounds: [{
            ...baseRound,
            requestPlan: blueprintRound1,
            canonicalRequestFingerprints: [
              blueprintRound1.canonicalRequestFingerprint,
            ],
            canonicalPathFingerprints: [
              blueprintRound1.canonicalPathFingerprint,
            ],
          }],
        },
        blueprintRound2,
      ),
    ).toMatchObject({
      kind: "START_ROUND_2",
      changedDimensions: ["KEYWORD"],
    });
  });

  it.each([
    {
      label: "request fingerprint",
      proposed: {
        ...round2Path,
        canonicalRequestFingerprint: round1Path.canonicalRequestFingerprint,
      },
    },
    {
      label: "path fingerprint",
      proposed: {
        ...round2Path,
        canonicalPathFingerprint: round1Path.canonicalPathFingerprint,
      },
    },
    {
      label: "unchanged semantic dimensions",
      proposed: {
        ...round1Path,
        canonicalRequestFingerprint: "request:new-bytes-only",
        canonicalPathFingerprint: "path:new-bytes-only",
      },
    },
  ])("stops when the proposed Round 2 $label is not new", ({ proposed }) => {
    expect(decide(baseState, proposed)).toMatchObject({
      kind: "STOP",
      reason: "PATHS_EXHAUSTED",
    });
  });

  it.each([
    ["countryCode", "GB"],
    ["languageCode", "de"],
    ["businessDirectionFingerprint", "business:changed"],
  ] as const)(
    "fails closed when Round 2 changes protected %s",
    (field, value) => {
      expect(
        decide(baseState, {
          ...round2Path,
          [field]: value,
        }),
      ).toMatchObject({
        kind: "STOP",
        reason: "REQUEST_SCOPE_CHANGED",
      });
    },
  );

  it("fails closed for persisted unknown charge", () => {
    expect(
      decide({
        ...baseState,
        rounds: [
          {
            ...baseRound,
            settledCostMicros: null,
            chargeState: "UNKNOWN_CHARGE",
          },
        ],
      }),
    ).toMatchObject({ kind: "STOP", reason: "UNKNOWN_CHARGE" });
  });

  it.each([
    [100, "SAFE_SUPPLY_REACHED"],
    [1_000, "CANDIDATE_LIMIT_REACHED"],
  ] as const)(
    "stops at persisted unique supply %i",
    (newUniqueCount, reason) => {
      expect(
        decide({
          ...baseState,
          rounds: [
            {
              ...baseRound,
              rawCandidateCount: newUniqueCount,
              effectiveCandidateCount: newUniqueCount,
              newUniqueCount,
              duplicateCount: 0,
            },
          ],
        }),
      ).toMatchObject({ kind: "STOP", reason });
    },
  );

  it("stops only after two persisted completed low-yield windows", () => {
    expect(
      decide({
        ...baseState,
        rounds: [
          {
            ...baseRound,
            rawCandidateCount: 200,
            effectiveCandidateCount: 200,
            newUniqueCount: 7,
            duplicateCount: 193,
          },
        ],
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
            newUniqueCount: 3,
          },
        ],
      }),
    ).toMatchObject({ kind: "STOP", reason: "LOW_YIELD" });
  });

  it("stops Round 2 at the cumulative budget before path exhaustion", () => {
    expect(
      decide(
        {
          ...baseState,
          activeRound: 2,
          rounds: [
            baseRound,
            {
              ...baseRound,
              roundNumber: 2,
              requestPlan: round2Path,
              canonicalRequestFingerprints: [
                round2Path.canonicalRequestFingerprint,
              ],
              canonicalPathFingerprints: [round2Path.canonicalPathFingerprint],
              settledCostMicros: 1_000_000,
            },
          ],
        },
        null,
      ),
    ).toMatchObject({ kind: "STOP", reason: "BUDGET_EXHAUSTED" });
  });

  it("stops when no feasible Round 2 path remains", () => {
    expect(decide(baseState, null)).toMatchObject({
      kind: "STOP",
      reason: "PATHS_EXHAUSTED",
    });
  });
});
