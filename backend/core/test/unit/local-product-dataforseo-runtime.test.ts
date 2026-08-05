import { describe, expect, it } from "vitest";

import {
  isLocalProductDataForSeoPaidCallAllowed,
  buildLocalProductRecommendationEvidenceCandidate,
  parseLocalProductRecommendationContext,
  readLocalProductDataForSeoConfiguration,
} from "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";
import {
  evaluateRecommendationCandidate,
} from "../../src/modules/backlinks/domain/recommendations/evaluation.js";
import { readFile } from "node:fs/promises";

const environment = Object.freeze({
  DATAFORSEO_CREDENTIAL_SECRET_REF:
    "secret://growthos/local-product/dataforseo/provider-credential/v7",
  DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify([
    "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    "https://api.dataforseo.com/v3/backlinks/summary/live",
  ]),
  DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
  DATAFORSEO_ESTIMATED_COST_MICROS: "50000",
  DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "100000",
  DATAFORSEO_MAX_PAID_CALLS: "25",
  DATAFORSEO_CANDIDATE_LIMIT: "20",
  DATAFORSEO_LOCATION_CODE: "ZA",
  DATAFORSEO_LANGUAGE_CODE: "en",
  DATAFORSEO_DISCOVERY_TARGETS_JSON: JSON.stringify([
    "showmax.com",
    "dstv.com",
  ]),
  DATAFORSEO_PROJECT_KEYWORDS_JSON: JSON.stringify([
    "live sports",
    "streaming movies",
  ]),
  DATAFORSEO_PROJECT_PRODUCTS_JSON: JSON.stringify([
    "ElephTV Android streaming app",
  ]),
  DATAFORSEO_TARGET_URLS_JSON: JSON.stringify(["https://elephtv.com/"]),
});

describe("LOCAL-REAL-002 DataForSEO runtime", () => {
  it("allows only calls below the configured paid-call ceiling", () => {
    expect(isLocalProductDataForSeoPaidCallAllowed(0, 25)).toBe(true);
    expect(isLocalProductDataForSeoPaidCallAllowed(24, 25)).toBe(true);
    expect(isLocalProductDataForSeoPaidCallAllowed(25, 25)).toBe(false);
  });

  it("does not count the current running batch as a prior paid call", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("WITH current_batch AS");
    expect(source).toContain("request_id=$5 AND status='running'");
    expect(source).toContain("batch.id<>COALESCE(");
    expect(source).toContain("gateInput.context.requestId");
  });

  it("accepts bounded local real-product configuration", () => {
    expect(readLocalProductDataForSeoConfiguration(environment)).toMatchObject({
      estimatedCostMicros: 50_000,
      absoluteBudgetMicros: 100_000,
      maxPaidCalls: 25,
      candidateLimit: 20,
    });

    expect(() => readLocalProductDataForSeoConfiguration({
      ...environment,
      DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify([
        "https://provider.invalid/live",
      ]),
    })).toThrow();
  });

  it("binds discovery and scoring facts to one immutable Website Project context", () => {
    expect(parseLocalProductRecommendationContext({
      snapshotVersion: 4,
      projectStatus: "ACTIVE",
      canonicalDomain: "awolvision.com",
      locale: "en-US",
      countryCode: "US",
      products: ["Home cinema projector"],
      keywords: ["home cinema"],
      targetUrls: ["https://awolvision.com/"],
    })).toMatchObject({
      snapshotVersion: 4,
      canonicalDomain: "awolvision.com",
      countryCode: "US",
      keywords: ["home cinema"],
    });

    expect(() => parseLocalProductRecommendationContext({
      snapshotVersion: 4,
      projectStatus: "PAUSED",
      canonicalDomain: "awolvision.com",
      locale: "en",
      countryCode: "US",
      products: ["Home cinema projector"],
      keywords: ["home cinema"],
      targetUrls: ["https://awolvision.com/"],
    })).toThrow();
  });

  it("builds an evaluable non-demo candidate from provider and SafeFetch evidence", async () => {
    const candidate =
      await buildLocalProductRecommendationEvidenceCandidate({
        context: {
          workspaceId: "workspace-1",
          websiteProjectId: "project-1",
        },
        evidence: {
          domain: "sportsnews.co.za",
          backlinkCount: 1_200,
          rank: 72,
          spamScore: 4,
          countryCode: "ZA",
        },
        sourceReleaseId: "dataforseo:release-1",
        acquiredAt: "2026-08-04T08:00:00.000Z",
        locationCode: "ZA",
        languageCode: "en",
        projectTerms: [
          "live sports",
          "streaming movies",
          "ElephTV Android streaming app",
        ],
        existingHostname: false,
        existingBacklink: false,
        previouslyExcluded: false,
        duplicateDomain: false,
        safeFetch: {
          fetch: async () => ({
            requestedUrl: "https://sportsnews.co.za/",
            finalUrl: "https://sportsnews.co.za/",
            status: 200,
            contentType: "text/html",
            body: Uint8Array.from(Buffer.from(
              "<html lang='en'><head><title>Live sports and streaming news</title>"
                + "<meta name='description' content='Movies, TV and sports'></head>"
                + "<body><a href='/football'>Football</a>"
                + "<p>Independent editorial coverage of African live sports.</p>"
                + "</body></html>",
              "utf8",
            )),
            redirectChain: [],
            resolvedIps: ["203.0.113.10"],
            fetchedAt: "2026-08-04T08:00:01.000Z",
          }),
        },
      });

    const evaluated = evaluateRecommendationCandidate(candidate);
    expect(evaluated.decision).toBe("ready");
    expect(evaluated.hostnameAscii).toBe("sportsnews.co.za");
    expect(evaluated.score?.total).toBeGreaterThan(0);
  });

  it("fails closed when static website evidence cannot be collected", async () => {
    const candidate =
      await buildLocalProductRecommendationEvidenceCandidate({
        context: {
          workspaceId: "workspace-1",
          websiteProjectId: "project-1",
        },
        evidence: {
          domain: "unreachable.co.za",
          backlinkCount: 100,
          rank: 20,
          spamScore: null,
          countryCode: "ZA",
        },
        sourceReleaseId: "dataforseo:release-1",
        acquiredAt: "2026-08-04T08:00:00.000Z",
        locationCode: "ZA",
        languageCode: "en",
        projectTerms: ["live sports"],
        existingHostname: false,
        existingBacklink: false,
        previouslyExcluded: false,
        duplicateDomain: false,
        safeFetch: {
          fetch: async () => {
            throw new Error("network unavailable");
          },
        },
      });

    expect(evaluateRecommendationCandidate(candidate)).toMatchObject({
      decision: "insufficient_data",
    });
  });
});
