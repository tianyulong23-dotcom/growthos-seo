import { describe, expect, it, vi } from "vitest";

import {
  createRecommendationFeedCursorCodec,
  createRecommendationFeedQuery,
  normalizeRecommendationFeedFilters,
  recommendationFeedFilterFingerprint,
  type RecommendationFeedBinding,
  type RecommendationFeedItem,
  type RecommendationFeedScope,
} from "../../src/modules/backlinks/application/queries/recommendation-feed.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const scope: RecommendationFeedScope = {
  organizationId: "organization-a",
  workspaceId: "workspace-a",
  websiteProjectId: "project-a",
  actorId: "actor-a",
};
const binding: RecommendationFeedBinding = {
  recommendationContextVersionId: "context-a",
  visiblePoolGeneration: 3,
  generationContractId: "generation-a",
  inputPinId: "input-pin-a",
};
const item: RecommendationFeedItem = {
  itemId: "018f0000-0000-7000-8000-000000000091",
  domain: "publisher.example",
  displayUrl: "https://publisher.example/",
  recommended: true,
  recommendationReasons: ["Audience match"],
  category: "editorial",
  metrics: {
    targetMarketOrganicTraffic: null,
    dataForSeoRank: 42,
    spamScore: null,
  },
  contact: {
    email: null,
    contactPage: "https://publisher.example/contact",
    outcome: "CONTACT_PAGE_FOUND",
  },
  opportunity: {
    opportunityId: null,
    businessStage: null,
    managementStatus: null,
    outcomeStatus: null,
    createdByCurrentUser: false,
  },
  archived: false,
  releasedAt: "2026-08-31T01:00:00.000Z",
};

const context = {
  actor: createActorContext({
    userId: scope.actorId,
    sessionId: "session-a",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
  }),
  project: createProjectContext({
    websiteProjectId: scope.websiteProjectId,
    canonicalDomain: "owner.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-a",
    promotionTargetVersionId: "promotion-a",
  }),
};

function expectInvalidRequest(run: () => unknown): void {
  try {
    run();
    throw new Error("Expected recommendation feed validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(BacklinkError);
    expect((error as BacklinkError).code).toBe(
      backlinkErrorCodes.invalidRequest,
    );
  }
}

describe("recommendation feed query policy", () => {
  it("normalizes only the Phase 6 filters and rejects invalid ranges", () => {
    expect(
      normalizeRecommendationFeedFilters({
        category: " Editorial ",
        domainSearch: "  PUB%_LISHER.Example  ",
        trafficMin: 0,
        spamMax: 100,
      }),
    ).toEqual({
      batchId: null,
      recommendedOnly: false,
      category: "Editorial",
      trafficMin: 0,
      trafficMax: null,
      rankMin: null,
      rankMax: null,
      spamMin: null,
      spamMax: 100,
      sort: "released_desc",
      cursor: null,
      limit: 35,
      domainSearch: "pub%_lisher.example",
    });

    for (const filters of [
      { batchId: "not-a-batch" },
      { limit: 0 },
      { limit: -1 },
      { limit: 101 },
      { limit: 1.5 },
      { trafficMin: -1 },
      { rankMin: Number.NaN },
      { spamMax: 101 },
      { trafficMin: 10, trafficMax: 9 },
      { rankMin: 2, rankMax: 1 },
      { spamMin: 5, spamMax: 4 },
      { category: " " },
      { domainSearch: " " },
    ]) {
      expectInvalidRequest(() => normalizeRecommendationFeedFilters(filters));
    }
  });

  it("binds a signed cursor to actor, project, context, filters, and sort", () => {
    const filters = normalizeRecommendationFeedFilters({
      category: "editorial",
      sort: "domain_asc",
      limit: 25,
    });
    const filterFingerprint = recommendationFeedFilterFingerprint(filters);
    const codec = createRecommendationFeedCursorCodec("phase-6-secret");
    const token = codec.encode({
      scope,
      binding,
      filterFingerprint,
      position: {
        itemId: item.itemId,
        releasedAt: item.releasedAt,
        canonicalDomain: item.domain,
        trafficOrganicEtv: null,
        authorityRank: 42,
        spamScore: null,
      },
    });

    expect(codec.decode(token, { scope, filterFingerprint })).toEqual({
      binding,
      position: {
        itemId: item.itemId,
        releasedAt: item.releasedAt,
        canonicalDomain: item.domain,
        trafficOrganicEtv: null,
        authorityRank: 42,
        spamScore: null,
      },
    });
    expectInvalidRequest(() =>
      codec.decode(token, {
        scope: { ...scope, actorId: "actor-b" },
        filterFingerprint,
      }),
    );
    expectInvalidRequest(() =>
      codec.decode(token, {
        scope: { ...scope, websiteProjectId: "project-b" },
        filterFingerprint,
      }),
    );
    expectInvalidRequest(() =>
      codec.decode(token, {
        scope,
        filterFingerprint: recommendationFeedFilterFingerprint({
          ...filters,
          sort: "released_asc",
        }),
      }),
    );
    expectInvalidRequest(() =>
      codec.decode(`${token.slice(0, -1)}x`, { scope, filterFingerprint }),
    );
  });

  it("delegates list and export to a read-only repository without write hooks", async () => {
    const list = vi.fn().mockResolvedValue({
      items: [item],
      binding,
      totalCount: 7,
      nextPosition: {
        itemId: item.itemId,
        releasedAt: item.releasedAt,
        canonicalDomain: item.domain,
        trafficOrganicEtv: null,
        authorityRank: 42,
        spamScore: null,
      },
    });
    const exportItems = vi.fn().mockResolvedValue([item]);
    const query = createRecommendationFeedQuery(
      { list, exportItems },
      { cursorSigningKey: "phase-6-secret" },
    );

    const page = await query.list(context, {
      recommendedOnly: true,
      limit: 1,
    });
    expect(page.items).toEqual([item]);
    expect(page.totalCount).toBe(7);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({
      ...scope,
      filters: {
        recommendedOnly: true,
        limit: 1,
        sort: "released_desc",
      },
      cursor: null,
    });

    const exported = await query.export(context, {
      selectedItemIds: [item.itemId],
    });
    expect(exportItems).toHaveBeenCalledWith({
      ...scope,
      filters: expect.objectContaining({
        sort: "released_desc",
      }),
      selectedItemIds: [item.itemId],
    });
    expect(exported.contentType).toBe("text/csv");
    expect(exported.content).toContain("publisher.example");
    expect(exported.content).not.toContain("internal");
  });
});
