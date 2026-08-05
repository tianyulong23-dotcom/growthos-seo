import { describe, expect, it } from "vitest";

import type { EvidenceValue } from "../../src/modules/backlinks/domain/evidence/evidence.js";
import {
  assessBacklinkEvidence,
  assessmentDimensionIds,
  type AssessmentDimensionId,
  type AssessmentDimensionInput,
} from "../../src/modules/backlinks/domain/assessments/assessment-policy.js";
function evidence(value: number, release = "dataforseo-2026-07-25", stale = false):
  EvidenceValue<number> {
  return {
    availability: "observed",
    value,
    sourceType: release.startsWith("crawler-") ? "crawler" : "dataforseo",
    sourceReleaseId: release,
    confidence: 0.9,
    observedAt: "2026-07-26T12:00:00.000Z",
    stale,
    evidenceRefs: [`s3://evidence/${release}.json`],
  };
}
function dimension(id: AssessmentDimensionId, score: number, release?: string):
  AssessmentDimensionInput {
  return {
    id,
    evidence: evidence(score * 100, release),
    normalizedValue: score,
    normalizationRuleVersion: `${id}.v1`,
    reasonCode: `${id}_normalized`,
  };
}
const complete = (): AssessmentDimensionInput[] => [
  dimension("technical_health", 1, "crawler-2026-07-26"),
  dimension("network_risk", 0.2),
  dimension("outbound_commercialization", 0.8),
  dimension("topic_content_editorial_quality", 0.8),
  dimension("graph_authority_diversity", 0.9),
];
describe("assessment domain policy", () => {
  it("returns five traceable dimensions without inventing a conclusion", () => {
    const result = assessBacklinkEvidence({
      evidenceContractVersion: "open-evidence.v1",
      dimensions: complete(),
    });
    expect(result).toMatchObject({
      status: "complete",
      totalScore: 75.5,
      sourceReleaseIds: ["crawler-2026-07-26", "dataforseo-2026-07-25"],
    });
    expect(result.dimensions.map(({ id }) => id)).toEqual(assessmentDimensionIds);
    expect(result.dimensions[3]).toMatchObject({
      id: "network_risk", status: "assessed", normalizedValue: 0.2, weight: 15,
    });
  });
  it("keeps unavailable and stale dimensions unknown instead of scoring zero", () => {
    const unavailable: EvidenceValue<number> = {
      availability: "unavailable",
      sourceType: "dataforseo",
      sourceReleaseId: "dataforseo-2026-07-25",
      confidence: 0,
      observedAt: "2026-07-26T12:00:00.000Z",
      stale: false,
      evidenceRefs: [],
      reason: "not_observed",
    };
    const dimensions = complete().map((entry): AssessmentDimensionInput =>
      entry.id === "graph_authority_diversity"
        ? { ...entry, evidence: unavailable, normalizedValue: null }
        : entry.id === "technical_health"
          ? { ...entry, evidence: evidence(90, "crawler-old", true) }
          : entry
    );
    const result = assessBacklinkEvidence({
      evidenceContractVersion: "open-evidence.v1",
      dimensions,
    });
    expect(result).toMatchObject({
      status: "insufficient_data",
      availability: "partial",
      freshness: "stale",
      totalScore: null,
    });
    expect(result.dimensions[0]).toMatchObject({
      status: "unknown", rawValue: null, points: null,
    });
    expect(result.dimensions[4]).toMatchObject({
      status: "unknown", rawValue: 90, points: null,
    });
  });
  it("rejects incomplete, duplicate, and invalid dimensions", () => {
    const assertInvalid = (dimensions: AssessmentDimensionInput[]) => expect(
      () => assessBacklinkEvidence({
        evidenceContractVersion: "open-evidence.v1",
        dimensions,
      }),
    ).toThrow(TypeError);
    assertInvalid(complete().slice(1));
    assertInvalid([...complete(), ...complete().slice(0, 1)]);
    assertInvalid(complete().map((entry) =>
      entry.id === "technical_health"
        ? { ...entry, normalizedValue: 1.1 }
        : entry
    ));
  });
});
