import { describe, expect, it } from "vitest";

import {
  createSendIntentCommands,
} from "../../src/modules/backlinks/application/commands/send-intent.command.js";
import type {
  CreateSendIntentRecordInput,
  SendIntentRepository,
} from "../../src/modules/backlinks/application/services/send-intent.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError } from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const sendIntentId = "018f0000-0000-7000-8000-000000000114";
const outboxEventId = "018f0000-0000-7000-8000-000000000214";
const quotaReservationId = "018f0000-0000-7000-8000-000000000215";
const draftId = "018f0000-0000-7000-8000-000000000314";
const approvedDraftVersionId =
  "018f0000-0000-7000-8000-000000000414";
const gmailConnectionId = "018f0000-0000-7000-8000-000000000514";
const requestedSendAt = new Date("2026-07-27T10:14:00.000Z");
const context = {
  actor: createActorContext({
    userId: "user-114",
    sessionId: "session-114",
    roles: ["member"],
  }),
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
};

const input = {
  context,
  draftId,
  approvedDraftVersionId,
  gmailConnectionId,
  messagePurpose: "FOLLOW_UP" as const,
  followUpIndex: 1,
  idempotencyKey: "send-intent-114",
};
const createdIntent = {
  sendIntentId,
  draftId,
  approvedDraftVersionId,
  status: "READY" as const,
  version: 1,
  requestedSendAt: requestedSendAt.toISOString(),
};

describe("BL-AI-114/115 Send Intent command", () => {
  it("derives the logical key and asks the repository for one atomic write", async () => {
    let recorded: CreateSendIntentRecordInput | undefined;
    const repository: SendIntentRepository = {
      async create(candidate) {
        recorded = candidate;
        return { state: "created", intent: createdIntent };
      },
    };
    const ids = [sendIntentId, quotaReservationId, outboxEventId];
    const commands = createSendIntentCommands({
      repository,
      newId: () => ids.shift() ?? "unexpected-id",
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).resolves.toEqual({
      sendIntentId,
      draftId,
      approvedDraftVersionId,
      status: "READY",
      version: 1,
      requestedSendAt: requestedSendAt.toISOString(),
    });
    expect(recorded).toMatchObject({
      organizationId: "organization-114",
      workspaceId: "workspace-114",
      websiteProjectId: "project-114",
      sendIntentId,
      quotaReservationId,
      outboxEventId,
      draftId,
      approvedDraftVersionId,
      gmailConnectionId,
      clientIdempotencyKey: "send-intent-114",
      messagePurpose: "FOLLOW_UP",
      followUpIndex: 1,
      requestedSendAt,
      rolling24HourSendLimit: 5,
      minimumIntervalSeconds: 300,
      reservationTtlSeconds: 600,
      actorId: "user-114",
    });
    expect(recorded?.logicalMessageKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the original Intent projection when the repository replays", async () => {
    const replayedAt = "2026-07-27T09:00:00.000Z";
    const repository: SendIntentRepository = {
      async create() {
        return {
          state: "replayed",
          intent: {
            ...createdIntent,
            sendIntentId: "018f0000-0000-7000-8000-000000000999",
            requestedSendAt: replayedAt,
          },
        };
      },
    };
    const commands = createSendIntentCommands({
      repository,
      newId: () => sendIntentId,
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).resolves.toEqual({
      ...createdIntent,
      sendIntentId: "018f0000-0000-7000-8000-000000000999",
      requestedSendAt: replayedAt,
    });
  });

  it("rejects unauthorized actors and invalid purpose/index combinations", async () => {
    let calls = 0;
    const repository: SendIntentRepository = {
      async create() {
        calls += 1;
        return { state: "created", intent: createdIntent };
      },
    };
    const commands = createSendIntentCommands({
      repository,
      newId: () => sendIntentId,
      now: () => requestedSendAt,
    });

    await expect(commands.create({
      ...input,
      context: {
        ...context,
        actor: createActorContext({
          userId: "viewer-114",
          sessionId: "viewer-session-114",
          roles: ["viewer"],
        }),
      },
    })).rejects.toMatchObject<Partial<BacklinkError>>({
      code: "BACKLINK_ACCESS_DENIED",
    });
    await expect(commands.create({
      ...input,
      messagePurpose: "INITIAL_OUTREACH",
      followUpIndex: 1,
    })).rejects.toMatchObject<Partial<BacklinkError>>({
      code: "BACKLINK_INVALID_REQUEST",
      fieldErrors: [{
        field: "followUpIndex",
        message: "Initial outreach and negotiation replies require index 0.",
      }],
    });
    expect(calls).toBe(0);
  });

  it.each([
    [{ state: "draft_not_found" }, "BACKLINK_NOT_FOUND"],
    [{ state: "draft_not_approved" }, "BACKLINK_CONFLICT"],
    [{ state: "gmail_connection_unavailable" }, "BACKLINK_NOT_FOUND"],
    [{ state: "conflict" }, "BACKLINK_CONFLICT"],
    [{
      state: "quota_exceeded",
      dailyLimit: 5,
      retryAt: "2026-07-28T10:14:00.000Z",
    }, "BACKLINK_RATE_LIMITED"],
  ] as const)("maps repository state $state to %s", async (result, code) => {
    const repository: SendIntentRepository = {
      async create() {
        return result;
      },
    };
    const commands = createSendIntentCommands({
      repository,
      newId: () => sendIntentId,
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).rejects.toMatchObject<
      Partial<BacklinkError>
    >({ code });
  });
});
