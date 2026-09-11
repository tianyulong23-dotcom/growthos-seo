import { describe, expect, it, vi } from "vitest";

import { createRecommendationPoolV2CandidateAdmissionService } from "../../src/modules/backlinks/application/services/recommendation-pool-v2-candidate-admission.service.js";
import type { CommercialDiscoveryArtifact } from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";

const lineage = Object.freeze({
  organizationId: "organization",
  workspaceId: "workspace",
  websiteProjectId: "project",
  generationContractId: "generation",
  recommendationContextVersionId: "context",
  visiblePoolGeneration: 2,
  inputPinId: "input-pin",
});

function artifact(
  canonicalDomain = "publisher.example.com",
): CommercialDiscoveryArtifact {
  return Object.freeze({
    sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
    endpoint: "/v3/serp/google/organic/task_post",
    requestFingerprint: "a".repeat(64),
    responseSchemaVersion: "commercial-discovery.serp.v1",
    collectedAt: "2026-09-03T00:00:00.000Z",
    costMicros: 25_000,
    providerTaskIds: Object.freeze(["task-1"]),
    plannerLineage: Object.freeze({
      blueprintId: "blueprint",
      queryId: "query",
    }),
    candidates: Object.freeze([
      Object.freeze({
        canonicalDomain,
        discoveryUrls: Object.freeze([]),
        backlinkPageEvidence: Object.freeze([]),
        rank: null,
        traffic: null,
        backlinkCount: null,
        referringDomainCount: null,
        spamScore: null,
        countryCode: null,
        evidenceRefs: Object.freeze(["provider-evidence"]),
      }),
    ]),
  });
}

function input(observations = [artifact()]) {
  return Object.freeze({
    ...lineage,
    projectDomain: "project.example.org",
    market: "US",
    location: "2840",
    language: "en",
    observations: Object.freeze(
      observations.map((value, index) =>
        Object.freeze({
          requestIntentId: `request-${index + 1}`,
          providerOutcome: "SUCCEEDED" as const,
          artifact: value,
        }),
      ),
    ),
    createdBy: "worker",
  });
}

function repository(
  existing:
    | Readonly<{
        id: string;
        canonicalDomain: string;
        admissionState: "ADMITTED" | "EXCLUDED";
        exclusionReasonCode: null | "ALREADY_RELEASED_TO_PROJECT";
      }>
    | null = null,
) {
  return {
    findCandidate: vi.fn(async () => existing),
    recordCandidate: vi.fn(async (value) =>
      Object.freeze({
        id: "authority-1",
        canonicalDomain: value.canonicalDomain,
        admissionState: value.admissionState,
        exclusionReasonCode: value.exclusionReasonCode ?? null,
      }),
    ),
    appendSource: vi.fn(async () => "source-1"),
    appendMetric: vi.fn(async () => "metric-1"),
    materializeCandidate: vi.fn(async () =>
      Object.freeze({
        generationCandidateId: "authority-1",
        batchId: "batch-1",
        candidateId: "candidate-1",
        recommendationId: "recommendation-1",
        prospectId: "prospect-1",
        inventoryId: "inventory-1",
      }),
    ),
  };
}

describe("recommendation pool V2 candidate admission service", () => {
  it("admits unknown metrics before contact preparation and materializes once", async () => {
    const authority = repository();
    const result =
      await createRecommendationPoolV2CandidateAdmissionService(
        authority,
      ).ingestArtifacts(input());

    expect(result).toEqual({
      rawCandidateCount: 1,
      canonicalCandidateCount: 1,
      newUniqueCount: 1,
      duplicateCount: 0,
      admittedCount: 1,
      hardExcludedCount: 0,
      materializedCount: 1,
    });
    expect(authority.recordCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionState: "ADMITTED",
        recommended: true,
      }),
    );
    expect(authority.appendMetric).toHaveBeenCalledTimes(3);
    expect(authority.materializeCandidate).toHaveBeenCalledTimes(1);
  });

  it("retains repeated observations without creating a second authority row", async () => {
    const authority = repository({
      id: "authority-existing",
      canonicalDomain: "example.com",
      admissionState: "ADMITTED",
      exclusionReasonCode: null,
    });
    const result =
      await createRecommendationPoolV2CandidateAdmissionService(
        authority,
      ).ingestArtifacts(input([artifact(), artifact()]));

    expect(result).toMatchObject({
      rawCandidateCount: 2,
      canonicalCandidateCount: 1,
      newUniqueCount: 0,
      duplicateCount: 1,
      admittedCount: 1,
      materializedCount: 1,
    });
    expect(authority.recordCandidate).not.toHaveBeenCalled();
    expect(authority.appendSource).toHaveBeenCalledTimes(2);
    expect(authority.appendMetric).toHaveBeenCalledTimes(6);
  });

  it("does not materialize a project-registry exclusion", async () => {
    const authority = repository({
      id: "authority-excluded",
      canonicalDomain: "example.com",
      admissionState: "EXCLUDED",
      exclusionReasonCode: "ALREADY_RELEASED_TO_PROJECT",
    });
    const result =
      await createRecommendationPoolV2CandidateAdmissionService(
        authority,
      ).ingestArtifacts(input());

    expect(result).toMatchObject({
      admittedCount: 0,
      hardExcludedCount: 1,
      materializedCount: 0,
    });
    expect(authority.materializeCandidate).not.toHaveBeenCalled();
  });

  it("records normalization, admission, and metric spans in causal order", async () => {
    const authority = repository();
    const record = vi.fn(async () => undefined);

    await createRecommendationPoolV2CandidateAdmissionService(
      authority,
      { record },
    ).ingestArtifacts(input());

    expect(record.mock.calls.map(([event]) => event.eventType)).toEqual([
      "CANDIDATE_NORMALIZATION_STARTED",
      "CANDIDATE_NORMALIZATION_COMPLETED",
      "CANDIDATE_ADMISSION_STARTED",
      "CANDIDATE_ADMISSION_COMPLETED",
      "METRIC_ENRICHMENT_STARTED",
      "METRIC_ENRICHMENT_COMPLETED",
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "CANDIDATE_ADMISSION_COMPLETED",
        requestIntentId: "request-1",
        generationCandidateId: "authority-1",
      }),
    );
  });
});
