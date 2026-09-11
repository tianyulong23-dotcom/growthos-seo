import { describe, expect, it } from "vitest";

import {
  normalizeRecommendationFeedFilters,
  type RecommendationFeedBinding,
} from "../../src/modules/backlinks/application/queries/recommendation-feed.query.js";
import { createRecommendationFeedRepository } from "../../src/modules/backlinks/db/repositories/recommendation-feed.repository.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const scope = {
  organizationId: "019a0000-0000-7000-8000-000000000001",
  workspaceId: "019a0000-0000-7000-8000-000000000002",
  websiteProjectId: "019a0000-0000-7000-8000-000000000003",
  actorId: "actor-a",
} as const;
const binding: RecommendationFeedBinding = {
  recommendationContextVersionId: "019a0000-0000-7000-8000-000000000004",
  visiblePoolGeneration: 2,
  generationContractId: "019a0000-0000-7000-8000-000000000005",
  inputPinId: "019a0000-0000-7000-8000-000000000006",
};

type QueryRecord = Readonly<{
  text: string;
  values: readonly unknown[];
}>;

function createPool(itemRows: readonly Record<string, unknown>[]): Readonly<{
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
                      binding.recommendationContextVersionId,
                    visiblePoolGeneration: binding.visiblePoolGeneration,
                    generationContractId: binding.generationContractId,
                    inputPinId: binding.inputPinId,
                  },
                ],
                rowCount: 1,
              };
            }
            if (
              text.includes(
                "FROM backlink_recommendation_generation_contracts generation",
              )
            ) {
              return {
                rows: [
                  {
                    generationContractId: binding.generationContractId,
                    visiblePoolGeneration: binding.visiblePoolGeneration,
                    jobState: "SUCCEEDED",
                    progress: 100,
                    discoveryResult: "SUCCEEDED",
                    contactPreparation: "SUCCEEDED",
                    releaseResult: "RELEASED",
                    effectiveUniqueCandidateCount: 1,
                    admittedCount: 1,
                    releasedCount: 1,
                    terminalReason: null,
                    retrySafe: false,
                  },
                ],
                rowCount: 1,
              };
            }
            if (text.includes("backlink_recommendation_user_publications")) {
              return { rows: [...itemRows], rowCount: itemRows.length };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    },
  };
}

function expectInvalidRequest(error: unknown): boolean {
  return (
    error instanceof BacklinkError &&
    error.code === backlinkErrorCodes.invalidRequest
  );
}

