import { createHash } from "node:crypto";

import type {
  PreflightSendIntentRecordInput,
  SendIntentPreflightRepository,
  SendIntentPreflightRepositoryResult,
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
import type { SecretStoreReference } from "../../ports/secret-store.port.js";
import {
  createGmailSendReadinessSnapshot,
  type GmailSendReadinessSnapshot,
} from "../services/send-policy-gate.js";

export type CreateSendIntentCommand = Readonly<{
  context: ResolvedProjectContext;
  draftId: string;
  approvedDraftVersionId: string;
  contactId: string;
  contactVersion: number;
  gmailConnectionId: string;
  messagePurpose: SendIntentMessagePurpose;
  followUpIndex: number;
  idempotencyKey: string;
  readinessSnapshot: GmailSendReadinessSnapshot;
  humanConfirmation: Readonly<{
    confirmed: true;
    confirmedAt: string;
    readinessSnapshotVersion: string;
  }>;
}>;

export type PreflightSendIntentCommand = Omit<
  CreateSendIntentCommand,
  "idempotencyKey" | "readinessSnapshot" | "humanConfirmation"
>;

export type SendIntentPreflight = Readonly<{
  allowed: true;
  deliveryState: "NOT_SENT";
  checkedAt: string;
  readinessSnapshot: GmailSendReadinessSnapshot;
  gmail: Readonly<{
    connectionId: string;
    primaryEmail: string;
    connectionStatus: "CONNECTED";
    sendAvailability: "AVAILABLE";
    mailSyncCapability: boolean;
  }>;
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

const requirePreflightAllowed = (
  result: SendIntentPreflightRepositoryResult,
): Extract<SendIntentPreflightRepositoryResult, { state: "allowed" }> => {
  if (result.state === "allowed") return result;
  if (result.state === "gmail_connection_not_selected") {
    throw new BacklinkError({
      code: backlinkErrorCodes.gmailConnectionNotSelected,
      message:
        "Select the Gmail account for this project before sending.",
    });
  }
  if (result.state === "gmail_reauth_required") {
    throw new BacklinkError({
      code: backlinkErrorCodes.gmailReauthRequired,
      message:
        "Reconnect the selected Gmail account before sending.",
    });
  }
  if (result.state === "gmail_scope_insufficient") {
    throw new BacklinkError({
      code: backlinkErrorCodes.gmailScopeInsufficient,
      message:
        "Reconnect Gmail and grant the required Gmail Send scope.",
    });
  }
  if (result.state === "contact_version_stale") {
    throw new BacklinkError({
      code: backlinkErrorCodes.contactVersionStale,
      message:
        "The approved Contact version has changed. Review the Contact and regenerate the Draft.",
    });
  }
  if (
    result.state === "draft_not_found"
    || result.state === "draft_version_stale"
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.draftVersionStale,
      message:
        "The approved Draft version is no longer current. Refresh and approve the current version.",
    });
  }
  throw new BacklinkError({
    code: backlinkErrorCodes.sendPolicyRejected,
    message: result.message,
    retryable: result.retryAt !== null,
  });
};

const requireCreated = (
  result: SendIntentRepositoryResult,
) => {
  if (result.state === "created" || result.state === "replayed") {
    return result.intent;
  }
  if (
    result.state === "draft_not_found"
    || result.state === "contact_unavailable"
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.notFound,
      message: result.state === "draft_not_found"
        ? "Draft was not found in this project."
        : "The selected Contact is not active for this Opportunity.",
    });
  }
  if (result.state === "gmail_connection_unavailable") {
    throw new BacklinkError({
      code: backlinkErrorCodes.gmailConnectionNotSelected,
      message:
        "The selected Gmail account is no longer active for this project.",
    });
  }
  if (result.state === "send_policy_rejected") {
    throw new BacklinkError({
      code: backlinkErrorCodes.sendPolicyRejected,
      message: result.message,
      retryable: result.retryAt !== null,
    });
  }
  if (result.state === "readiness_changed") {
    throw new BacklinkError({
      code: backlinkErrorCodes.sendReadinessStale,
      message:
        "The confirmed send readiness conditions changed. Run preflight and confirm again.",
      retryable: true,
      changedConditions: result.changedConditions,
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
    code: result.state === "draft_not_approved"
      ? backlinkErrorCodes.draftVersionStale
      : result.state === "contact_version_conflict"
        ? backlinkErrorCodes.contactVersionStale
        : backlinkErrorCodes.conflict,
    message: result.state === "draft_not_approved"
      ? "The requested Draft Version is not the exact approved Version."
      : result.state === "contact_version_conflict"
        ? "The selected Contact or Draft Contact binding has changed."
      : "A Send Intent already exists for this request or logical message.",
  });
};

