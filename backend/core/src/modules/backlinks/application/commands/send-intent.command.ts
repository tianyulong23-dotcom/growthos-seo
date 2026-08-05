import { createHash } from "node:crypto";

import type {
  SendIntentMessagePurpose,
  SendIntentRepository,
  SendIntentRepositoryResult,
} from "../services/send-intent.repository.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  gmailProgressiveVerificationProfiles,
} from "../../domain/sending/progressive-verification.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

type CreateSendIntentCommand = Readonly<{
  context: ResolvedProjectContext;
  draftId: string;
  approvedDraftVersionId: string;
  contactId: string;
  contactVersion: number;
  gmailConnectionId: string;
  messagePurpose: SendIntentMessagePurpose;
  followUpIndex: number;
  idempotencyKey: string;
}>;

const authorize = (context: ResolvedProjectContext): void => {
  if (!context.actor.roles.some((role) =>
    ["owner", "admin", "member"].includes(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Send Intent write permission is required.",
    });
  }
};

const assertPurposeIndex = (
  purpose: SendIntentMessagePurpose,
  followUpIndex: number,
): void => {
  if (
    purpose === "FOLLOW_UP"
    && (!Number.isSafeInteger(followUpIndex)
      || followUpIndex < 1
      || followUpIndex > 2)
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message: "Follow-up Send Intents require index 1 or 2.",
      fieldErrors: [{
        field: "followUpIndex",
        message: "Follow-up Send Intents require index 1 or 2.",
      }],
    });
  }
  if (purpose !== "FOLLOW_UP" && followUpIndex !== 0) {
    throw new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message:
        "Initial outreach and negotiation replies require index 0.",
      fieldErrors: [{
        field: "followUpIndex",
        message:
          "Initial outreach and negotiation replies require index 0.",
      }],
    });
  }
};

const logicalMessageKey = (
  input: CreateSendIntentCommand,
): string => {
  return createHash("sha256")
    .update("backlinks-send-intent:v2")
    .update("\0")
    .update(input.context.tenant.organizationId)
    .update("\0")
    .update(input.context.tenant.workspaceId)
    .update("\0")
    .update(input.context.project.websiteProjectId)
    .update("\0")
    .update(input.draftId)
    .update("\0")
    .update(input.approvedDraftVersionId)
    .update("\0")
    .update(input.contactId)
    .update("\0")
    .update(String(input.contactVersion))
    .update("\0")
    .update(input.gmailConnectionId)
    .update("\0")
    .update(input.messagePurpose)
    .update("\0")
    .update(String(input.followUpIndex))
    .digest("hex");
};

const defaultQuotaProfile =
  gmailProgressiveVerificationProfiles.NEW_CONNECTION;
const reservationTtlSeconds = 10 * 60;

const requireCreated = (
  result: SendIntentRepositoryResult,
) => {
  if (result.state === "created" || result.state === "replayed") {
    return result.intent;
  }
  if (
    result.state === "draft_not_found"
    || result.state === "gmail_connection_unavailable"
    || result.state === "contact_unavailable"
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.notFound,
      message: result.state === "draft_not_found"
        ? "Draft was not found in this project."
        : result.state === "contact_unavailable"
          ? "The selected Contact is not active for this Opportunity."
          : "Gmail connection is not active for this workspace.",
    });
  }
  if (
    result.state === "quota_exceeded"
    || result.state === "initial_outreach_cooldown"
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.rateLimited,
      message: result.state === "initial_outreach_cooldown"
        ? `Initial outreach to this Contact is paused until ${result.retryAt}.`
        : result.retryAt === null
          ? `Gmail rolling quota of ${result.dailyLimit} is exhausted.`
          : `Gmail rolling quota is exhausted until ${result.retryAt}.`,
      retryable: true,
    });
  }
  throw new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message: result.state === "draft_not_approved"
      ? "The requested Draft Version is not the exact approved Version."
      : result.state === "contact_version_conflict"
        ? "The selected Contact or Draft Contact binding has changed."
      : "A Send Intent already exists for this request or logical message.",
  });
};

export function createSendIntentCommands(dependencies: Readonly<{
  repository: SendIntentRepository;
  newId(): string;
  now(): Date;
  quotaProfile?: Readonly<{
    rolling24HourSendLimit: number;
    minimumIntervalSeconds: number;
  }>;
}>) {
  const quotaProfile = dependencies.quotaProfile ?? defaultQuotaProfile;
  return Object.freeze({
    async create(input: CreateSendIntentCommand) {
      authorize(input.context);
      assertPurposeIndex(input.messagePurpose, input.followUpIndex);
      const sendIntentId = dependencies.newId();
      const quotaReservationId = dependencies.newId();
      const outboxEventId = dependencies.newId();
      const sendSnapshotId = dependencies.newId();
      const requestedSendAt = dependencies.now();
      return requireCreated(await dependencies.repository.create({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        sendIntentId,
        sendSnapshotId,
        quotaReservationId,
        outboxEventId,
        draftId: input.draftId,
        approvedDraftVersionId: input.approvedDraftVersionId,
        contactId: input.contactId,
        contactVersion: input.contactVersion,
        gmailConnectionId: input.gmailConnectionId,
        clientIdempotencyKey: input.idempotencyKey,
        logicalMessageKey: logicalMessageKey(input),
        messagePurpose: input.messagePurpose,
        followUpIndex: input.followUpIndex,
        requestedSendAt,
        rolling24HourSendLimit:
          quotaProfile.rolling24HourSendLimit,
        minimumIntervalSeconds:
          quotaProfile.minimumIntervalSeconds,
        reservationTtlSeconds,
        actorId: input.context.actor.userId,
      }));
    },
  });
}
