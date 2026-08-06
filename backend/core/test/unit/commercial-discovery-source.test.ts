import { describe, expect, it } from "vitest";

import {
  assertCommercialDiscoveryCallAllowed,
  createCommercialDiscoveryPlan,
  mergeCommercialDiscoveryArtifacts,
  normalizeCommercialDiscoveryResponse,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";

const allowed = [
  "https://api.dataforseo.com/v3/serp/google/organic/task_post",
  "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
  "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced",
  "https://api.dataforseo.com/v3/backlinks/competitors/live",
  "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
] as const;

describe("commercial DataForSEO discovery sources", () => {
  it("builds a bounded multi-source DISCOVERY plan under the budget", () => {
    const plan = createCommercialDiscoveryPlan({
      searchQueries: ["video streaming resources"],
      verifiedCompetitorDomains: ["competitor.com"],
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 4_000,
    });

    expect(plan).toHaveLength(4);
    expect(new Set(plan.map(({ sourceType }) => sourceType))).toEqual(
      new Set([
        "BLUEPRINT_SERP_STANDARD_QUEUE",
        "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
        "VERIFIED_COMPETITOR_BACKLINK_GAP",
        "USER_REFERRING_DOMAINS",
      ]),
    );
    expect(plan.every(({ intent }) => intent === "DISCOVERY")).toBe(true);
  });

  it("rejects endpoint/source mismatch and missing allowlist entries", () => {
    expect(() => assertCommercialDiscoveryCallAllowed({
      call: {
        endpoint: "/v3/backlinks/referring_domains/live",
        intent: "DISCOVERY",
        sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
        request: { target: "example.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      endpointAllowlist: allowed,
    })).toThrow("DATAFORSEO_COMMERCIAL_SOURCE_ENDPOINT_MISMATCH");

    expect(() => assertCommercialDiscoveryCallAllowed({
      call: {
        endpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
        intent: "DISCOVERY",
        sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
        request: { target: "example.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      endpointAllowlist: allowed,
    })).toThrow("DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED");
  });

  it("normalizes official task results and withholds user-RD-only domains", () => {
    const call = {
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "USER_REFERRING_DOMAINS",
      request: { target: "owner.com" },
      responseSchemaVersion: "test.v1",
      estimatedCostMicros: 1_000,
    } as const;
    const userArtifact = normalizeCommercialDiscoveryResponse({
      call,
      collectedAt: "2026-08-06T08:00:00.000Z",
      response: {
        tasks: [{
          id: "task-user",
          cost: 0.001,
          result: [{
            items: [{
              domain: "user-only.com",
              rank: 40,
              backlinks: 10,
            }],
          }],
        }],
      },
    });
    const serpArtifact = normalizeCommercialDiscoveryResponse({
      call: {
        ...call,
        endpoint: "/v3/serp/google/organic/task_get/advanced",
        sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      },
      collectedAt: "2026-08-06T08:00:00.000Z",
      response: {
        tasks: [{
          id: "task-serp",
          cost: 0,
          result: [{
            items: [{
              domain: "publisher.com",
              rank: 80,
            }],
          }],
        }],
      },
    });

    expect(mergeCommercialDiscoveryArtifacts({
      artifacts: [userArtifact],
      userDomain: "owner.com",
      excludedDomains: [],
    })).toEqual([]);
    expect(mergeCommercialDiscoveryArtifacts({
      artifacts: [userArtifact, serpArtifact],
      userDomain: "owner.com",
      excludedDomains: [],
    }).map(({ canonicalDomain }) => canonicalDomain)).toEqual([
      "publisher.com",
    ]);
  });
});
