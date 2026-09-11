import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRecommendationFeedRoutes } from "../../../src/modules/backlinks/api/recommendation-feed.route";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module";
import type { RecommendationFeedQuery } from "../../../src/modules/backlinks/application/queries/recommendation-feed.query";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error";

const actor = createActorContext({
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "phase6-session",
  roles: ["member"],
});

const projectContext = {
  actor,
  tenant: createTenantContext({
    organizationId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
  }),
  project: createProjectContext({
    websiteProjectId: "44444444-4444-4444-8444-444444444444",
    canonicalDomain: "project.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-v1",
    promotionTargetVersionId: "promotion-v1",
  }),
};

const publicItem = {
  itemId: "55555555-5555-4555-8555-555555555555",
  domain: "example.com",
  displayUrl: "https://example.com",
  recommended: true,
  recommendationReasons: ["RELEVANT_CATEGORY"],
  category: "Editorial",
  metrics: {
    targetMarketOrganicTraffic: null,
    dataForSeoRank: 74,
    spamScore: 8,
  },
  contact: {
    email: null,
    contactPage: "https://example.com/contact",
    outcome: "CONTACT_PAGE_ONLY",
  },
  opportunity: {
    opportunityId: null,
    businessStage: null,
    managementStatus: null,
    outcomeStatus: null,
    createdByCurrentUser: false,
  },
  archived: false as const,
  releasedAt: "2026-08-31T00:00:00.000Z",
};

const createQuery = (): RecommendationFeedQuery => ({
  list: vi.fn(async () => ({
    items: [publicItem],
    releasedPool: {
      generationCount: 2,
      oldestVisiblePoolGeneration: 1,
      newestVisiblePoolGeneration: 2,
    },
    latestGeneration: {
      generationContractId: "66666666-6666-4666-8666-666666666666",
      visiblePoolGeneration: 3,
      jobState: "RUNNING",
      progress: 40,
      discoveryResult: "IN_PROGRESS",
      contactPreparation: "PENDING",
      releaseResult: "PENDING",
      effectiveUniqueCandidateCount: 14,
      admittedCount: 0,
      releasedCount: 0,
      terminalReason: null,
      retrySafe: false,
    },
    totalCount: 1,
    nextCursor: "next-cursor",
  })),
  export: vi.fn(async () => ({
    contentType: "text/csv" as const,
    fileName: "backlink-recommendations.csv",
    content: "domain,recommended\r\nexample.com,true\r\n",
  })),
});

const createApp = async (query = createQuery(), observe = vi.fn(async () => {})) => {
  const app = Fastify();
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = actor;
  });
  await registerBacklinksOpenApi(app);
  registerRecommendationFeedRoutes(app, {
    module: createBacklinksModule({
      projectContext: {
        async resolve(input) {
          if (input.websiteProjectKey !== "project-one") {
            throw new BacklinkError({
              code: backlinkErrorCodes.accessDenied,
              message: "Project access denied.",
            });
          }
          return { ...projectContext, actor: input.actor };
        },
      },
      queries: {},
    }),
    query,
    observe,
  });
  await app.ready();
  return { app, query, observe };
};

