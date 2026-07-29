import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerBacklinksHealthRoute } from "../../../src/modules/backlinks/api/health.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";

const apps: FastifyInstance[] = [];

async function createTestApp(enabled: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);

  await registerBacklinksOpenApi(app);
  registerBacklinksHealthRoute(app, {
    BACKLINKS_API_ENABLED: enabled,
  });
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
    expect(response.json()).toEqual({ status: "ok" });
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
                      },
                      required: ["status"],
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
