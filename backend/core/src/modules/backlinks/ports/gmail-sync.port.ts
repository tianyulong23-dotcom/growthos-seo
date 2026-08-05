import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(255);
const pageTokenSchema = z.string().trim().min(1).max(2_048);
const pageSizeSchema = z.number().int().min(1).max(500);
const historyIdSchema = z.string().regex(/^[1-9][0-9]*$/u);
const timestampSchema = z.string().datetime({ offset: true });
const rawBase64UrlSchema = z.string().min(1)
  .regex(/^[A-Za-z0-9_-]+$/u, "Raw message must use unpadded base64url.");

export const gmailMessageReferenceSchema = z.object({
  providerMessageId: identifierSchema,
  providerThreadId: identifierSchema,
}).strict();

export type GmailMessageReference = Readonly<
  z.output<typeof gmailMessageReferenceSchema>
>;

export const gmailInitialSyncInputSchema = z.object({
  gmailConnectionId: identifierSchema,
  receivedAfter: timestampSchema,
  pageToken: pageTokenSchema.optional(),
  pageSize: pageSizeSchema,
}).strict();

export type GmailInitialSyncInput = Readonly<
  z.output<typeof gmailInitialSyncInputSchema>
>;

export const gmailInitialSyncResultSchema = z.object({
  snapshotHistoryId: historyIdSchema,
  messages: z.array(gmailMessageReferenceSchema).max(500),
  nextPageToken: pageTokenSchema.optional(),
}).strict();

type ParsedGmailInitialSyncResult = z.output<
  typeof gmailInitialSyncResultSchema
>;

export type GmailInitialSyncResult = Readonly<
  Omit<ParsedGmailInitialSyncResult, "messages"> & {
    messages: readonly GmailMessageReference[];
  }
>;

export const gmailHistoryInputSchema = z.object({
  gmailConnectionId: identifierSchema,
  startHistoryId: historyIdSchema,
  pageToken: pageTokenSchema.optional(),
  pageSize: pageSizeSchema,
}).strict();

export type GmailHistoryInput = Readonly<
  z.output<typeof gmailHistoryInputSchema>
>;

export const gmailHistoryMessageReferenceSchema = gmailMessageReferenceSchema
  .extend({
    historyId: historyIdSchema,
  }).strict();

export type GmailHistoryMessageReference = Readonly<
  z.output<typeof gmailHistoryMessageReferenceSchema>
>;

export const gmailHistoryPageSchema = z.object({
  kind: z.literal("page"),
  latestHistoryId: historyIdSchema,
  messages: z.array(gmailHistoryMessageReferenceSchema).max(500),
  nextPageToken: pageTokenSchema.optional(),
}).strict();

type ParsedGmailHistoryPage = z.output<typeof gmailHistoryPageSchema>;

export type GmailHistoryPage = Readonly<
  Omit<ParsedGmailHistoryPage, "messages"> & {
    messages: readonly GmailHistoryMessageReference[];
  }
>;

export const gmailHistoryExpiredSchema = z.object({
  kind: z.literal("history_expired"),
  startHistoryId: historyIdSchema,
}).strict();

export type GmailHistoryExpired = Readonly<
  z.output<typeof gmailHistoryExpiredSchema>
>;

export const gmailHistoryResultSchema = z.discriminatedUnion("kind", [
  gmailHistoryPageSchema,
  gmailHistoryExpiredSchema,
]);

export type GmailHistoryResult = GmailHistoryPage | GmailHistoryExpired;

export const gmailMessageInputSchema = z.object({
  gmailConnectionId: identifierSchema,
  providerMessageId: identifierSchema,
}).strict();

export type GmailMessageInput = Readonly<
  z.output<typeof gmailMessageInputSchema>
>;

export const gmailRawMessageSchema = z.object({
  providerMessageId: identifierSchema,
  providerThreadId: identifierSchema,
  historyId: historyIdSchema,
  receivedAt: timestampSchema,
  rawBase64Url: rawBase64UrlSchema,
  estimatedSizeBytes: z.number().int().nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
}).strict();

export type GmailRawMessage = Readonly<
  z.output<typeof gmailRawMessageSchema>
>;

export const gmailWatchInputSchema = z.object({
  gmailConnectionId: identifierSchema,
  topicName: z.string().trim().min(1).max(1_024)
    .regex(
      /^projects\/[^/\s]+\/topics\/[^/\s]+$/u,
      "A full Google Pub/Sub topic resource name is required.",
    ),
}).strict();

export type GmailWatchInput = Readonly<
  z.output<typeof gmailWatchInputSchema>
>;

export const gmailWatchResultSchema = z.object({
  historyId: historyIdSchema,
  expiresAt: timestampSchema,
}).strict();

export type GmailWatchResult = Readonly<
  z.output<typeof gmailWatchResultSchema>
>;

export interface GmailSyncPort {
  listInitialMessages(
    input: GmailInitialSyncInput,
  ): Promise<GmailInitialSyncResult>;
  listHistory(input: GmailHistoryInput): Promise<GmailHistoryResult>;
  getMessage(input: GmailMessageInput): Promise<GmailRawMessage>;
  watch(input: GmailWatchInput): Promise<GmailWatchResult>;
}
