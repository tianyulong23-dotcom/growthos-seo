import { z } from "zod";

import {
  replyMailDirections,
  replyMailMatchStatuses,
  replyMailParseStatuses,
} from "../application/queries/reply-mail.query.js";

const nonBlank = z.string().trim().min(1);

export const replyMailListParamsSchema = z.object({
  websiteProjectKey: nonBlank,
}).strict();

export const replyMailMessageParamsSchema = replyMailListParamsSchema.extend({
  messageId: z.uuid(),
}).strict();

export const replyMailThreadParamsSchema = replyMailListParamsSchema.extend({
  threadId: z.uuid(),
}).strict();

export const replyMailListQuerySchema = z.object({
  matchStatus: z.enum(replyMailMatchStatuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();

const replyMailListItemSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid(),
  direction: z.enum(replyMailDirections),
  fromAddress: z.string().nullable(),
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  subject: z.string().nullable(),
  receivedAt: z.string().datetime(),
  parseStatus: z.enum(replyMailParseStatuses),
  version: z.number().int().positive(),
  inboundMessageId: z.uuid().nullable(),
  matchStatus: z.enum(replyMailMatchStatuses).nullable(),
  matchedOpportunityId: z.uuid().nullable(),
}).strict();

const sanitizedHtmlSchema = z.object({
  content: z.string(),
  trust: z.literal("SANITIZED"),
  sanitized: z.literal(true),
  policyVersion: nonBlank,
}).strict();

const safeBodySchema = z.object({
  plainText: z.string().nullable(),
  sanitizedHtml: sanitizedHtmlSchema.nullable(),
}).strict();

const replyMailDetailSchema = replyMailListItemSchema.extend({
  body: safeBodySchema,
}).strict();

const replyMailThreadSchema = z.object({
  id: z.uuid(),
  latestMessageAt: z.string().datetime().nullable(),
  messageCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  messages: z.array(replyMailDetailSchema),
}).strict();

export const replyMailMetaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();

export const replyMailListResponseSchema = z.object({
  items: z.array(replyMailListItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: replyMailMetaSchema,
}).strict();

export const replyMailDetailResponseSchema = z.object({
  item: replyMailDetailSchema,
  meta: replyMailMetaSchema,
}).strict();

export const replyMailThreadResponseSchema = z.object({
  item: replyMailThreadSchema,
  meta: replyMailMetaSchema,
}).strict();