describe("recommendation feed routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("records a scoped frontend observation without querying or mutating the feed", async () => {
    const { app, query, observe } = await createApp();
    apps.push(app);
    const body = {
      generationContractId: "66666666-6666-4666-8666-666666666666",
      observedState: "RUNNING|IN_PROGRESS|PENDING|PENDING",
      clientObservedAt: "2026-09-08T00:00:00.000Z",
    };
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-one/backlinks/recommendation-feed/observations",
      payload: body,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ recorded: true });
    expect(observe).toHaveBeenCalledWith(projectContext, body);
    expect(query.list).not.toHaveBeenCalled();
    expect(query.export).not.toHaveBeenCalled();
  });

  it("rejects cross-project observations and caller supplied authority", async () => {
    const { app, observe } = await createApp();
    apps.push(app);
    const body = {
      generationContractId: "66666666-6666-4666-8666-666666666666",
      observedState: "RUNNING|IN_PROGRESS|PENDING|PENDING",
      clientObservedAt: "2026-09-08T00:00:00.000Z",
    };
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/projects/other-project/backlinks/recommendation-feed/observations",
      payload: body,
    });
    expect(denied.statusCode).toBe(403);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-one/backlinks/recommendation-feed/observations",
      payload: { ...body, jobId: body.generationContractId },
    });
    expect(invalid.statusCode).toBe(400);
    expect(observe).not.toHaveBeenCalled();
  });

  it("registers a pure released-feed GET with only Phase 6 filters", async () => {
    const { app, query } = await createApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-one/backlinks/recommendation-feed" +
        "?recommendedOnly=true&category=Editorial&trafficMin=10&trafficMax=1000" +
        "&rankMin=20&rankMax=90&spamMin=0&spamMax=20&sort=rank_desc" +
        "&limit=25&domainSearch=Example",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          itemId: publicItem.itemId,
          domain: publicItem.domain,
          displayUrl: publicItem.displayUrl,
          recommended: publicItem.recommended,
          reasons: publicItem.recommendationReasons,
          category: publicItem.category,
          metrics: publicItem.metrics,
          contact: publicItem.contact,
          opportunity: publicItem.opportunity,
          archived: false,
          releasedAt: publicItem.releasedAt,
        },
      ],
      releasedPool: {
        generationCount: 2,
        oldestVisiblePoolGeneration: 1,
        newestVisiblePoolGeneration: 2,
      },
      latestGeneration: {
        generationContractId: "66666666-6666-4666-8666-666666666666",
        visiblePoolGeneration: 3,
        jobState: "RUNNING",
        progress: 40,
      },
      totalCount: 1,
      nextCursor: "next-cursor",
    });
    expect(query.list).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: projectContext.tenant,
        project: projectContext.project,
        actor,
      }),
      expect.objectContaining({
        recommendedOnly: true,
        category: "Editorial",
        trafficMin: 10,
        trafficMax: 1000,
        rankMin: 20,
        rankMax: 90,
        spamMin: 0,
        spamMax: 20,
        sort: "rank_desc",
        limit: 25,
        domainSearch: "Example",
      }),
    );
  });

  it("serializes a ready project with no generation as a successful empty feed", async () => {
    const query = createQuery();
    vi.mocked(query.list).mockResolvedValue({
      items: [],
      releasedPool: {
        generationCount: 0,
        oldestVisiblePoolGeneration: null,
        newestVisiblePoolGeneration: null,
      },
      latestGeneration: null,
      totalCount: 0,
      nextCursor: null,
    });
    const { app } = await createApp(query);
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-one/backlinks/recommendation-feed",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [], latestGeneration: null, totalCount: 0, nextCursor: null,
    });
  });

  it("rejects hidden/internal filters and invalid limits", async () => {
    const { app, query } = await createApp();
    apps.push(app);

    for (const queryString of [
      "internalScoreMin=1",
      "archived=true",
      "language=en",
      "limit=0",
      "limit=101",
      "limit=-1",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/project-one/backlinks/recommendation-feed?${queryString}`,
      });
      expect(response.statusCode).toBe(400);
    }

    expect(query.list).not.toHaveBeenCalled();
  });

  it("fails closed when the actor lacks project access", async () => {
    const { app, query } = await createApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/foreign-project/backlinks/recommendation-feed",
    });

    expect(response.statusCode).toBe(403);
    expect(query.list).not.toHaveBeenCalled();
  });

  it("exports only selected or currently filtered entitled items", async () => {
    const { app, query } = await createApp();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-one/backlinks/recommendation-feed/export",
      payload: {
        selectedItemIds: [publicItem.itemId],
        filters: {
          recommendedOnly: true,
          category: "Editorial",
          sort: "domain_asc",
          domainSearch: "example",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(
      "backlink-recommendations.csv",
    );
    expect(response.body).toContain("example.com");
    expect(query.export).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: projectContext.tenant,
        project: projectContext.project,
        actor,
      }),
      {
        selectedItemIds: [publicItem.itemId],
        recommendedOnly: true,
        category: "Editorial",
        sort: "domain_asc",
        domainSearch: "example",
      },
    );
  });

  it("keeps export strict and rejects cursor paging or unknown fields", async () => {
    const { app, query } = await createApp();
    apps.push(app);

    for (const payload of [
      { filters: { cursor: "page-two" } },
      { filters: { hiddenCount: true } },
      { selectedItemIds: [] },
      { selectedItemIds: ["not-a-uuid"] },
      { selectedItemIds: [publicItem.itemId], internalEvidence: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects/project-one/backlinks/recommendation-feed/export",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    expect(query.export).not.toHaveBeenCalled();
  });

  it("registers only the Phase 6 read and export operations", async () => {
    const { app } = await createApp();
    apps.push(app);

    const document = app.swagger();
    const feedPath =
      document.paths?.[
        "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-feed"
      ];
    const exportPath =
      document.paths?.[
        "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-feed/export"
      ];

    expect(feedPath?.get?.operationId).toBe(
      "backlinksListRecommendationFeedV2",
    );
    expect(exportPath?.post?.operationId).toBe(
      "backlinksExportRecommendationFeedV2",
    );
    expect(feedPath?.post).toBeUndefined();
  });
});
