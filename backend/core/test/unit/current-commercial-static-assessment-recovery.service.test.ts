import { describe, expect, it } from "vitest";

import {
  currentCommercialStaticAssessmentRecoveryContractVersion,
  recoverCurrentCommercialStaticAssessments,
} from "../../src/modules/backlinks/application/services/current-commercial-static-assessment-recovery.service.js";
import {
  SafeFetchError,
  safeFetchFailureCodes,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const candidateId = "00000000-0000-4000-8000-000000000021";
const now = new Date("2026-08-25T10:00:00.000Z");
const project = Object.freeze({
  products: ["home cinema projector"],
  topics: ["projector reviews"],
  keywords: ["home cinema projector reviews"],
  targetPages: ["https://project.example/projectors"],
  targetAudiences: ["home cinema buyers"],
  partnershipGoals: ["editorial review"],
});
const commercialScore = Object.freeze({
  decision: "insufficient_data",
  details: {
    authority: { projectAuthority: 20 },
    market: { candidateCountry: "US" },
    dataForSeo: {
      rank: 70,
      traffic: 50_000,
      backlinks: 1_000,
      referringDomains: 200,
      spamScore: 10,
      evidenceRefs: ["dataforseo:publisher.com"],
      collectedAt: "2026-08-25T09:00:00.000Z",
    },
  },
});
const baseStaticAssessment = Object.freeze({
  canonicalDomain: "publisher.com",
  decision: "insufficient_data",
  language: null,
  topics: [],
  matchedProducts: [],
  matchedTopics: [],
  matchedKeywords: [],
  matchedTargetPages: [],
  matchedAudiences: [],
  matchedPartnershipGoals: [],
  relatedContentPages: [],
  productRelevance: null,
  editorialQuality: null,
  siteType: null,
  monetizationMethods: [],
  cooperationPages: [],
  outboundLinkDensity: null,
  technicalAccessibility: null,
  unsafeOrMalicious: null,
  highConfidenceLinkFarm: null,
  unrelatedIndustry: null,
  evidenceUrls: [],
  evidenceRefs: [],
  failedUrls: ["https://publisher.com/"],
  collectedAt: "2026-08-25T09:00:00.000Z",
  ruleVersion: "commercial-static-assessment.v3",
});

function claimedCandidate(attemptCount: number) {
  return {
    candidateId,
    canonicalDomain: "publisher.com",
    staticAssessment: {
      ...baseStaticAssessment,
      recovery: {
        attemptCount,
        contractVersion:
          currentCommercialStaticAssessmentRecoveryContractVersion,
        status: "running",
        operationId: "operation-1",
      },
    },
    gateDecision: {
      decision: "insufficient_data",
      hitGates: [],
      missingEvidence: ["static_assessment"],
    },
    commercialScore,
    refillTier: "exact_product_target_market",
    locale: "en-US",
    countryCode: "US",
  };
}

const scope = Object.freeze({
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  projectContextVersionId: "context-1",
  visiblePoolGeneration: 1,
  operationId: "operation-1",
  actorId: "worker-1",
  maximumCandidates: 10,
  project,
  now,
});

describe("current commercial static assessment recovery", () => {
  it("binds the recovery operation identity as text for PostgreSQL", async () => {
    const queries: string[] = [];
    await recoverCurrentCommercialStaticAssessments(
      {
        async query(text: string) {
          queries.push(text);
          return { rows: [] };
        },
      },
      {
        organizationId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        websiteProjectId: "00000000-0000-4000-8000-000000000003",
        projectContextVersionId:
          "00000000-0000-4000-8000-000000000004",
        visiblePoolGeneration: 1,
        operationId: "static-recovery-operation",
        actorId: "00000000-0000-4000-8000-000000000005",
        maximumCandidates: 25,
        project,
        safeFetch: {
          async fetch() {
            throw new Error("not called");
          },
        },
        now,
      },
    );

    expect(queries[0]).toContain("'operationId',$7::text");
    expect(queries[0]).toContain("'leaseExpiresAt',$9::text");
    expect(queries[0]).toContain("'contractVersion',$13::text");
  });

  it("claims with a lease and persists a recovered ready assessment", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      { rows: [claimedCandidate(1)] },
      { rows: [{ id: candidateId }] },
    ];
    let index = 0;

    const result = await recoverCurrentCommercialStaticAssessments(
      {
        query: async (text, values = []) => {
          queries.push({ text, values });
          return responses[index++] ?? { rows: [] };
        },
      },
      {
        ...scope,
        safeFetch: {
          fetch: async ({ url }) => ({
            requestedUrl: url,
            finalUrl: url,
            status: 200,
            contentType: "text/html",
            body: Uint8Array.from(Buffer.from(
              "<html lang='en'><head><title>Projector reviews</title>"
                + "<meta name='description' content='Home cinema reviews'>"
                + "</head><body><main><article>Independent home cinema "
                + "projector reviews for home cinema buyers and editorial "
                + "review partners.</article></main></body></html>",
              "utf8",
            )),
            redirectChain: [],
            resolvedIps: ["203.0.113.10"],
            fetchedAt: now.toISOString(),
          }),
        },
      },
    );

    expect(result).toEqual({
      claimedCount: 1,
      readyCount: 1,
      retryScheduledCount: 0,
      manualReviewCount: 0,
      exhaustedCount: 0,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("FOR UPDATE OF candidate SKIP LOCKED");
    expect(queries[0]?.text).toContain(
      "recoverable.recovery_attempt_count+1",
    );
    const assessment = JSON.parse(String(queries[1]?.values[6]));
    expect(assessment).toMatchObject({
      decision: "ready",
      recovery: {
        attemptCount: 1,
        contractVersion:
          currentCommercialStaticAssessmentRecoveryContractVersion,
        status: "completed",
        operationId: "operation-1",
      },
    });
    expect(queries[1]?.values[9]).toBe("candidate_ready");
  });

  it("does nothing when no persisted candidate is eligible for recovery", async () => {
    let fetchCalls = 0;
    const result = await recoverCurrentCommercialStaticAssessments(
      {
        query: async () => ({ rows: [] }),
      },
      {
        ...scope,
        safeFetch: {
          fetch: async () => {
            fetchCalls += 1;
            throw new Error("unexpected fetch");
          },
        },
      },
    );

    expect(result).toEqual({
      claimedCount: 0,
      readyCount: 0,
      retryScheduledCount: 0,
      manualReviewCount: 0,
      exhaustedCount: 0,
    });
    expect(fetchCalls).toBe(0);
  });

  it("marks retryable failures exhausted at the persisted attempt cap", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      { rows: [claimedCandidate(3)] },
      { rows: [{ id: candidateId }] },
    ];
    let index = 0;
    let fetchCalls = 0;

    const result = await recoverCurrentCommercialStaticAssessments(
      {
        query: async (text, values = []) => {
          queries.push({ text, values });
          return responses[index++] ?? { rows: [] };
        },
      },
      {
        ...scope,
        safeFetch: {
          fetch: async ({ url }) => {
            fetchCalls += 1;
            throw new SafeFetchError({
              code: safeFetchFailureCodes.timeout,
              requestedUrl: url,
              message: "Timed out.",
              retryable: true,
            });
          },
        },
      },
    );

    expect(result).toEqual({
      claimedCount: 1,
      readyCount: 0,
      retryScheduledCount: 0,
      manualReviewCount: 0,
      exhaustedCount: 1,
    });
    expect(fetchCalls).toBe(2);
    const assessment = JSON.parse(String(queries[1]?.values[6]));
    expect(assessment).toMatchObject({
      decision: "insufficient_data",
      recovery: {
        attemptCount: 3,
        contractVersion:
          currentCommercialStaticAssessmentRecoveryContractVersion,
        status: "exhausted",
        operationId: "operation-1",
      },
    });
    expect(queries[1]?.values[9]).toBe("insufficient_data");
  });

  it("makes candidates from an older recovery contract eligible again", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      { rows: [claimedCandidate(1)] },
      { rows: [{ id: candidateId }] },
    ];
    let index = 0;

    await recoverCurrentCommercialStaticAssessments(
      {
        query: async (text, values = []) => {
          queries.push({ text, values });
          return responses[index++] ?? { rows: [] };
        },
      },
      {
        ...scope,
        safeFetch: {
          fetch: async ({ url }) => ({
            requestedUrl: url,
            finalUrl: url,
            status: 200,
            contentType: "text/html",
            body: Uint8Array.from(Buffer.from(
              "<html><head><title>Projector reviews</title></head>"
                + "<body><main><article>Independent home cinema projector "
                + "reviews for buyers.</article></main></body></html>",
              "utf8",
            )),
            redirectChain: [],
            resolvedIps: ["203.0.113.10"],
            fetchedAt: now.toISOString(),
          }),
        },
      },
    );

    expect(queries[0]?.text).toContain(
      "#>>'{recovery,contractVersion}' IS DISTINCT FROM $13",
    );
    expect(queries[0]?.text).toContain(
      "'attemptCount',recoverable.recovery_attempt_count+1",
    );
    expect(queries[0]?.values[12]).toBe(
      currentCommercialStaticAssessmentRecoveryContractVersion,
    );
    expect(queries[1]?.text).toContain(
      "#>>'{recovery,contractVersion}'=$16",
    );
  });
});
