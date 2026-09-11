import { describe, expect, it } from "vitest";

import {
  normalizeRecommendationFeedFilters,
  type RecommendationFeedBinding,
} from "../../src/modules/backlinks/application/queries/recommendation-feed.query.js";
import { createRecommendationFeedRepository } from "../../src/modules/backlinks/db/repositories/recommendation-feed.repository.js";

const scope = {
  organizationId: "019a0000-0000-7000-8000-000000000001",
  workspaceId: "019a0000-0000-7000-8000-000000000002",
  websiteProjectId: "019a0000-0000-7000-8000-000000000003",
  actorId: "actor-a",
} as const;

const currentBinding: RecommendationFeedBinding = {
  recommendationContextVersionId: "019a0000-0000-7000-8000-000000000004",
  visiblePoolGeneration: 2,
  generationContractId: "019a0000-0000-7000-8000-000000000005",
  inputPinId: "019a0000-0000-7000-8000-000000000006",
};

type QueryRecord = Readonly<{
  text: string;
  values: readonly unknown[];
}>;

function historicalItemRow(): Record<string, unknown> {
  return {
    itemId: "019a0000-0000-7000-8000-000000000010",
    canonicalDomain: "historical.example",
    recommended: false,
    recommendationReasons: [],
    primaryCategory: null,
    trafficOrganicEtv: null,
    authorityRank: null,
    spamScore: null,
    contactEmail: null,
    contactPage: null,
    contactOutcome: "NO_PUBLIC_CONTACT",
    opportunityId: null,
    businessStage: null,
    managementStatus: null,
    outcomeStatus: null,
    opportunityCreatedBy: null,
    releasedAt: new Date("2026-08-31T01:00:00.000Z"),
    releasedGenerationCount: "1",
    oldestReleasedGeneration: 1,
    newestReleasedGeneration: 1,
    totalCount: "1",
  };
}

function createPool(latestState: "RUNNING" | "FAILED" = "RUNNING"): Readonly<{
  pool: {
    connect(): Promise<{
      query(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
      release(): void;
    }>;
  };
  queries: QueryRecord[];
}> {
  const queries: QueryRecord[] = [];
  return {
    queries,
    pool: {
      async connect() {
        return {
          async query(text: string, values: readonly unknown[] = []) {
            queries.push({ text, values });
            if (
              text.includes("backlink_recommendation_pool_project_contracts")
            ) {
              return {
                rows: [
                  {
                    recommendationContextVersionId:
                      currentBinding.recommendationContextVersionId,
                    visiblePoolGeneration: currentBinding.visiblePoolGeneration,
                    generationContractId: currentBinding.generationContractId,
                    inputPinId: currentBinding.inputPinId,
                  },
                ],
                rowCount: 1,
              };
            }
            if (text.includes("backlink_recommendation_generation_contracts")) {
              return {
                rows: [
                  {
                    generationContractId: currentBinding.generationContractId,
                    visiblePoolGeneration: currentBinding.visiblePoolGeneration,
                    jobState: latestState,
                    progress: latestState === "FAILED" ? 100 : 45,
                    discoveryResult: latestState,
                    contactPreparation: "PENDING",
                    releaseResult: "NO_BATCH",
                    effectiveUniqueCandidateCount: 12,
                    admittedCount: 8,
                    releasedCount: 0,
                    terminalReason:
                      latestState === "FAILED"
                        ? "PROVIDER_SYSTEM_FAILURE"
                        : null,
                    retrySafe: latestState === "FAILED",
                  },
                ],
                rowCount: 1,
              };
            }
            if (text.includes("backlink_recommendation_user_publications")) {
              return { rows: [historicalItemRow()], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    },
  };
}

describe("Recommendation Pool V2 historical feed contract", () => {
  it("keeps entitled historical releases visible across generation rotation", async () => {
    const fixture = createPool();
    const repository = createRecommendationFeedRepository(fixture.pool);

    const result = await repository.list({
      ...scope,
      filters: normalizeRecommendationFeedFilters({}),
      cursor: null,
    });

    expect(result.items).toMatchObject([
      {
        domain: "historical.example",
      },
    ]);
    expect(result.releasedPool).toEqual({
      generationCount: 1,
      oldestVisiblePoolGeneration: 1,
      newestVisiblePoolGeneration: 1,
    });
    const itemQuery = fixture.queries.find((query) =>
      query.text.includes("backlink_recommendation_user_publications"),
    );
    expect(itemQuery?.text).not.toContain("batch.generation_contract_id=$5");
    expect(itemQuery?.text).not.toContain(
      "batch.recommendation_context_version_id=$6",
    );
    expect(itemQuery?.text).not.toContain("batch.visible_pool_generation=$7");
    expect(itemQuery?.text).not.toContain("batch.input_pin_id=$8");
  });

  it.each(["RUNNING", "FAILED"] as const)(
    "returns the latest %s generation separately while the prior pool remains usable",
    async (latestState) => {
      const fixture = createPool(latestState);
      const repository = createRecommendationFeedRepository(fixture.pool);

      const result = (await repository.list({
        ...scope,
        filters: normalizeRecommendationFeedFilters({}),
        cursor: null,
      })) as unknown as Record<string, unknown>;

      expect(result.latestGeneration).toEqual({
        generationContractId: currentBinding.generationContractId,
        visiblePoolGeneration: currentBinding.visiblePoolGeneration,
        jobState: latestState,
        progress: latestState === "FAILED" ? 100 : 45,
        discoveryResult: latestState,
        contactPreparation: "PENDING",
        releaseResult: "NO_BATCH",
        effectiveUniqueCandidateCount: 12,
        admittedCount: 8,
        releasedCount: 0,
        terminalReason:
          latestState === "FAILED" ? "PROVIDER_SYSTEM_FAILURE" : null,
        retrySafe: latestState === "FAILED",
      });
      expect(result.releasedPool).toEqual({
        generationCount: 1,
        oldestVisiblePoolGeneration: 1,
        newestVisiblePoolGeneration: 1,
      });
      expect(result.items).toBeDefined();
    },
  );
});
