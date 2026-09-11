import { readFile } from "node:fs/promises";

import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import type { RecommendationUserReleaseCommands } from "../../../src/modules/backlinks/application/commands/recommendation-user-release.command.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { registerBacklinksRecommendationUserReleaseRoutes } from "../../../src/modules/backlinks/api/recommendation-user-release.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";

const member = createActorContext({
  userId: "release-member",
  sessionId: "release-session",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
  }),
  project: createProjectContext({
    websiteProjectId: "00000000-0000-4000-8000-000000000003",
    canonicalDomain: "project.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-v1",
    promotionTargetVersionId: "promotion-v1",
  }),
};

describe("Phase 5 recommendation user release routes", () => {
  const commands = {
    getStatus: vi.fn().mockResolvedValue({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      requiredOpportunityCount: 7,
      successfulOpportunityCount: 7,
      unlockAt: new Date("2026-08-31T00:00:00.000Z"),
      unlockReason: "OPPORTUNITY_RATIO",
      canGetMore: true,
      getMoreState: "RELEASE_NEXT",
    }),
    publishInitial: vi.fn().mockResolvedValue({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: false,
    }),
    getMore: vi.fn().mockResolvedValue({
      state: "POOL_EXHAUSTED",
      currentBatchOrdinal: 2,
      releasedBatchOrdinal: null,
      replayed: false,
    }),
    setArchived: vi.fn().mockImplementation(async (input) => ({
      itemId: input.itemId,
      archived: input.archived,
      replayed: false,
    })),
  } satisfies RecommendationUserReleaseCommands;
  const app = Fastify({
    logger: false,
    genReqId: () => "release-route-request",
  });

  afterAll(() => app.close());

  it("exposes only Phase 5 actor publication commands on the production route contract", async () => {
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = member;
    });
    registerBacklinksRecommendationUserReleaseRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor }) => ({ ...context, actor }),
        },
        queries: {},
      }),
      commands,
    });
    await app.ready();

    const published = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-user-release/publish-initial",
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      meta: {
        schemaVersion: "backlinks.recommendation-user-release.v2",
        requestId: "release-route-request",
      },
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/recommendation-user-release/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      state: "PUBLISHED",
      unlockAt: "2026-08-31T00:00:00.000Z",
      canGetMore: true,
      getMoreState: "RELEASE_NEXT",
    });

    const exhausted = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-user-release/get-more",
      headers: { "idempotency-key": "release-get-more" },
    });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toMatchObject({
      state: "POOL_EXHAUSTED",
      currentBatchOrdinal: 2,
      releasedBatchOrdinal: null,
    });

    const archived = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-user-release/items/00000000-0000-4000-8000-000000000004/archive",
      headers: { "idempotency-key": "release-archive" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      itemId: "00000000-0000-4000-8000-000000000004",
      archived: true,
    });

    const unarchived = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-user-release/items/00000000-0000-4000-8000-000000000004/unarchive",
      headers: { "idempotency-key": "release-unarchive" },
    });
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json()).toMatchObject({
      itemId: "00000000-0000-4000-8000-000000000004",
      archived: false,
    });

    expect(commands.publishInitial).toHaveBeenCalledWith({ context });
    expect(commands.getStatus).toHaveBeenCalledWith({ context });
    expect(commands.getMore).toHaveBeenCalledWith({
      context,
      idempotencyKey: "release-get-more",
    });
    expect(commands.setArchived).toHaveBeenNthCalledWith(1, {
      context,
      itemId: "00000000-0000-4000-8000-000000000004",
      archived: true,
      idempotencyKey: "release-archive",
    });
    expect(commands.setArchived).toHaveBeenNthCalledWith(2, {
      context,
      itemId: "00000000-0000-4000-8000-000000000004",
      archived: false,
      idempotencyKey: "release-unarchive",
    });
  });

  it("keeps Phase 5 release composition while registering the Phase 6 read feed", async () => {
    const [privateServer, productionRuntime] = await Promise.all([
      readFile(
        new URL(
          "../../../src/modules/backlinks/api/private-server.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../src/modules/backlinks/runtime/production-runtime.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(privateServer).toContain(
      "registerBacklinksRecommendationUserReleaseRoutes",
    );
    expect(privateServer).toContain("recommendationUserReleaseCommands");
    expect(productionRuntime).toContain(
      "createRecommendationUserReleaseRepository",
    );
    expect(productionRuntime).toContain(
      "createRecommendationUserReleaseCommands",
    );
    expect(productionRuntime).toContain("recommendationUserReleaseCommands,");
    expect(privateServer).toContain("recommendation-feed.route");
    expect(privateServer).toContain("registerRecommendationFeedRoutes");
    expect(productionRuntime).toContain("createRecommendationFeedRepository");
    expect(productionRuntime).toContain("recommendationFeedRepository,");
  });
});
