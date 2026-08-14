import { describe, expect, it } from "vitest";

import {
  commercialHardGateIds,
  commercialScoreComponentIds,
  commercialScoreWeights,
  rankCommercialRecommendations,
  scoreCommercialRecommendation,
} from "../../src/modules/backlinks/domain/recommendations/commercial-score.js";

const gates = () => commercialHardGateIds.map((id) => ({
  id,
  state: "observed" as const,
  matched: false,
  evidenceRefs: [`gate:${id}`],
}));
const components = () => commercialScoreComponentIds.map((id) => ({
  id,
  state: "observed" as const,
  rawValue: 0.8,
  normalizedValue: 0.8,
  evidenceRefs: [`score:${id}`],
  collectedAt: "2026-08-06T00:00:00.000Z",
  normalizationRuleVersion: "commercial-normalization.v1",
}));

describe("commercial recommendation score v2", () => {
  it("uses the fixed seven-component 100 point policy", () => {
    const result = scoreCommercialRecommendation({
      gates: gates(),
      components: components(),
    });

    expect(result.decision).toBe("ready");
    expect(result.total).toBe(80);
    expect(commercialScoreWeights).toEqual({
      relevance: 25,
      market_language: 15,
      target_cooperation_angle: 15,
      editorial_commercial_feasibility: 15,
      dataforseo_authority_risk: 15,
      traffic_visibility: 10,
      technical: 5,
    });
  });

  it("does not convert missing facts to zero", () => {
    const input = components();
    const first = input[0];
    if (first === undefined) throw new Error("Expected score components");
    input[0] = {
      ...first,
      state: "insufficient_data",
      rawValue: null,
      normalizedValue: null,
    };
    const result = scoreCommercialRecommendation({ gates: gates(), components: input });

    expect(result.decision).toBe("insufficient_data");
    expect(result.total).toBeNull();
    expect(result.components[0]?.points).toBeNull();
  });

  it("applies hard gates before scoring and ranks deterministically", () => {
    const gated = gates();
    const firstGate = gated[0];
    if (firstGate === undefined) throw new Error("Expected hard gates");
    gated[0] = { ...firstGate, matched: true };
    expect(scoreCommercialRecommendation({
      gates: gated,
      components: components(),
    })).toMatchObject({ decision: "excluded", total: null });

    const score = scoreCommercialRecommendation({
      gates: gates(),
      components: components(),
    });
    expect(rankCommercialRecommendations([
      { hostnameAscii: "z.example", commercialScore: score },
      { hostnameAscii: "a.example", commercialScore: score },
    ]).map((item) => item.hostnameAscii)).toEqual(["a.example", "z.example"]);
  });
});
