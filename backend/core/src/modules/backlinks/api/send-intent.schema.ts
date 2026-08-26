import { z } from "zod";

import {
  sendIntentMessagePurposes,
} from "../application/services/send-intent.repository.js";
import {
  gmailSendPolicyVersion,
  gmailSendReadinessConditionCodes,
  gmailSendReadinessSchemaVersion,
} from "../application/services/send-policy-gate.js";
import {
  sendIntentCostUncertaintyValues,
  sendIntentNextActions,
  sendIntentOperationCheckpoints,
  sendIntentQueueKinds,
  sendAttemptStatuses,
  sendIntentStatuses,
  sendIntentWorkerModes,
} from "../application/queries/send-intent.query.js";

const nonBlank = z.string().trim().min(1);

export const sendIntentHeadersSchema = z.object({
  "idempotency-key": nonBlank.max(200),
});

export const sendIntentParamsSchema = z.object({
  websiteProjectKey: nonBlank,
  draftId: z.uuid(),
}).strict();

export const getSendIntentParamsSchema = z.object({
  websiteProjectKey: nonBlank,
  sendIntentId: z.uuid(),
}).strict();

export const listSendIntentsParamsSchema = z.object({
  websiteProjectKey: nonBlank,
}).strict();

export const listSendIntentsQuerySchema = z.object({
  queueKind: z.enum(sendIntentQueueKinds).optional(),
  draftId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();

const sendIntentBodyBaseSchema = z.object({
  approvedDraftVersionId: z.uuid(),
  contactId: z.uuid(),
  contactVersion: z.number().int().positive(),
  gmailConnectionId: z.uuid(),
  messagePurpose: z.enum(sendIntentMessagePurposes),
  followUpIndex: z.number().int().min(0).max(2),
}).strict();

const refinePurposeIndex = (
  value: z.output<typeof sendIntentBodyBaseSchema>,
  context: z.RefinementCtx,
): void => {
  if (value.messagePurpose === "FOLLOW_UP" && value.followUpIndex === 0) {
    context.addIssue({
      code: "custom",
      path: ["followUpIndex"],
      message: "Follow-up Send Intents require index 1 or 2.",
    });
  }
  if (value.messagePurpose !== "FOLLOW_UP" && value.followUpIndex !== 0) {
    context.addIssue({
      code: "custom",
      path: ["followUpIndex"],
      message: "Initial outreach and negotiation replies require index 0.",
    });
  }
};

export const preflightSendIntentBodySchema =
  sendIntentBodyBaseSchema.superRefine(refinePurposeIndex);

const readinessConditionSchema = z.object({
  code: z.enum(gmailSendReadinessConditionCodes),
  revision: nonBlank,
}).strict();

const readinessSnapshotSchema = z.object({
  schemaVersion: z.literal(gmailSendReadinessSchemaVersion),
  policyVersion: z.literal(gmailSendPolicyVersion),
  snapshotVersion: z.string().regex(/^[a-f0-9]{64}$/),
  evaluatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  conditions: z.array(readinessConditionSchema)
    .length(gmailSendReadinessConditionCodes.length)
    .readonly(),
}).strict().superRefine((value, context) => {
  const codes = new Set(value.conditions.map((condition) => condition.code));
  if (codes.size !== gmailSendReadinessConditionCodes.length) {
    context.addIssue({
      code: "custom",
      path: ["conditions"],
      message: "Readiness conditions must contain each condition once.",
    });
  }
});

export const createSendIntentBodySchema = sendIntentBodyBaseSchema.extend({
  readinessSnapshot: readinessSnapshotSchema,
  humanConfirmation: z.object({
    confirmed: z.literal(true),
    confirmedAt: z.string().datetime(),
    readinessSnapshotVersion: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict().superRefine(refinePurposeIndex);

const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();

export const createSendIntentResponseSchema = z.object({
  sendIntentId: z.uuid(),
  sendSnapshotId: z.uuid(),
  draftId: z.uuid(),
  approvedDraftVersionId: z.uuid(),
  contactId: z.uuid(),
  contactVersion: z.number().int().positive(),
  status: z.literal("READY"),
  version: z.literal(1),
  requestedSendAt: z.string().datetime(),
  meta: metaSchema,
}).strict();

export const preflightSendIntentResponseSchema = z.object({
  allowed: z.literal(true),
  deliveryState: z.literal("NOT_SENT"),
  checkedAt: z.string().datetime(),
  readinessSnapshot: readinessSnapshotSchema,
  gmail: z.object({
    connectionId: z.uuid(),
    primaryEmail: z.email(),
    connectionStatus: z.literal("CONNECTED"),
    sendAvailability: z.literal("AVAILABLE"),
    mailSyncCapability: z.boolean(),
  }).strict(),
  meta: metaSchema,
}).strict();

const sendIntentViewSchema = z.object({
    sendIntentId: z.uuid(),
    opportunityId: z.uuid(),
    draftId: z.uuid(),
    approvedDraftVersionId: z.uuid(),
    messagePurpose: nonBlank,
    followUpIndex: z.number().int().nonnegative(),
    status: z.enum(sendIntentStatuses),
    queueKind: z.enum(sendIntentQueueKinds).nullable(),
    version: z.number().int().positive(),
    requestedSendAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    deliveryEnvelope: z.object({
      sendSnapshotId: z.uuid(),
      gmailConnectionId: z.uuid(),
      gmailAccountEmail: z.string().nullable(),
      gmailIdentityId: z.uuid(),
      fromAddress: z.string().nullable(),
      recipient: nonBlank,
      contactId: z.uuid(),
      contactVersion: z.number().int().positive(),
      approvalRecordedAt: z.string().datetime().nullable(),
    }).strict().nullable(),
    diagnostics: z.object({
      operationId: z.uuid(),
      operationCheckpoint: z.enum(sendIntentOperationCheckpoints),
      retryable: z.boolean(),
      resubmittable: z.boolean(),
      nextRetryAt: z.string().datetime().nullable(),
      costUncertainty: z.enum(sendIntentCostUncertaintyValues),
      workerMode: z.enum(sendIntentWorkerModes),
      buildIdentity: nonBlank,
      primaryNextAction: z.enum(sendIntentNextActions),
    }).strict(),
    attempt: z.object({
      attemptId: z.uuid(),
      attemptNo: z.number().int().positive(),
      status: z.enum(sendAttemptStatuses),
      rfcMessageId: nonBlank,
      providerMessageId: z.string().nullable(),
      providerThreadId: z.string().nullable(),
      errorCode: z.string().nullable(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime().nullable(),
      retryEligibleAt: z.string().datetime().nullable(),
    }).strict().nullable(),
  }).strict();

export const getSendIntentResponseSchema = z.object({
  sendIntent: sendIntentViewSchema,
  meta: metaSchema,
}).strict();

export const listSendIntentsResponseSchema = z.object({
  items: z.array(sendIntentViewSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: metaSchema,
}).strict();
