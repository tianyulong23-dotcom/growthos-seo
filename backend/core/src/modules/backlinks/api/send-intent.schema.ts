import { z } from "zod";

import {
  sendIntentMessagePurposes,
} from "../application/services/send-intent.repository.js";
import {
  sendAttemptStatuses,
  sendIntentStatuses,
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

export const createSendIntentBodySchema = z.object({
  approvedDraftVersionId: z.uuid(),
  contactId: z.uuid(),
  contactVersion: z.number().int().positive(),
  gmailConnectionId: z.uuid(),
  messagePurpose: z.enum(sendIntentMessagePurposes),
  followUpIndex: z.number().int().min(0).max(2),
}).strict().superRefine((value, context) => {
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
});

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
  gmail: z.object({
    connectionId: z.uuid(),
    primaryEmail: z.email(),
    connectionStatus: z.literal("CONNECTED"),
    sendAvailability: z.literal("AVAILABLE"),
    mailSyncCapability: z.boolean(),
  }).strict(),
  meta: metaSchema,
}).strict();

export const getSendIntentResponseSchema = z.object({
  sendIntent: z.object({
    sendIntentId: z.uuid(),
    draftId: z.uuid(),
    status: z.enum(sendIntentStatuses),
    version: z.number().int().positive(),
    requestedSendAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
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
  }).strict(),
  meta: metaSchema,
}).strict();
