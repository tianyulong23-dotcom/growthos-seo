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
const contactId = "018f0000-0000-7000-8000-000000000614";
const sendIntentId = "018f0000-0000-7000-8000-000000000114";
const outboxEventId = "018f0000-0000-7000-8000-000000000214";
const quotaReservationId = "018f0000-0000-7000-8000-000000000215";
const sendSnapshotId = "018f0000-0000-7000-8000-000000000216";
const sendAttemptId = "018f0000-0000-7000-8000-000000000217";
const contactVersion = 3;
const requestedSendAt = "2026-07-27T10:14:00.000Z";
const createdIntent = {
  sendIntentId,
  sendSnapshotId,
  draftId,
  approvedDraftVersionId,
  contactId,
  contactVersion,
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
  let queriedId: string | undefined;

  beforeEach(async () => {
    repositoryState = { state: "created", intent: createdIntent };
    recorded = undefined;
    queriedId = undefined;
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
    const ids = [
      sendIntentId,
      quotaReservationId,
      outboxEventId,
      sendSnapshotId,
    ];
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
        queries: {
          getSendIntent: async (_context, id) => {
            queriedId = id;
            return {
              sendIntentId,
              draftId,
              status: "PROVIDER_ACCEPTED",
              version: 3,
              requestedSendAt,
              updatedAt: "2026-07-27T10:14:02.000Z",
              attempt: {
                attemptId: sendAttemptId,
                attemptNo: 1,
                status: "PROVIDER_ACCEPTED",
                rfcMessageId: "<send-intent-114@example.com>",
                providerMessageId: "gmail-message-114",
                providerThreadId: "gmail-thread-114",
                errorCode: null,
                startedAt: "2026-07-27T10:14:01.000Z",
                completedAt: "2026-07-27T10:14:02.000Z",
                retryEligibleAt: null,
              },
            };
          },
        },
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

  it("returns the persisted Send Intent and latest provider attempt", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/project-key/backlinks/send-intents/${sendIntentId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sendIntent: {
        sendIntentId,
        draftId,
        status: "PROVIDER_ACCEPTED",
        version: 3,
        attempt: {
          attemptId: sendAttemptId,
          status: "PROVIDER_ACCEPTED",
          providerMessageId: "gmail-message-114",
          providerThreadId: "gmail-thread-114",
        },
      },
      meta: {
        organizationId: "organization-114",
        workspaceId: "workspace-114",
        websiteProjectId: "project-114",
        requestId: "request-114",
      },
    });
    expect(queriedId).toBe(sendIntentId);
  });

  it("returns 201 after creating only the approved Intent request", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-114" },
      payload: {
        approvedDraftVersionId,
        contactId,
        contactVersion,
        gmailConnectionId,
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 1,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      sendIntentId,
      sendSnapshotId,
      draftId,
      approvedDraftVersionId,
      contactId,
      contactVersion,
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
      sendSnapshotId,
      approvedDraftVersionId,
      contactId,
      contactVersion,
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
        contactId,
        contactVersion,
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
        contactId,
        contactVersion,
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
        contactId,
        contactVersion,
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
        contactId,
        contactVersion,
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
        contactId,
        contactVersion,
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

  it.each([
    [{ state: "contact_unavailable" }, 404, "BACKLINK_NOT_FOUND"],
    [{ state: "contact_version_conflict" }, 409, "BACKLINK_CONFLICT"],
    [{
      state: "initial_outreach_cooldown",
      retryAt: "2026-08-26T10:14:00.000Z",
    }, 429, "BACKLINK_RATE_LIMITED"],
  ] as const)(
    "maps Contact policy state $state through the API",
    async (state, statusCode, code) => {
      repositoryState = state;
      const response = await app.inject({
        method: "POST",
        url:
          `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
        headers: { "idempotency-key": `send-intent-${state.state}` },
        payload: {
          approvedDraftVersionId,
          contactId,
          contactVersion,
          gmailConnectionId,
          messagePurpose: "INITIAL_OUTREACH",
          followUpIndex: 0,
        },
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ code });
    },
  );
});
