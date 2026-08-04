import type {
  GmailConnectionStatus,
  GmailSendAvailability,
} from "../gmail-connection.gateway.js";
import type { DraftSnapshot } from "../repositories/draft-generation.repository.js";

export const gmailSendPolicyVersion = "gmail-send-policy.v1";

export const gmailSendPolicyBlockCodes = Object.freeze({
  draftNotApproved: "DRAFT_NOT_APPROVED",
  recipientSuppressed: "RECIPIENT_SUPPRESSED",
  connectionUnavailable: "GMAIL_CONNECTION_UNAVAILABLE",
  dailyQuotaExceeded: "GMAIL_DAILY_QUOTA_EXCEEDED",
  killSwitchActive: "GMAIL_SEND_KILL_SWITCH_ACTIVE",
  cooldownActive: "GMAIL_SEND_COOLDOWN_ACTIVE",
} as const);

export type GmailSendPolicyBlockCode =
  (typeof gmailSendPolicyBlockCodes)[
    keyof typeof gmailSendPolicyBlockCodes
  ];

export const gmailSendKillSwitchScopes = Object.freeze([
  "GLOBAL",
  "ORGANIZATION",
  "WORKSPACE",
  "WEBSITE_PROJECT",
  "GMAIL_SEND",
] as const);

export type GmailSendKillSwitchScope =
  (typeof gmailSendKillSwitchScopes)[number];

export type GmailSendPolicyQuotaEvidence =
  | Readonly<{
      status: "RESERVED";
      eligibleAt: string;
      expiresAt: string;
    }>
  | Readonly<{
      status: "EXCEEDED";
      retryAt: string | null;
    }>;

export type GmailSendPolicyInput = Readonly<{
  evaluatedAt: string;
  draft: Readonly<{
    status: DraftSnapshot["status"];
    approvedVersionId: string | null;
    requestedVersionId: string;
  }>;
  suppression: Readonly<{
    suppressed: boolean;
  }>;
  connection: Readonly<{
    connectionStatus: GmailConnectionStatus;
    sendAvailability: GmailSendAvailability;
  }>;
  quota: GmailSendPolicyQuotaEvidence;
  killSwitches: Readonly<Record<GmailSendKillSwitchScope, boolean>>;
  cooldownUntil: string | null;
}>;

export type GmailSendPolicyDecision = Readonly<{
  policyVersion: typeof gmailSendPolicyVersion;
  evaluatedAt: string;
  allowed: boolean;
  blockCodes: readonly GmailSendPolicyBlockCode[];
  activeKillSwitchScopes: readonly GmailSendKillSwitchScope[];
  retryAt: string | null;
}>;

const asTimestamp = (value: string, name: string): number => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${name} must be a valid timestamp.`);
  }
  return timestamp;
};

const assertNonBlank = (value: string, name: string): void => {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const asLatestFutureTimestamp = (
  timestamps: readonly number[],
  evaluatedAt: number,
): string | null => {
  const futureTimestamps = timestamps.filter(
    (timestamp) => timestamp > evaluatedAt,
  );
  return futureTimestamps.length === 0
    ? null
    : new Date(Math.max(...futureTimestamps)).toISOString();
};

export function evaluateGmailSendPolicy(
  input: GmailSendPolicyInput,
): GmailSendPolicyDecision {
  assertNonBlank(input.draft.requestedVersionId, "requestedVersionId");

  const evaluatedAt = asTimestamp(input.evaluatedAt, "evaluatedAt");
  const blockCodes: GmailSendPolicyBlockCode[] = [];
  const retryTimestamps: number[] = [];

  if (typeof input.suppression.suppressed !== "boolean") {
    throw new TypeError("suppression.suppressed must be a boolean.");
  }

  if (
    input.draft.status !== "approved"
    || input.draft.approvedVersionId !== input.draft.requestedVersionId
  ) {
    blockCodes.push(gmailSendPolicyBlockCodes.draftNotApproved);
  }

  if (input.suppression.suppressed) {
    blockCodes.push(gmailSendPolicyBlockCodes.recipientSuppressed);
  }

  if (
    input.connection.connectionStatus !== "CONNECTED"
    || input.connection.sendAvailability !== "AVAILABLE"
  ) {
    blockCodes.push(gmailSendPolicyBlockCodes.connectionUnavailable);
  }

  let quotaEligibleAt: number | null = null;
  if (input.quota.status === "EXCEEDED") {
    blockCodes.push(gmailSendPolicyBlockCodes.dailyQuotaExceeded);
    if (input.quota.retryAt !== null) {
      retryTimestamps.push(asTimestamp(input.quota.retryAt, "quota.retryAt"));
    }
  } else {
    quotaEligibleAt = asTimestamp(
      input.quota.eligibleAt,
      "quota.eligibleAt",
    );
    const quotaExpiresAt = asTimestamp(
      input.quota.expiresAt,
      "quota.expiresAt",
    );
    if (quotaExpiresAt <= quotaEligibleAt) {
      throw new TypeError("quota.expiresAt must be after quota.eligibleAt.");
    }
    if (evaluatedAt >= quotaExpiresAt) {
      blockCodes.push(gmailSendPolicyBlockCodes.dailyQuotaExceeded);
    }
  }

  const activeKillSwitchScopes = gmailSendKillSwitchScopes.filter((scope) => {
    const active = input.killSwitches[scope];
    if (typeof active !== "boolean") {
      throw new TypeError(`killSwitches.${scope} must be a boolean.`);
    }
    return active;
  });
  if (activeKillSwitchScopes.length > 0) {
    blockCodes.push(gmailSendPolicyBlockCodes.killSwitchActive);
  }

  const cooldownTimestamps = [
    quotaEligibleAt,
    input.cooldownUntil === null
      ? null
      : asTimestamp(input.cooldownUntil, "cooldownUntil"),
  ].filter((timestamp): timestamp is number => timestamp !== null);
  const activeCooldowns = cooldownTimestamps.filter(
    (timestamp) => timestamp > evaluatedAt,
  );
  if (activeCooldowns.length > 0) {
    blockCodes.push(gmailSendPolicyBlockCodes.cooldownActive);
    retryTimestamps.push(...activeCooldowns);
  }

  return Object.freeze({
    policyVersion: gmailSendPolicyVersion,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    allowed: blockCodes.length === 0,
    blockCodes: Object.freeze(blockCodes),
    activeKillSwitchScopes: Object.freeze(activeKillSwitchScopes),
    retryAt: asLatestFutureTimestamp(retryTimestamps, evaluatedAt),
  });
}

export class GmailSendPolicyBlockedError extends Error {
  readonly code = "GMAIL_SEND_POLICY_BLOCKED";

  constructor(readonly decision: GmailSendPolicyDecision) {
    super(
      `Gmail send was blocked by: ${decision.blockCodes.join(", ")}.`,
    );
    this.name = "GmailSendPolicyBlockedError";
  }
}

export async function runAfterGmailSendPolicyGate<T>(
  input: GmailSendPolicyInput,
  operation: () => Promise<T>,
): Promise<T> {
  const decision = evaluateGmailSendPolicy(input);
  if (!decision.allowed) {
    throw new GmailSendPolicyBlockedError(decision);
  }
  return operation();
}
