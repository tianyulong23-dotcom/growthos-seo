import { describe, expect, it } from "vitest";

import {
  createSendIntentCommands,
} from "../../src/modules/backlinks/application/commands/send-intent.command.js";
import type {
  CreateSendIntentRecordInput,
  SendIntentPreflightRepository,
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
const contactId = "018f0000-0000-7000-8000-000000000614";
const sendSnapshotId = "018f0000-0000-7000-8000-000000000216";
const contactVersion = 3;
const requestedSendAt = new Date("2026-07-27T10:14:00.000Z");
const tokenSecretReference = {
  provider: "platform-secret-store",
  secretKind: "GMAIL_TOKEN_SET" as const,
  externalSecretId: "gmail_token_set/connection-114",
  externalSecretVersion: "v1",
};
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
  contactId,
  contactVersion,
  gmailConnectionId,
  messagePurpose: "FOLLOW_UP" as const,
  followUpIndex: 1,
  idempotencyKey: "send-intent-114",
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
  requestedSendAt: requestedSendAt.toISOString(),
};
const allowedPreflight = {
  state: "allowed" as const,
  tokenSecretReference,
  gmail: {
    connectionId: gmailConnectionId,
    primaryEmail: "sender@example.test",
    connectionStatus: "CONNECTED" as const,
    sendAvailability: "AVAILABLE" as const,
    mailSyncCapability: true,
  },
};
const withPreflight = (
  repository: SendIntentRepository,
): SendIntentRepository & SendIntentPreflightRepository => ({
  preflight: async () => allowedPreflight,
  create: (candidate) => repository.create(candidate),
});
const enabledRuntime = {
  sendRuntimeEnabled: true,
  workerAvailable: async () => true,
  gmailCredentialAvailable: async () => true,
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
    const ids = [
      sendIntentId,
      quotaReservationId,
      outboxEventId,
      sendSnapshotId,
    ];
    const commands = createSendIntentCommands({
      repository: withPreflight(repository),
      ...enabledRuntime,
      newId: () => ids.shift() ?? "unexpected-id",
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).resolves.toEqual({
      sendIntentId,
      sendSnapshotId,
      draftId,
      approvedDraftVersionId,
      contactId,
      contactVersion,
      status: "READY",
      version: 1,
      requestedSendAt: requestedSendAt.toISOString(),
    });
    expect(recorded).toMatchObject({
      organizationId: "organization-114",
      workspaceId: "workspace-114",
      websiteProjectId: "project-114",
      sendIntentId,
      sendSnapshotId,
      quotaReservationId,
      outboxEventId,
      draftId,
      approvedDraftVersionId,
      contactId,
      contactVersion,
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
      repository: withPreflight(repository),
      ...enabledRuntime,
      newId: () => sendIntentId,
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).resolves.toEqual({
      ...createdIntent,
      sendIntentId: "018f0000-0000-7000-8000-000000000999",
      requestedSendAt: replayedAt,
    });
  });

  it("uses the configured bounded local Gmail quota", async () => {
    let recorded: CreateSendIntentRecordInput | undefined;
    const repository: SendIntentRepository = {
      async create(candidate) {
        recorded = candidate;
        return { state: "created", intent: createdIntent };
      },
    };
    const commands = createSendIntentCommands({
      repository: withPreflight(repository),
      ...enabledRuntime,
      newId: () => sendIntentId,
      now: () => requestedSendAt,
      quotaProfile: {
        rolling24HourSendLimit: 20,
        minimumIntervalSeconds: 120,
      },
    });

    await commands.create(input);
    expect(recorded).toMatchObject({
      rolling24HourSendLimit: 20,
      minimumIntervalSeconds: 120,
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
      repository: withPreflight(repository),
      ...enabledRuntime,
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
    [{ state: "draft_not_approved" }, "DRAFT_VERSION_STALE"],
    [{
      state: "gmail_connection_unavailable",
    }, "GMAIL_CONNECTION_NOT_SELECTED"],
    [{ state: "contact_unavailable" }, "BACKLINK_NOT_FOUND"],
    [{ state: "contact_version_conflict" }, "CONTACT_VERSION_STALE"],
    [{ state: "conflict" }, "BACKLINK_CONFLICT"],
    [{
      state: "initial_outreach_cooldown",
      retryAt: "2026-08-26T10:14:00.000Z",
    }, "BACKLINK_RATE_LIMITED"],
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
      repository: withPreflight(repository),
      ...enabledRuntime,
      newId: () => sendIntentId,
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).rejects.toMatchObject<
      Partial<BacklinkError>
    >({ code });
  });

  it("returns a healthy NOT_SENT preflight without creating an Intent", async () => {
    let creates = 0;
    let credentialChecks = 0;
    const commands = createSendIntentCommands({
      repository: withPreflight({
        async create() {
          creates += 1;
          return { state: "created", intent: createdIntent };
        },
      }),
      sendRuntimeEnabled: true,
      workerAvailable: async () => true,
      gmailCredentialAvailable: async (candidate) => {
        credentialChecks += 1;
        expect(candidate).toEqual({
          organizationId: context.tenant.organizationId,
          gmailConnectionId,
          tokenSecretReference,
        });
        return true;
      },
      newId: () => sendIntentId,
      now: () => requestedSendAt,
    });

    await expect(commands.preflight(input)).resolves.toEqual({
      allowed: true,
      deliveryState: "NOT_SENT",
      checkedAt: requestedSendAt.toISOString(),
      gmail: allowedPreflight.gmail,
    });
    expect(creates).toBe(0);
    expect(credentialChecks).toBe(1);
  });

  it.each([
    [false, true, "GMAIL_SEND_DISABLED"],
    [true, false, "GMAIL_WORKER_UNAVAILABLE"],
  ] as const)(
    "fails closed before persistence when runtime=%s worker=%s",
    async (sendRuntimeEnabled, workerAvailable, code) => {
      let preflights = 0;
      let creates = 0;
      let ids = 0;
      const commands = createSendIntentCommands({
        repository: {
          async preflight() {
            preflights += 1;
            return allowedPreflight;
          },
          async create() {
            creates += 1;
            return { state: "created", intent: createdIntent };
          },
        },
        sendRuntimeEnabled,
        workerAvailable: async () => workerAvailable,
        gmailCredentialAvailable: async () => true,
        newId: () => {
          ids += 1;
          return sendIntentId;
        },
        now: () => requestedSendAt,
      });

      await expect(commands.create(input)).rejects.toMatchObject<
        Partial<BacklinkError>
      >({ code });
      expect(preflights).toBe(0);
      expect(creates).toBe(0);
      expect(ids).toBe(0);
    },
  );

  it("maps stale preflight state and does not allocate or create", async () => {
    let creates = 0;
    let ids = 0;
    const commands = createSendIntentCommands({
      repository: {
        preflight: async () => ({ state: "draft_version_stale" }),
        async create() {
          creates += 1;
          return { state: "created", intent: createdIntent };
        },
      },
      ...enabledRuntime,
      newId: () => {
        ids += 1;
        return sendIntentId;
      },
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).rejects.toMatchObject<
      Partial<BacklinkError>
    >({ code: "DRAFT_VERSION_STALE" });
    expect(creates).toBe(0);
    expect(ids).toBe(0);
  });

  it("fails closed when the selected Gmail Secret cannot be resolved", async () => {
    let creates = 0;
    let ids = 0;
    const commands = createSendIntentCommands({
      repository: {
        preflight: async () => allowedPreflight,
        async create() {
          creates += 1;
          return { state: "created", intent: createdIntent };
        },
      },
      sendRuntimeEnabled: true,
      workerAvailable: async () => true,
      gmailCredentialAvailable: async () => false,
      newId: () => {
        ids += 1;
        return sendIntentId;
      },
      now: () => requestedSendAt,
    });

    await expect(commands.create(input)).rejects.toMatchObject<
      Partial<BacklinkError>
    >({
      code: "GMAIL_REAUTH_REQUIRED",
      message: "The selected Gmail credentials cannot be resolved.",
    });
    expect(creates).toBe(0);
    expect(ids).toBe(0);
  });

  it.each([
    [{ state: "gmail_connection_not_selected" }, "GMAIL_CONNECTION_NOT_SELECTED"],
    [{ state: "gmail_reauth_required" }, "GMAIL_REAUTH_REQUIRED"],
    [{ state: "gmail_scope_insufficient" }, "GMAIL_SCOPE_INSUFFICIENT"],
    [{ state: "contact_version_stale" }, "CONTACT_VERSION_STALE"],
    [{ state: "draft_version_stale" }, "DRAFT_VERSION_STALE"],
    [{
      state: "send_policy_rejected",
      message: "Gmail quota is unavailable.",
      retryAt: null,
    }, "SEND_POLICY_REJECTED"],
  ] as const)(
    "does not allocate or create when preflight returns $state",
    async (preflightResult, code) => {
      let creates = 0;
      let ids = 0;
      let credentialChecks = 0;
      const commands = createSendIntentCommands({
        repository: {
          preflight: async () => preflightResult,
          async create() {
            creates += 1;
            return { state: "created", intent: createdIntent };
          },
        },
        ...enabledRuntime,
        gmailCredentialAvailable: async () => {
          credentialChecks += 1;
          return true;
        },
        newId: () => {
          ids += 1;
          return sendIntentId;
        },
        now: () => requestedSendAt,
      });

      await expect(commands.create(input)).rejects.toMatchObject<
        Partial<BacklinkError>
      >({ code });
      expect(credentialChecks).toBe(0);
      expect(creates).toBe(0);
      expect(ids).toBe(0);
    },
  );
});
