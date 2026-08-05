import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  AppendOutboxInput,
  AppendOutboxResult,
} from "../../db/repositories/outbox.repository.js";
import {
  decodeGmailPushNotification,
} from "../../adapters/gmail/sync-push-parser.js";

export const GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED =
  "backlinks.gmail-incremental-sync.requested.v1";

export const gmailPushWebhookFailureCodes = {
  disabled: "GMAIL_PUSH_WEBHOOK_DISABLED",
  invalidNotification: "GMAIL_PUSH_NOTIFICATION_INVALID",
  unauthorizedTarget: "GMAIL_PUSH_TARGET_UNAUTHORIZED",
} as const;

export type GmailPushWebhookFailureCode =
  (typeof gmailPushWebhookFailureCodes)[
    keyof typeof gmailPushWebhookFailureCodes
  ];

const webhookFailureMessages = {
  [gmailPushWebhookFailureCodes.disabled]:
    "Gmail Push Webhook is disabled.",
  [gmailPushWebhookFailureCodes.invalidNotification]:
    "Gmail Push notification is invalid.",
  [gmailPushWebhookFailureCodes.unauthorizedTarget]:
    "Gmail Push notification target is not authorized.",
} satisfies Record<GmailPushWebhookFailureCode, string>;

export class GmailPushWebhookError extends Error {
  readonly code: GmailPushWebhookFailureCode;
  readonly retryable = false;

  constructor(code: GmailPushWebhookFailureCode, options?: ErrorOptions) {
    super(webhookFailureMessages[code], options);
    this.name = "GmailPushWebhookError";
    this.code = code;
  }
}

export type GmailPushSyncTarget = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
}>;

export type GmailPushTargetResolver = Readonly<{
  resolve(input: Readonly<{
    subscription: string;
    emailAddress: string;
  }>): Promise<GmailPushSyncTarget | null>;
}>;

export type GmailPushIdentityVerifierPort = Readonly<{
  verify(
    authorizationHeader: string | readonly string[] | undefined,
  ): Promise<void>;
}>;

type GmailPushOutbox = Readonly<{
  append(input: AppendOutboxInput): Promise<AppendOutboxResult>;
}>;

export type GmailPushWebhookHandler = Readonly<{
  handle(input: Readonly<{
    authorizationHeader?: string | readonly string[];
    body: unknown;
  }>): Promise<Readonly<{
    accepted: true;
    duplicate: boolean;
  }>>;
}>;

export type GmailPushWebhookOptions = Readonly<{
  config?: Readonly<{ enabled?: boolean }>;
  identityVerifier: GmailPushIdentityVerifierPort;
  targetResolver: GmailPushTargetResolver;
  outbox: GmailPushOutbox;
  newId?: () => string;
}>;

const webhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).strict();
const syncTargetSchema = z.object({
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  websiteProjectId: z.string().uuid(),
  gmailConnectionId: z.string().uuid(),
}).strict();

const fail = (
  code: GmailPushWebhookFailureCode,
  cause?: unknown,
) => new GmailPushWebhookError(
  code,
  cause === undefined ? undefined : { cause },
);

export function createDisabledGmailPushWebhook(): GmailPushWebhookHandler {
  return Object.freeze({
    async handle() {
      throw fail(gmailPushWebhookFailureCodes.disabled);
    },
  });
}

const deterministicUuid = (value: string): string => {
  const characters = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 32)
    .split("");
  characters[12] = "5";
  characters[16] = (
    (Number.parseInt(characters[16] ?? "0", 16) & 0x3) | 0x8
  ).toString(16);
  const hex = characters.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

export function createGmailPushWebhook(
  options: GmailPushWebhookOptions,
): GmailPushWebhookHandler {
  const config = webhookConfigSchema.parse(options.config ?? {});
  const newId = options.newId ?? randomUUID;

  return {
    async handle(input) {
      if (!config.enabled) {
        throw fail(gmailPushWebhookFailureCodes.disabled);
      }
      await options.identityVerifier.verify(input.authorizationHeader);

      let notification;
      try {
        notification = decodeGmailPushNotification(input.body);
      } catch (error) {
        throw fail(
          gmailPushWebhookFailureCodes.invalidNotification,
          error,
        );
      }
      const resolved = await options.targetResolver.resolve({
        subscription: notification.subscription,
        emailAddress: notification.emailAddress,
      });
      if (resolved === null) {
        throw fail(gmailPushWebhookFailureCodes.unauthorizedTarget);
      }
      const target = syncTargetSchema.parse(resolved);
      const notificationKey = createHash("sha256")
        .update(notification.subscription)
        .update("\0")
        .update(notification.providerMessageId)
        .digest("hex");
      const aggregateId = deterministicUuid([
        "gmail-push",
        target.gmailConnectionId,
        notification.subscription,
        notification.providerMessageId,
      ].join("\0"));
      const payload = {
        contractVersion: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
        ...target,
        trigger: "GMAIL_PUSH",
      } as const;
      const result = await options.outbox.append({
        eventId: newId(),
        ...target,
        eventType: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
        aggregateId,
        aggregateVersion: 1,
        idempotencyKey:
          `gmail-push:${target.gmailConnectionId}:${notificationKey}`,
        payload,
        payloadSchemaVersion: 1,
        actorId: "gmail-push-webhook",
      });
      return {
        accepted: true,
        duplicate: result.state === "existing",
      };
    },
  };
}
