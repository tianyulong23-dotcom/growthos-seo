import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createSendIntentCommands,
} from "../../../src/modules/backlinks/application/commands/send-intent.command.js";
import type {
  CreateSendIntentRecordInput,
  SendIntentPreflightRepositoryResult,
  SendIntentRepository,
  SendIntentRepositoryResult,
} from "../../../src/modules/backlinks/application/services/send-intent.repository.js";
import {
  createGmailSendReadinessSnapshot,
  gmailSendReadinessConditionCodes,
} from "../../../src/modules/backlinks/application/services/send-policy-gate.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  registerBacklinksSendIntentListRoute,
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
const opportunityId = "018f0000-0000-7000-8000-000000000814";
const gmailIdentityId = "018f0000-0000-7000-8000-000000000516";
const contactVersion = 3;
const requestedSendAt = "2026-07-27T10:14:00.000Z";
const readinessConditions = gmailSendReadinessConditionCodes.map(
  (code, index) => ({
    code,
    revision: `revision-${index + 1}`,
  }),
);
const readinessSnapshot = createGmailSendReadinessSnapshot({
  evaluatedAt: new Date(requestedSendAt),
  conditions: readinessConditions,
});
const createPayload = (
  overrides: Record<string, unknown> = {},
) => ({
  approvedDraftVersionId,
  contactId,
  contactVersion,
  gmailConnectionId,
  messagePurpose: "INITIAL_OUTREACH",
  followUpIndex: 0,
  readinessSnapshot,
  humanConfirmation: {
    confirmed: true,
    confirmedAt: requestedSendAt,
    readinessSnapshotVersion: readinessSnapshot.snapshotVersion,
  },
  ...overrides,
});
const tokenSecretReference = {
  provider: "platform-secret-store",
  secretKind: "GMAIL_TOKEN_SET" as const,
  externalSecretId: "gmail_token_set/connection-114",
  externalSecretVersion: "v1",
};
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
  let preflightState: SendIntentPreflightRepositoryResult = {
    state: "allowed",
    tokenSecretReference,
    readinessConditions,
    gmail: {
      connectionId: gmailConnectionId,
      primaryEmail: "sender@example.test",
      connectionStatus: "CONNECTED",
      sendAvailability: "AVAILABLE",
      mailSyncCapability: true,
    },
  };
  let recorded: CreateSendIntentRecordInput | undefined;
  let queriedId: string | undefined;
  let listedQueueKind: string | undefined;

  beforeEach(async () => {
    repositoryState = { state: "created", intent: createdIntent };
    preflightState = {
      state: "allowed",
      tokenSecretReference,
      readinessConditions,
      gmail: {
        connectionId: gmailConnectionId,
        primaryEmail: "sender@example.test",
        connectionStatus: "CONNECTED",
        sendAvailability: "AVAILABLE",
        mailSyncCapability: true,
      },
    };
    recorded = undefined;
    queriedId = undefined;
    listedQueueKind = undefined;
    const member = createActorContext({
      userId: "user-114",
      sessionId: "session-114",
      roles: ["member"],
    });
    const repository: SendIntentRepository & {
      preflight(): Promise<SendIntentPreflightRepositoryResult>;
    } = {
      async preflight() {
        return preflightState;
      },
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
    const backlinksModule = createBacklinksModule({
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
          listSendIntents: async (_context, input) => {
            listedQueueKind = input.queueKind;
            return {
              items: [{
                sendIntentId,
                opportunityId,
                draftId,
                approvedDraftVersionId,
                messagePurpose: "INITIAL_OUTREACH",
                followUpIndex: 0,
                status: "DELIVERY_UNKNOWN",
                queueKind: "RECONCILIATION_REQUIRED",
                version: 3,
                requestedSendAt,
                updatedAt: "2026-07-27T10:14:02.000Z",
                deliveryEnvelope: {
                  sendSnapshotId,
                  gmailConnectionId,
                  gmailAccountEmail: "account@example.test",
                  gmailIdentityId,
                  fromAddress: "sender@example.test",
                  recipient: "recipient@example.test",
                  contactId,
                  contactVersion,
                  approvalRecordedAt: requestedSendAt,
                },
                diagnostics: {
                  operationId: sendIntentId,
                  operationCheckpoint: "PROVIDER_RESULT_UNKNOWN",
                  retryable: false,
                  resubmittable: false,
                  nextRetryAt: null,
                  costUncertainty: "UNKNOWN",
                  workerMode: "normal",
                  buildIdentity: "phase-9-test",
                  primaryNextAction: "RECONCILE_BEFORE_RETRY",
                },
                attempt: null,
              }],
              nextCursor: null,
              hasMore: false,
            };
          },
          getSendIntent: async (_context, id) => {
            queriedId = id;
            return {
              sendIntentId,
              opportunityId,
              draftId,
              approvedDraftVersionId,
              messagePurpose: "INITIAL_OUTREACH",
              followUpIndex: 0,
              status: "PROVIDER_ACCEPTED",
              queueKind: "WAITING_REPLY",
              version: 3,
              requestedSendAt,
              updatedAt: "2026-07-27T10:14:02.000Z",
              deliveryEnvelope: {
                sendSnapshotId,
                gmailConnectionId,
                gmailAccountEmail: "account@example.test",
                gmailIdentityId,
                fromAddress: "sender@example.test",
                recipient: "recipient@example.test",
                contactId,
                contactVersion,
                approvalRecordedAt: requestedSendAt,
              },
              diagnostics: {
                operationId: sendIntentId,
                operationCheckpoint: "PROVIDER_ACCEPTANCE_PERSISTED",
                retryable: false,
                resubmittable: false,
                nextRetryAt: null,
                costUncertainty: "NONE",
                workerMode: "normal",
                buildIdentity: "phase-9-test",
                primaryNextAction: "START_OR_CONTINUE_SYNC",
              },
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
      });
    registerBacklinksSendIntentListRoute(app, {
      module: backlinksModule,
    });
    registerBacklinksSendIntentRoute(app, {
      module: backlinksModule,
      commands: createSendIntentCommands({
        repository,
        sendRuntimeEnabled: true,
        workerAvailable: async () => true,
        gmailCredentialAvailable: async () => true,
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
        opportunityId,
        draftId,
        approvedDraftVersionId,
        status: "PROVIDER_ACCEPTED",
        queueKind: "WAITING_REPLY",
        version: 3,
        deliveryEnvelope: {
          gmailAccountEmail: "account@example.test",
          fromAddress: "sender@example.test",
          recipient: "recipient@example.test",
        },
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

  it("lists the project Send Intent reconciliation queue", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/send-intents" +
        "?queueKind=RECONCILIATION_REQUIRED&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{
        sendIntentId,
        opportunityId,
        approvedDraftVersionId,
        queueKind: "RECONCILIATION_REQUIRED",
        deliveryEnvelope: {
          fromAddress: "sender@example.test",
          recipient: "recipient@example.test",
        },
        diagnostics: {
          primaryNextAction: "RECONCILE_BEFORE_RETRY",
        },
      }],
      hasMore: false,
      nextCursor: null,
      meta: {
        organizationId: "organization-114",
        workspaceId: "workspace-114",
        websiteProjectId: "project-114",
      },
    });
    expect(listedQueueKind).toBe("RECONCILIATION_REQUIRED");
  });

  it("returns 201 after creating only the approved Intent request", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-114" },
      payload: createPayload({
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 1,
      }),
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
      readinessSnapshot,
      humanConfirmation: {
        confirmed: true,
        confirmedAt: new Date(requestedSendAt),
        readinessSnapshotVersion: readinessSnapshot.snapshotVersion,
      },
    });
  });

  it("returns a NOT_SENT preflight without creating an Intent", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-preflight`,
      payload: {
        approvedDraftVersionId,
        contactId,
        contactVersion,
        gmailConnectionId,
        messagePurpose: "INITIAL_OUTREACH",
        followUpIndex: 0,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allowed: true,
      deliveryState: "NOT_SENT",
      readinessSnapshot,
      gmail: {
        connectionId: gmailConnectionId,
        primaryEmail: "sender@example.test",
      },
    });
    expect(recorded).toBeUndefined();
  });

  it("rejects missing idempotency, invalid follow-up index, and viewers", async () => {
    const url =
      `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`;
    expect((await app.inject({
      method: "POST",
      url,
      payload: createPayload(),
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": "send-intent-invalid" },
      payload: createPayload({
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 0,
      }),
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url,
      headers: {
        "idempotency-key": "send-intent-viewer",
        "x-role": "viewer",
      },
      payload: createPayload(),
    })).statusCode).toBe(403);
  });

  it("returns conflict for a Draft that is no longer exactly approved", async () => {
    repositoryState = { state: "draft_not_approved" };
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-stale" },
      payload: createPayload({
        messagePurpose: "NEGOTIATION_REPLY",
        followUpIndex: 0,
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "DRAFT_VERSION_STALE",
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
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: "BACKLINK_RATE_LIMITED",
      retryable: true,
    });
  });

  it.each([
    [{ state: "contact_unavailable" }, 404, "BACKLINK_NOT_FOUND"],
    [{
      state: "contact_version_conflict",
    }, 409, "CONTACT_VERSION_STALE"],
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
        payload: createPayload(),
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ code });
    },
  );

  it("returns exact readiness changes when the confirmed snapshot is stale", async () => {
    repositoryState = {
      state: "readiness_changed",
      changedConditions: [{
        code: "QUOTA",
        reason: "CHANGED",
        expectedRevision: "0/5",
        currentRevision: "5/5",
        retryable: true,
        recoveryAction: "WAIT_AND_RUN_PREFLIGHT",
      }],
    };
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/drafts/${draftId}/send-intents`,
      headers: { "idempotency-key": "send-intent-readiness-stale" },
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "SEND_READINESS_STALE",
      changedConditions: [{
        code: "QUOTA",
        reason: "CHANGED",
        expectedRevision: "0/5",
        currentRevision: "5/5",
        retryable: true,
        recoveryAction: "WAIT_AND_RUN_PREFLIGHT",
      }],
    });
  });
});
