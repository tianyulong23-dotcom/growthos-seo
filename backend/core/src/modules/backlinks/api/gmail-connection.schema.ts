import { z } from "zod";

const nonBlank = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

export const gmailConnectionParamsSchema = z.object({
  websiteProjectKey: nonBlank,
}).strict();

export const gmailConnectionResourceParamsSchema =
  gmailConnectionParamsSchema.extend({
    connectionId: z.uuid(),
  }).strict();

export const gmailConnectionSelectionBodySchema = z.object({
  connectionId: z.uuid(),
}).strict();

export const gmailConnectBodySchema = z.object({
  returnPath: z.string().max(2_048).refine(
    (value) => value.startsWith("/") && !value.startsWith("//"),
    "returnPath must be an application-relative path.",
  ).optional(),
}).strict();

export const gmailCallbackQuerySchema = z.object({
  code: z.string().min(1).max(8_192).refine(
    (value) => value.trim().length > 0,
    "Authorization code must not be blank.",
  ),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export const gmailConnectionViewSchema = z.object({
  connectionId: z.uuid(),
  version: z.number().int().positive(),
  primaryEmail: z.email(),
  displayName: nonBlank.max(255).nullable(),
  hostedDomain: nonBlank.max(255).nullable(),
  grantedScopes: z.array(nonBlank.max(2_048)).min(1).max(32),
  connectionStatus: z.enum([
    "CONNECTING",
    "CONNECTED",
    "REAUTH_REQUIRED",
    "TOKEN_REVOKED",
    "DISCONNECTED",
  ]),
  sendAvailability: z.enum(["AVAILABLE", "PAUSED"]),
  mailSyncCapability: z.boolean(),
  tokenExpiresAt: timestamp,
  connectedAt: timestamp,
  affectedProjectCount: z.number().int().nonnegative(),
  recentErrorCategory: nonBlank.max(255).nullable(),
}).strict();

export const gmailConnectionMetaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: timestamp,
}).strict();

export const gmailConnectResponseSchema = z.object({
  authorizationUrl: z.url().max(2_048),
  expiresAt: timestamp,
  meta: gmailConnectionMetaSchema,
}).strict();

export const gmailCallbackResponseSchema = z.object({
  connection: gmailConnectionViewSchema,
  returnPath: z.string().max(2_048).nullable(),
  meta: gmailConnectionMetaSchema,
}).strict();

export const gmailStatusResponseSchema = z.object({
  connection: gmailConnectionViewSchema.nullable(),
  accounts: z.array(gmailConnectionViewSchema),
  meta: gmailConnectionMetaSchema,
}).strict();

export const gmailSelectionResponseSchema = gmailStatusResponseSchema;

export const gmailPollingSyncResponseSchema = z.object({
  status: z.literal("ACCEPTED"),
  workflowId: nonBlank.max(1_024),
  meta: gmailConnectionMetaSchema,
}).strict();

export const gmailPollingSyncStatusResponseSchema = z.object({
  state: z.enum(["BLOCKED", "WAITING_FOR_ACCEPTED_SEND", "POLLING"]),
  workflowId: nonBlank.max(1_024),
  pollingIntervalSeconds: z.number().int().min(15).max(3_600),
  killSwitchOpen: z.boolean(),
  acceptedSendCount: z.number().int().nonnegative(),
  lastSuccessfulSyncAt: timestamp.nullable(),
  lastError: nonBlank.max(1_000).nullable(),
  lastErrorCategory: z.enum([
    "AUTHENTICATION_FAILED",
    "FORBIDDEN",
    "GOOGLE_AUTH_EXPIRED",
    "GOOGLE_5XX",
    "NETWORK_TIMEOUT",
    "RATE_LIMITED",
    "TRANSPORT_FAILURE",
    "UNKNOWN",
  ]).nullable(),
  nextRetryAt: timestamp.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  cursor: z.object({
    historyId: nonBlank,
    initialSyncCompletedAt: timestamp.nullable(),
    lastSyncedAt: timestamp.nullable(),
    version: z.number().int().positive(),
  }).strict().nullable(),
  meta: gmailConnectionMetaSchema,
}).strict();

export const gmailDisconnectBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const gmailDisconnectResponseSchema = z.object({
  connection: gmailConnectionViewSchema,
  revocationStatus: z.enum(["COMPLETED", "PENDING"]),
  meta: gmailConnectionMetaSchema,
}).strict();
