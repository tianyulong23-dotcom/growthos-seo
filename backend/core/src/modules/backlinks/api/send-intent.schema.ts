import { z } from "zod";

import {
  sendIntentMessagePurposes,
} from "../application/services/send-intent.repository.js";

const nonBlank = z.string().trim().min(1);

export const sendIntentHeadersSchema = z.object({
  "idempotency-key": nonBlank.max(200),
});

export const sendIntentParamsSchema = z.object({
  websiteProjectKey: nonBlank,
  draftId: z.uuid(),
}).strict();

export const createSendIntentBodySchema = z.object({
  approvedDraftVersionId: z.uuid(),
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
  draftId: z.uuid(),
  approvedDraftVersionId: z.uuid(),
  status: z.literal("READY"),
  version: z.literal(1),
  requestedSendAt: z.string().datetime(),
  meta: metaSchema,
}).strict();
