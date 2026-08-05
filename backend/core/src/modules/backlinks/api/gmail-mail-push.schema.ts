import { z } from "zod";

import {
  gmailPushEnvelopeSchema,
} from "../adapters/gmail/sync-push-parser.js";

export const gmailMailPushBodySchema = gmailPushEnvelopeSchema;

export const gmailMailPushResponseSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
}).strict();

const gmailMailPushStatusSchema = z.union([
  z.literal(400),
  z.literal(401),
  z.literal(403),
  z.literal(500),
  z.literal(503),
]);

export const gmailMailPushProblemSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: gmailMailPushStatusSchema,
  detail: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export type GmailMailPushStatus = z.output<
  typeof gmailMailPushStatusSchema
>;