export function createSendIntentCommands(dependencies: Readonly<{
  repository: SendIntentRepository & SendIntentPreflightRepository;
  sendRuntimeEnabled: boolean;
  workerAvailable(): Promise<boolean>;
  gmailCredentialAvailable(input: Readonly<{
    organizationId: string;
    gmailConnectionId: string;
    tokenSecretReference: SecretStoreReference;
  }>): Promise<boolean>;
  newId(): string;
  now(): Date;
  quotaProfile?: Readonly<{
    rolling24HourSendLimit: number;
    minimumIntervalSeconds: number;
  }>;
  readinessTtlSeconds?: number;
}>) {
  const quotaProfile = dependencies.quotaProfile ?? defaultQuotaProfile;
  const preflight = async (
    input: PreflightSendIntentCommand,
  ): Promise<SendIntentPreflight> => {
    if (!dependencies.sendRuntimeEnabled) {
      throw new BacklinkError({
        code: backlinkErrorCodes.gmailSendDisabled,
        message:
          "Gmail send is disabled for this runtime. Enable it and restart the local product.",
      });
    }
    authorize(input.context);
    assertPurposeIndex(input.messagePurpose, input.followUpIndex);
    if (!await dependencies.workerAvailable()) {
      throw new BacklinkError({
        code: backlinkErrorCodes.gmailWorkerUnavailable,
        message:
          "The Temporal Gmail worker is unavailable. Start or repair the worker before sending.",
        retryable: true,
      });
    }
    const checkedAt = dependencies.now();
    const repositoryInput: PreflightSendIntentRecordInput = {
      organizationId: input.context.tenant.organizationId,
      workspaceId: input.context.tenant.workspaceId,
      websiteProjectId: input.context.project.websiteProjectId,
      draftId: input.draftId,
      approvedDraftVersionId: input.approvedDraftVersionId,
      contactId: input.contactId,
      contactVersion: input.contactVersion,
      gmailConnectionId: input.gmailConnectionId,
      messagePurpose: input.messagePurpose,
      followUpIndex: input.followUpIndex,
      checkedAt,
      rolling24HourSendLimit: quotaProfile.rolling24HourSendLimit,
    };
    const allowed = requirePreflightAllowed(
      await dependencies.repository.preflight(repositoryInput),
    );
    if (!await dependencies.gmailCredentialAvailable({
      organizationId: input.context.tenant.organizationId,
      gmailConnectionId: input.gmailConnectionId,
      tokenSecretReference: allowed.tokenSecretReference,
    })) {
      throw new BacklinkError({
        code: backlinkErrorCodes.gmailReauthRequired,
        message: "The selected Gmail credentials cannot be resolved.",
      });
    }
    return Object.freeze({
      allowed: true,
      deliveryState: "NOT_SENT",
      checkedAt: checkedAt.toISOString(),
      readinessSnapshot: createGmailSendReadinessSnapshot({
        evaluatedAt: checkedAt,
        conditions: allowed.readinessConditions,
        ...(dependencies.readinessTtlSeconds === undefined
          ? {}
          : { ttlSeconds: dependencies.readinessTtlSeconds }),
      }),
      gmail: allowed.gmail,
    });
  };
  return Object.freeze({
    preflight,
    async create(input: CreateSendIntentCommand) {
      authorize(input.context);
      assertPurposeIndex(input.messagePurpose, input.followUpIndex);
      const confirmedAt = new Date(input.humanConfirmation.confirmedAt);
      if (
        input.humanConfirmation.confirmed !== true
        || !Number.isFinite(confirmedAt.getTime())
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "A valid human send confirmation is required.",
          fieldErrors: [{
            field: "humanConfirmation.confirmedAt",
            message: "A valid human send confirmation is required.",
          }],
        });
      }
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
        readinessSnapshot: input.readinessSnapshot,
        humanConfirmation: {
          confirmed: true,
          confirmedAt,
          readinessSnapshotVersion:
            input.humanConfirmation.readinessSnapshotVersion,
        },
      }));
    },
  });
}