describe("recommendation feed repository", () => {
  it("performs only scoped reads and escapes SQL LIKE wildcards", async () => {
    const fixture = createPool([
      {
        itemId: "019a0000-0000-7000-8000-000000000010",
        canonicalDomain: "pub%_lish\\er.example",
        recommended: true,
        recommendationReasons: ["COMMERCIAL_FIT"],
        primaryCategory: "Editorial",
        trafficOrganicEtv: null,
        authorityRank: "42",
        spamScore: null,
        contactEmail: null,
        contactPage: "https://pub.example/contact",
        contactOutcome: "CONTACT_PAGE_FOUND",
        opportunityId: null,
        businessStage: null,
        managementStatus: null,
        outcomeStatus: null,
        opportunityCreatedBy: null,
        releasedAt: new Date("2026-08-31T01:00:00.000Z"),
        releasedGenerationCount: "1",
        oldestReleasedGeneration: 2,
        newestReleasedGeneration: 2,
        totalCount: "1",
      },
    ]);
    const repository = createRecommendationFeedRepository(fixture.pool);
    const result = await repository.list({
      ...scope,
      filters: normalizeRecommendationFeedFilters({
        domainSearch: "pub%_lish\\er.example",
        trafficMin: 0,
      }),
      cursor: null,
    });

    expect(result).toMatchObject({
      binding,
      releasedPool: {
        generationCount: 1,
        oldestVisiblePoolGeneration: 2,
        newestVisiblePoolGeneration: 2,
      },
      totalCount: 1,
      items: [
        {
          domain: "pub%_lish\\er.example",
          displayUrl: "https://pub%_lish\\er.example/",
          metrics: {
            targetMarketOrganicTraffic: null,
            dataForSeoRank: 42,
            spamScore: null,
          },
          archived: false,
        },
      ],
    });
    const itemQuery = fixture.queries.find((query) =>
      query.text.includes("backlink_recommendation_user_publications"),
    );
    expect(itemQuery?.text).toContain("publication.user_id=$4");
    expect(itemQuery?.text).toContain(
      "batch.recommendation_context_version_id",
    );
    expect(itemQuery?.text).toContain("publication.visible_pool_generation");
    expect(itemQuery?.text).not.toContain("batch.generation_contract_id=$5");
    expect(itemQuery?.values.slice(0, 4)).toEqual([
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      scope.actorId,
    ]);
    expect(itemQuery?.text).toContain("ESCAPE '\\'");
    expect(itemQuery?.text).toContain("contact_priority DESC, released_at DESC, item_id DESC");
    expect(itemQuery?.text).toContain("THEN 2");
    expect(itemQuery?.values).toContain("pub\\%\\_lish\\\\er.example");
    expect(
      fixture.queries.some((query) =>
        /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(query.text),
      ),
    ).toBe(false);
  });

  it("rejects a stale generation cursor before reading feed items", async () => {
    const fixture = createPool([]);
    const repository = createRecommendationFeedRepository(fixture.pool);

    await expect(
      repository.list({
        ...scope,
        filters: normalizeRecommendationFeedFilters({}),
        cursor: {
          binding: {
            ...binding,
            visiblePoolGeneration: binding.visiblePoolGeneration - 1,
          },
          position: {
            itemId: "019a0000-0000-7000-8000-000000000010",
            releasedAt: "2026-08-31T01:00:00.000Z",
            canonicalDomain: "publisher.example",
            trafficOrganicEtv: null,
            authorityRank: null,
            spamScore: null,
          },
        },
      }),
    ).rejects.toSatisfy(expectInvalidRequest);
    expect(
      fixture.queries.filter((query) =>
        query.text.includes("backlink_recommendation_user_publications"),
      ),
    ).toHaveLength(0);
  });

  it("keeps contact priority in the keyset predicate before the page limit", async () => {
    const fixture = createPool([{
      itemId: null, totalCount: "0", releasedGenerationCount: "0",
      oldestReleasedGeneration: null, newestReleasedGeneration: null,
    }]);
    await createRecommendationFeedRepository(fixture.pool).list({
      ...scope,
      filters: normalizeRecommendationFeedFilters({}),
      cursor: {
        binding,
        position: {
          itemId: "019a0000-0000-7000-8000-000000000010",
          releasedAt: "2026-08-31T01:00:00.000Z",
          canonicalDomain: "publisher.example",
          trafficOrganicEtv: null,
          authorityRank: null,
          spamScore: null,
          contactPriority: 2,
        },
      },
    });
    const query = fixture.queries.find((record) => record.text.includes("contact_priority<"));
    expect(query?.text).toMatch(/contact_priority</u);
    expect(query?.text).toMatch(/contact_priority=/u);
    expect(query?.values).toContain(2);
  });

  it("fails closed when selected export items cross entitlement", async () => {
    const fixture = createPool([
      {
        itemId: "019a0000-0000-7000-8000-000000000010",
        canonicalDomain: "publisher.example",
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
      },
    ]);
    const repository = createRecommendationFeedRepository(fixture.pool);

    await expect(
      repository.exportItems({
        ...scope,
        filters: normalizeRecommendationFeedFilters({}),
        selectedItemIds: [
          "019a0000-0000-7000-8000-000000000010",
          "019a0000-0000-7000-8000-000000000011",
        ],
      }),
    ).rejects.toSatisfy(expectInvalidRequest);
  });
});
