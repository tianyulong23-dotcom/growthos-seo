import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerBacklinksRequestLoggingHook } from "../../../src/modules/backlinks/api/hooks/request-logging.hook.js";

const apps: FastifyInstance[] = [];

async function createTestApp(logLines: string[]): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => "request-1",
    logger: {
      level: "info",
      stream: {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    },
  });
  apps.push(app);
  registerBacklinksRequestLoggingHook(app);
  app.post("/email", async () => ({ status: "accepted" }));
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("registerBacklinksRequestLoggingHook", () => {
  it("propagates IDs while excluding authorization, tokens, and email content", async () => {
    const logLines: string[] = [];
    const app = await createTestApp(logLines);
    const response = await app.inject({
      method: "POST",
      url: "/email",
      headers: {
        authorization: "Bearer authorization-secret",
        "x-correlation-id": "correlation-1",
      },
      payload: {
        email: "private@example.com",
        body: "private email body",
        token: "oauth-token-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("request-1");
    expect(response.headers["x-correlation-id"]).toBe("correlation-1");

    const logText = logLines.join("");
    for (const forbidden of [
      "authorization",
      "authorization-secret",
      "private@example.com",
      "private email body",
      "oauth-token-secret",
    ]) {
      expect(logText).not.toContain(forbidden);
    }

    const completion = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "backlinks.request.completed");
    expect(completion).toMatchObject({
      event: "backlinks.request.completed",
      requestId: "request-1",
      correlationId: "correlation-1",
      method: "POST",
      route: "/email",
      statusCode: 200,
    });
  });
});
