import { describe, expect, it, vi } from "vitest";
import { createRecommendationPoolV2CandidateAdmissionService } from "../../src/modules/backlinks/application/services/recommendation-pool-v2-candidate-admission.service.js";
import { commercialDiscoveryArtifactSchema, type CommercialDiscoveryArtifact } from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";

function fixture(categoryMatch: "RELATED" | "ADJACENT" | "UNCONFIRMED", dr: number | null = 0) {
  const repository = {
    findCandidate: vi.fn(async () => null),
    recordCandidate: vi.fn(async (value) => ({ id: "candidate", canonicalDomain: value.canonicalDomain,
      admissionState: value.admissionState, exclusionReasonCode: value.exclusionReasonCode })),
    appendSource: vi.fn(async () => "source"),
    appendMetric: vi.fn(async () => "metric"),
    materializeCandidate: vi.fn(async () => ({ generationCandidateId: "candidate", batchId: "batch",
      candidateId: "candidate", recommendationId: "recommendation", prospectId: "prospect", inventoryId: "inventory" })),
  };
  const artifact: CommercialDiscoveryArtifact = {
    sourceType: "CURATED_RESOURCE_LIBRARY", endpoint: null, requestFingerprint: "a".repeat(64),
    responseSchemaVersion: "resource-library.sqlite.v1", collectedAt: "2026-09-10T06:00:00.000Z",
    costMicros: 0, providerTaskIds: [],
    candidates: [{ canonicalDomain: "publisher.com", discoveryUrls: ["https://publisher.com/"],
      backlinkPageEvidence: [], rank: 99, traffic: 999, backlinkCount: null, referringDomainCount: null,
      spamScore: null, countryCode: "US", evidenceRefs: ["fixture"],
      resourceLibrary: { ahrefsDr: dr, monthlyTraffic: null, language: "English",
        categories: ["Technology"], categoryMatch } }],
  };
  return { repository, run: () => createRecommendationPoolV2CandidateAdmissionService(repository).ingestArtifacts({
    organizationId: "org", workspaceId: "workspace", websiteProjectId: "project",
    generationContractId: "generation", recommendationContextVersionId: "context",
    visiblePoolGeneration: 1, inputPinId: "pin", projectDomain: "aiper.com",
    market: "US", location: "2840", language: "en", createdBy: "worker",
    observations: [{ requestIntentId: "library", providerOutcome: "SUCCEEDED", artifact: commercialDiscoveryArtifactSchema.parse(artifact) }],
  }) };
}

describe("resource library native V2 admission", () => {
  it.each(["RELATED", "ADJACENT", "UNCONFIRMED"] as const)("never invents cooperation for %s categories", async (match) => {
    const subject = fixture(match);
    expect(await subject.run()).toMatchObject({ admittedCount: 1, materializedCount: 1 });
    const recorded = subject.repository.recordCandidate.mock.calls[0]?.[0];
    expect(recorded.decisionEvidence.positiveEvidence).toEqual(["RELIABLE_METRIC"]);
    expect(recorded.decisionEvidence.relevanceEvidence).toEqual(match === "RELATED" ? ["PRODUCT_TOPIC_OVERLAP"] : []);
    expect(recorded.decisionEvidence.metrics).toEqual({
      targetMarketOrganicTraffic: null, dataForSeoRank: null, spamScore: null,
    });
    expect(subject.repository.appendSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "CURATED_RESOURCE_LIBRARY",
      evidencePayload: expect.objectContaining({ providerTaskIds: [],
        resourceLibrary: expect.objectContaining({ categoryMatch: match }) }),
    }));
  });
  it("keeps DR zero and missing monthly traffic distinct from ETV and rank", async () => {
    const subject = fixture("RELATED");
    await subject.run();
    expect(subject.repository.appendMetric).toHaveBeenCalledTimes(2);
    expect(subject.repository.appendMetric).toHaveBeenCalledWith(expect.objectContaining({
      provider: "resource_library", metricType: "AHREFS_DR", metricValue: 0, valueState: "AVAILABLE",
      market: "GLOBAL", location: "GLOBAL", language: "English",
    }));
    expect(subject.repository.appendMetric).toHaveBeenCalledWith(expect.objectContaining({
      provider: "resource_library", metricType: "LIBRARY_MONTHLY_TRAFFIC",
      metricValue: null, valueState: "UNAVAILABLE",
    }));
  });
  it("does not promote missing library DR to a reliable metric", async () => {
    const subject = fixture("UNCONFIRMED", null);
    await subject.run();
    expect(subject.repository.recordCandidate.mock.calls[0]?.[0].decisionEvidence.positiveEvidence).toEqual([]);
  });
});
