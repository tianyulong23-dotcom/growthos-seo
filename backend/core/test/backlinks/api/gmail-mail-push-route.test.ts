import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerBacklinksGmailMailPushRoute,
} from "../../../src/modules/backlinks/api/gmail-mail-push.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  GmailPushWebhookError,
  gmailPushWebhookFailureCodes,
} from "../../../src/modules/backlinks/application/workflows/mail-push-webhook.js";
import {
  GmailPushIdentityError,
  gmailPushIdentityFailureCodes,
} from "../../../src/modules/backlinks/adapters/gmail/sync-push-verifier.js";

const body = {
  message: {
    data: Buffer.from(JSON.stringify({
      emailAddress: "owner@example.test",
      historyId: "99141",
    })).toString("base64"),
    messageId: "1410000000001",
  },
  subscription:
    "projects/growthos/subscriptions/backlinks-gmail-push",
};

const apps: FastifyInstance[] = [];

async function createApp(handle: (input: Readonly<{
  authorizationHeader?: string | readonly string[];
  body: unknown;
}>) => Promise<Readonly<{ accepted: true; duplicate: boolean }>>) {
  const app = Fastify({ logger: false, genReqId: () => "request-141" });
  apps.push(app);
  await registerBacklinksOpenApi(app);
  registerBacklinksGmailMailPushRoute(app, {
    webhook: { handle },
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("BL-AI-141 Gmail Push Webhook API", () => {
  it("acknowledges new and duplicate notifications without data leakage", async () => {
    const handle = vi.fn()
      .mockResolvedValueOnce({ accepted: true, duplicate: false })
      .mockResolvedValueOnce({ accepted: true, duplicate: true });
    const app = await createApp(handle);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/backlinks/mail/gmail-push",
      headers: { authorization: "Bearer header.payload.signature" },
      payload: body,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/backlinks/mail/gmail-push",
      headers: { authorization: "Bearer header.payload.signature" },
      payload: body,
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: true, duplicate: false });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect(first.body).not.toMatch(/owner@example|99141|messageId/iu);
    expect(handle).toHaveBeenCalledWith({
      authorizationHeader: "Bearer header.payload.signature",
      body,
    });
  });

  it.each([
    [
      401,
      new GmailPushIdentityError(
        gmailPushIdentityFailureCodes.unauthenticated,
      ),
    ],
    [
      403,
      new GmailPushWebhookError(
        gmailPushWebhookFailureCodes.unauthorizedTarget,
      ),
    ],
    [
      400,
      new GmailPushWebhookError(
        gmailPushWebhookFailureCodes.invalidNotification,
      ),
    ],
    [
      503,
      new GmailPushWebhookError(gmailPushWebhookFailureCodes.disabled),
    ],
  ])("maps rejected requests to HTTP %i", async (status, error) => {
    const app = await createApp(async () => {
      throw error;
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/backlinks/mail/gmail-push",
      headers: { authorization: "Bearer header.payload.signature" },
      payload: body,
    });

    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(response.json()).toMatchObject({
      status,
      requestId: "request-141",
    });
    expect(response.body).not.toContain("header.payload.signature");
  });
});
