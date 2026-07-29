import Fastify, { type FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";

const apps: FastifyInstance[] = [];

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);

  await registerBacklinksOpenApi(app);

  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/schema-probe",
    {
      schema: {
        body: z.object({ name: z.string().min(1) }).strict(),
        response: {
          200: z.object({ accepted: z.boolean() }),
        },
      },
    },
    async (request) => ({
      accepted: request.body.name === "GrowthOS",
      internal: "must not be serialized",
    }),
  );

  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("registerBacklinksOpenApi", () => {
  it("readies Fastify and publishes the fixed API info", async () => {
    const app = await createTestApp();

    expect(app.swagger()).toMatchObject({
      info: {
        title: "GrowthOS Backlinks API",
        version: "1.0.0",
      },
      paths: {
        "/schema-probe": {
          post: {},
        },
      },
    });
  });

  it("uses the Zod validator compiler", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/schema-probe",
      payload: { name: "" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("uses the Zod serializer compiler", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/schema-probe",
      payload: { name: "GrowthOS" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
  });
});
