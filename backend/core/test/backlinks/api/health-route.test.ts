import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerBacklinksHealthRoute } from "../../../src/modules/backlinks/api/health.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { createBacklinksApiRuntimeHealth } from "../../../src/modules/backlinks/runtime/runtime-health.js";

const apps: FastifyInstance[] = [];

async function createTestApp(enabled: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);

  await registerBacklinksOpenApi(app);
  registerBacklinksHealthRoute(app, {
    BACKLINKS_API_ENABLED: enabled,
  }, createBacklinksApiRuntimeHealth({}, "build-health-test"));
  await app.ready();

  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("registerBacklinksHealthRoute", () => {
  it("returns the strict health response and publishes its schema", async () => {
    const app = await createTestApp(true);
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      process: "api",
      buildId: "build-health-test",
      providers: {
        dataForSeo: {
          configured: false,
          externalAvailability: "disabled",
          reasonCode: "provider_disabled",
          recoveryAction: "enable_provider",
        },
        browser: {
          configured: false,
          externalAvailability: "disabled",
          reasonCode: "provider_disabled",
          recoveryAction: "enable_provider",
        },
        ai: {
          configured: false,
          externalAvailability: "disabled",
          reasonCode: "provider_disabled",
          recoveryAction: "enable_provider",
        },
        gmail: {
          configured: false,
          externalAvailability: "disabled",
          reasonCode: "provider_disabled",
          recoveryAction: "enable_provider",
        },
      },
    });
    expect(app.swagger()).toMatchObject({
      paths: {
        "/health": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        status: { type: "string" },
                        process: { type: "string" },
                        buildId: {
                          type: "string",
                          nullable: true,
                        },
                        providers: { type: "object" },
                      },
                      required: [
                        "status",
                        "process",
                        "buildId",
                        "providers",
                      ],
                      additionalProperties: false,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("does not register the route when the backlinks API is disabled", async () => {
    const app = await createTestApp(false);
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(404);
    expect(app.swagger().paths).not.toHaveProperty("/health");
  });
});
