import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerBacklinksAutomationBudgetRoute } from "../../../src/modules/backlinks/api/automation-budget.route";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module";
import { createActorContext, createProjectContext, createTenantContext } from "../../../src/modules/backlinks/domain/context";
import { BacklinkError, backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error";

async function appFor(draftReservationUsd: number | null) {
  const app = Fastify();
  const actor = createActorContext({ userId: "test-user", sessionId: "test-session", roles: ["member"] });
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => { request.actor = actor; });
  await registerBacklinksOpenApi(app);
  registerBacklinksAutomationBudgetRoute(app, {
    draftReservationUsd,
    module: createBacklinksModule({
      queries: {},
      projectContext: {
        async resolve({ websiteProjectKey }) {
          if (websiteProjectKey !== "allowed") {
            throw new BacklinkError({ code: backlinkErrorCodes.accessDenied, message: "Denied" });
          }
          return {
            actor,
            tenant: createTenantContext({ organizationId: "org", workspaceId: "workspace" }),
            project: createProjectContext({
              websiteProjectId: "project", canonicalDomain: "example.test", locale: "en-US",
              countryCode: "US", profileVersionId: "profile", promotionTargetVersionId: "promotion",
            }),
          };
        },
      },
    }),
  });
  return app;
}

describe("automation reservation quote", () => {
  it("returns scoped reservations without provider details or command execution", async () => {
    const app = await appFor(0.0123);
    try {
      const response = await app.inject("/api/v1/projects/allowed/backlinks/automation-budget");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accounting: "conservative_reservations",
        recommendationPaidReservationUsd: "2",
        draftModelReservationUsd: "0.0123",
        meta: { organizationId: "org", workspaceId: "workspace", websiteProjectId: "project",
          schemaVersion: "backlinks.automation-budget.v1" },
      });
      expect(JSON.stringify(response.json())).not.toMatch(/secret|credential|baseUrl/);
      const denied = await app.inject("/api/v1/projects/other/backlinks/automation-budget");
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "leaves unavailable bounds unknown (%s)", async (amount) => {
      const app = await appFor(amount);
      try {
        const response = await app.inject("/api/v1/projects/allowed/backlinks/automation-budget");
        expect(response.statusCode).toBe(200);
        expect(response.json().draftModelReservationUsd).toBeNull();
      } finally {
        await app.close();
      }
    },
  );
});
