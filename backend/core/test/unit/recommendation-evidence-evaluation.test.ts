import { describe, expect, it } from "vitest";

import type { EvidenceValue } from "../../src/modules/backlinks/domain/evidence/evidence.js";
import {
  evaluateRecommendationCandidate,
  prepareReadyRecommendationRefill,
  type RecommendationEvidenceCandidate,
} from "../../src/modules/backlinks/domain/recommendations/evaluation.js";
import type {
  RecommendationGateRuleId,
  RecommendationRuleFacts,
} from "../../src/modules/backlinks/domain/recommendations/gates.js";
import type {
  RecommendationScoreComponentId,
  RecommendationScoreComponentInput,
} from "../../src/modules/backlinks/domain/recommendations/scoring.js";

const sourceReleaseId = "dataforseo-2026-07-25";
const evidencePolicyVersion = "recommendation-evidence-policy.v1";

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

function gateFacts(
  overrides: Partial<Record<RecommendationGateRuleId, EvidenceValue<boolean>>>
  = {},
): RecommendationRuleFacts {
  const noMatch = (ruleId: RecommendationGateRuleId) => ({
    evidenceKey: `gate.${ruleId}`,
    result: observed(false, `gate:${ruleId}`),
  });

  return {
    unsafe_or_malicious: noMatch("unsafe_or_malicious"),
    high_confidence_pbn_or_link_farm:
      noMatch("high_confidence_pbn_or_link_farm"),
    crawl_not_permitted: noMatch("crawl_not_permitted"),
    user_suppressed: noMatch("user_suppressed"),
    workspace_suppressed: noMatch("workspace_suppressed"),
    platform_suppressed: noMatch("platform_suppressed"),
    existing_backlink: noMatch("existing_backlink"),
    already_joined: noMatch("already_joined"),
    previously_excluded: noMatch("previously_excluded"),
    market_mismatch: noMatch("market_mismatch"),
    duplicate_domain: noMatch("duplicate_domain"),
    ...Object.fromEntries(
      Object.entries(overrides).map(([ruleId, result]) => [
        ruleId,
        { evidenceKey: `gate.${ruleId}`, result },
      ]),
    ),
  } as RecommendationRuleFacts;
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
  return Object.entries(componentValues).map(([id, value]) => {
    const componentId = id as RecommendationScoreComponentId;
    return {
      id: componentId,
      evidence: overrides[componentId]
        ?? observed(value, `score:${componentId}`),
      normalizedValue: overrides[componentId]?.availability === "unavailable"
        ? null
        : value,
      normalizationRuleVersion: "recommendation-normalization.v1",
      reasonCode: `SUPPORTED_${componentId.toUpperCase()}`,
    };
  });
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
    gates: options.gates ?? gateFacts(),
    components: options.components ?? components(),
  };
}

describe("recommendation evidence evaluation", () => {
  it("applies severe gates before scoring, even with missing score evidence", () => {
    const decision = evaluateRecommendationCandidate(candidate(
      "unsafe.com",
      {
        gates: gateFacts({
          unsafe_or_malicious: observed(true, "safety:unsafe.example"),
        }),
        components: components({
          technical_health: unavailable("crawl:unsafe.example"),
        }),
      },
    ));

    expect(decision.decision).toBe("excluded");
    expect(decision.gateDecision.hitRules[0]?.ruleId).toBe(
      "unsafe_or_malicious",
    );
    expect(decision.score).toBeNull();
  });

  it("keeps insufficient evidence out of Ready and produces stable ordering", () => {
    const incomplete = candidate("missing.com", {
      components: components({
        graph_authority_diversity: unavailable("graph:missing.example"),
      }),
    });
    const alpha = candidate("alpha.com");
    const zeta = candidate("zeta.com");

    expect(evaluateRecommendationCandidate(incomplete)).toMatchObject({
      decision: "insufficient_data",
      score: null,
      missingEvidenceKeys: ["score.graph_authority_diversity"],
    });

    const first = prepareReadyRecommendationRefill({
      candidates: [zeta, incomplete, alpha],
      requestedCount: 10,
    });
    const second = prepareReadyRecommendationRefill({
      candidates: [alpha, incomplete, zeta],
      requestedCount: 10,
    });

    expect(first.ready.map(({ hostnameAscii }) => hostnameAscii)).toEqual([
      "alpha.com",
      "zeta.com",
    ]);
    expect(second.ready.map(({ hostnameAscii }) => hostnameAscii)).toEqual(
      first.ready.map(({ hostnameAscii }) => hostnameAscii),
    );
    expect(first.counts).toEqual({
      evaluated: 3,
      ready: 2,
      excluded: 0,
      insufficientData: 1,
    });
  });

  it("rejects gate evidence from a different source release", () => {
    expect(() => evaluateRecommendationCandidate(candidate("mixed.com", {
      gates: gateFacts({
        duplicate_domain: {
          ...observed(false, "gate:mixed"),
          sourceReleaseId: "dataforseo-2026-07-26",
        },
      }),
    }))).toThrow("mixed source release");
  });
});
