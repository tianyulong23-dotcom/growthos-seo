import { describe, expect, it } from "vitest";

import type { EvidenceValue } from "../../src/modules/backlinks/domain/evidence/evidence.js";
import {
  evaluateRecommendationGates,
  recommendationGateRuleIds,
  recommendationGateRuleVersion,
  type RecommendationGateRuleId,
  type RecommendationRuleFacts,
} from "../../src/modules/backlinks/domain/recommendations/gates.js";

function observed(value: boolean, evidenceRef: string): EvidenceValue<boolean> {
  return {
    availability: "observed",
    value,
    sourceType: "recommendation_evidence",
    sourceReleaseId: "dataforseo-2026-07-25",
    confidence: 0.95,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: [evidenceRef],
  };
}

function unavailable(evidenceRef: string): EvidenceValue<boolean> {
  return {
    availability: "unavailable",
    reason: "partial_scan",
    sourceType: "recommendation_evidence",
    sourceReleaseId: "dataforseo-2026-07-25",
    confidence: 0,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: [evidenceRef],
  };
}

function facts(
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

describe("recommendation hard gates", () => {
  it("returns Ready only when every hard gate has usable negative evidence", () => {
    expect(evaluateRecommendationGates(facts())).toEqual({
      decision: "ready",
      ruleVersion: recommendationGateRuleVersion,
      hitRules: [],
      missingEvidenceKeys: [],
    });
  });

  it.each(recommendationGateRuleIds)(
    "never returns Ready when %s matches",
    (ruleId) => {
      const evidence = observed(true, `gate:${ruleId}`);
      expect(evaluateRecommendationGates(facts({
        [ruleId]: evidence,
      }))).toMatchObject({
        decision: "excluded",
        ruleVersion: recommendationGateRuleVersion,
        hitRules: [{
          ruleId,
          evidenceKey: `gate.${ruleId}`,
          evidence,
        }],
      });
    },
  );

  it("returns hits in severe-first canonical order", () => {
    const decision = evaluateRecommendationGates(facts({
      duplicate_domain: observed(true, "gate:duplicate"),
      unsafe_or_malicious: observed(true, "gate:unsafe"),
      workspace_suppressed: observed(true, "gate:workspace"),
    }));

    expect(decision.hitRules.map(({ ruleId }) => ruleId)).toEqual([
      "unsafe_or_malicious",
      "workspace_suppressed",
      "duplicate_domain",
    ]);
  });

  it("returns insufficient_data for unavailable or stale gate evidence", () => {
    const missing = evaluateRecommendationGates(facts({
      high_confidence_pbn_or_link_farm: unavailable("gate:pbn"),
    }));
    const stale = evaluateRecommendationGates(facts({
      crawl_not_permitted: {
        ...observed(false, "gate:crawl"),
        stale: true,
      },
    }));

    expect(missing).toMatchObject({
      decision: "insufficient_data",
      missingEvidenceKeys: ["gate.high_confidence_pbn_or_link_farm"],
    });
    expect(stale).toMatchObject({
      decision: "insufficient_data",
      missingEvidenceKeys: ["gate.crawl_not_permitted"],
    });
  });

  it("lets a proven exclusion win over unrelated missing evidence", () => {
    expect(evaluateRecommendationGates(facts({
      unsafe_or_malicious: observed(true, "gate:unsafe"),
      duplicate_domain: unavailable("gate:duplicate"),
    }))).toMatchObject({
      decision: "excluded",
      missingEvidenceKeys: ["gate.duplicate_domain"],
    });
  });

  it("validates, copies, and freezes gate evidence", () => {
    const invalid = observed(true, "gate:unsafe");
    expect(() => evaluateRecommendationGates(facts({
      unsafe_or_malicious: { ...invalid, evidenceRefs: [] },
    }))).toThrow(TypeError);

    const decision = evaluateRecommendationGates(facts({
      unsafe_or_malicious: invalid,
    }));
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.hitRules)).toBe(true);
    expect(Object.isFrozen(decision.hitRules[0]?.evidence)).toBe(true);
    expect(Object.isFrozen(
      decision.hitRules[0]?.evidence.evidenceRefs,
    )).toBe(true);
  });
});
