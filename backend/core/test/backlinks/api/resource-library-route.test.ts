import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import type {
  ResourceLibraryQuery,
} from "../../../src/modules/backlinks/application/queries/resource-library.query.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  registerBacklinksResourceLibraryRoute,
} from "../../../src/modules/backlinks/api/resource-library.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";

const apps: FastifyInstance[] = [];
const url =
  "/api/v1/projects/project-key/backlinks/resource-library?limit=20";

async function createTestApp(roles: readonly string[]) {
  const actor = createActorContext({
    userId: "user-resource-library",
    sessionId: "session-resource-library",
    roles,
  });
  const resolve = vi.fn(async () => ({
    actor,
    tenant: createTenantContext({
      organizationId: "org-resource-library",
      workspaceId: "workspace-resource-library",
    }),
    project: createProjectContext({
      websiteProjectId: "project-resource-library",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-resource-library",
      promotionTargetVersionId: "target-resource-library",
    }),
  }));
  const listResourceLibrary = vi.fn<
    ResourceLibraryQuery["listResourceLibrary"]
  >(async () => ({
    projectAuthority: {
      score: 40,
      band: "growing",
      confidence: "backlink_profile",
      referringDomains: 80,
      minimumResourceAuthorityScore: 40,
    },
    summary: {
      total: 455,
      free: 455,
      paid: 0,
      recommend: 300,
      review: 100,
      avoid: 55,
      unclassified: 0,
      autoEligible: 200,
      authorityMatchedAutoEligible: 120,
    },
    items: [],
  }));
  const app = Fastify({ logger: false, genReqId: () => "request-resource" });
  apps.push(app);
  await registerBacklinksOpenApi(app);
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = actor;
  });
  registerBacklinksResourceLibraryRoute(app, {
    module: createBacklinksModule({
      projectContext: { resolve },
      queries: { listResourceLibrary },
    }),
  });
  await app.ready();
  return { app, resolve, listResourceLibrary };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("resource library diagnostic route", () => {
  it.each(["member", "owner"])(
    "does not expose the global catalog to %s users",
    async (role) => {
      const { app, resolve, listResourceLibrary } = await createTestApp([role]);

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "BACKLINK_ACCESS_DENIED",
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(listResourceLibrary).not.toHaveBeenCalled();
    },
  );

  it("keeps the global catalog available for admin diagnostics", async () => {
    const { app, resolve, listResourceLibrary } = await createTestApp([
      "admin",
    ]);

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: { total: 455 },
      items: [],
      meta: {
        websiteProjectId: "project-resource-library",
        requestId: "request-resource",
      },
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(listResourceLibrary).toHaveBeenCalledOnce();
  });
});
