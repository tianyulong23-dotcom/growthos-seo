import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createSendIntentCommands,
} from "../../../src/modules/backlinks/application/commands/send-intent.command.js";
import type {
  CreateSendIntentRecordInput,
  SendIntentRepository,
  SendIntentRepositoryResult,
} from "../../../src/modules/backlinks/application/services/send-intent.repository.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  registerBacklinksSendIntentRoute,
} from "../../../src/modules/backlinks/api/send-intent.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";

const draftId = "018f0000-0000-7000-8000-000000000314";
const approvedDraftVersionId =
  "018f0000-0000-7000-8000-000000000414";
const gmailConnectionId = "018f0000-0000-7000-8000-000000000514";
const sendIntentId = "018f0000-0000-7000-8000-000000000114";
const outboxEventId = "018f0000-0000-7000-8000-000000000214";
const quotaReservationId = "018f0000-0000-7000-8000-000000000215";
const requestedSendAt = "2026-07-27T10:14:00.000Z";
const createdIntent = {
  sendIntentId,
  draftId,
  approvedDraftVersionId,
  status: "READY" as const,
  version: 1,
  requestedSendAt,
};

describe("BL-AI-114/115 approved Send Intent API", () => {
  let app: FastifyInstance;
  let repositoryState: SendIntentRepositoryResult = {
    state: "created",
    intent: createdIntent,
  };
  let recorded: CreateSendIntentRecordInput | undefined;

  beforeEach(async () => {
    repositoryState = { state: "created", intent: createdIntent };
    recorded = undefined;
    const member = createActorContext({
      userId: "user-114",
      sessionId: "session-114",
      roles: ["member"],
    });
    const repository: SendIntentRepository = {
      async create(input) {
        recorded = input;
        return repositoryState;
      },
    };
    const ids = [sendIntentId, quotaReservationId, outboxEventId];
    app = Fastify({ logger: false, genReqId: () => "request-114" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = request.headers["x-role"] === "viewer"
        ? createActorContext({
            userId: "viewer-114",
            sessionId: "viewer-session-114",
            roles: ["viewer"],
          })
        : member;
    });
    registerBacklinksSendIntentRoute(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor }) => ({
            actor,
            tenant: createTenantContext({
              organizationId: "organization-114",
              workspaceId: "workspace-114",
            }),
            project: createProjectContext({
              websiteProjectId: "project-114",
              canonicalDomain: "example.com",
              locale: "en-US",
              countryCode: "US",
              profileVersionId: "profile-114",
              promotionTargetVersionId: "target-114",
            }),
          }),
        },
        queries: {},
      }),
      commands: createSendIntentCommands({
        repository,
        newId: () => ids.shift() ?? "unexpected-id",
        now: () => new Date("2026-07-27T10:14:00.000Z"),
      }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 201 after creating only the approved Intent request", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-114" },
      payload: {
        approvedDraftVersionId,
        gmailConnectionId,
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 1,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      sendIntentId,
      draftId,
      approvedDraftVersionId,
      status: "READY",
      version: 1,
      requestedSendAt,
      meta: {
        organizationId: "organization-114",
        workspaceId: "workspace-114",
        websiteProjectId: "project-114",
        requestId: "request-114",
        schemaVersion: "backlinks.v1",
      },
    });
    expect(recorded).toMatchObject({
      clientIdempotencyKey: "send-intent-114",
      quotaReservationId,
      approvedDraftVersionId,
      gmailConnectionId,
      messagePurpose: "FOLLOW_UP",
      followUpIndex: 1,
    });
  });

  it("rejects missing idempotency, invalid follow-up index, and viewers", async () => {
    const url =
      `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`;
    expect((await app.inject({
      method: "POST",
      url,
      payload: {
        approvedDraftVersionId,
        gmailConnectionId,
        messagePurpose: "INITIAL_OUTREACH",
        followUpIndex: 0,
      },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": "send-intent-invalid" },
      payload: {
        approvedDraftVersionId,
        gmailConnectionId,
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 0,
      },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url,
      headers: {
        "idempotency-key": "send-intent-viewer",
        "x-role": "viewer",
      },
      payload: {
        approvedDraftVersionId,
        gmailConnectionId,
        messagePurpose: "INITIAL_OUTREACH",
        followUpIndex: 0,
      },
    })).statusCode).toBe(403);
  });

  it("returns conflict for a Draft that is no longer exactly approved", async () => {
    repositoryState = { state: "draft_not_approved" };
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-stale" },
      payload: {
        approvedDraftVersionId,
        gmailConnectionId,
        messagePurpose: "NEGOTIATION_REPLY",
        followUpIndex: 0,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "BACKLINK_CONFLICT",
    });
  });

  it("returns 429 without creating an orphan Intent when quota is exhausted", async () => {
    repositoryState = {
      state: "quota_exceeded",
      dailyLimit: 5,
      retryAt: "2026-07-28T10:14:00.000Z",
    };
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-quota" },
      payload: {
        approvedDraftVersionId,
        gmailConnectionId,
        messagePurpose: "INITIAL_OUTREACH",
        followUpIndex: 0,
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "BACKLINK_RATE_LIMITED",
      retryable: true,
    });
  });
});
