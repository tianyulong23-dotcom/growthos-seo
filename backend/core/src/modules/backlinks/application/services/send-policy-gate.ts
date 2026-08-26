import { createHash } from "node:crypto";

import type {
  GmailConnectionStatus,
  GmailSendAvailability,
} from "../gmail-connection.gateway.js";
import type { DraftSnapshot } from "../repositories/draft-generation.repository.js";

export const gmailSendPolicyVersion = "gmail-send-policy.v1";
export const gmailSendReadinessSchemaVersion =
  "gmail-send-readiness.v1";
export const gmailSendReadinessDefaultTtlSeconds = 15 * 60;

export const gmailSendReadinessConditionCodes = Object.freeze([
  "DRAFT_APPROVAL",
  "CONTACT_VERSION",
  "GMAIL_BINDING",
  "GMAIL_IDENTITY",
  "SUPPRESSION",
  "KILL_SWITCH",
  "COOLDOWN",
  "QUOTA",
] as const);

export type GmailSendReadinessConditionCode =
  (typeof gmailSendReadinessConditionCodes)[number];

export type GmailSendReadinessCondition = Readonly<{
  code: GmailSendReadinessConditionCode;
  revision: string;
}>;

export type GmailSendReadinessSnapshot = Readonly<{
  schemaVersion: typeof gmailSendReadinessSchemaVersion;
  policyVersion: typeof gmailSendPolicyVersion;
  snapshotVersion: string;
  evaluatedAt: string;
  expiresAt: string;
  conditions: readonly GmailSendReadinessCondition[];
}>;

export type GmailSendReadinessChangedCondition = Readonly<{
  code: GmailSendReadinessConditionCode | "SNAPSHOT_VALIDITY";
  reason: "CHANGED" | "MISSING" | "EXPIRED";
  expectedRevision: string | null;
  currentRevision: string | null;
  retryable: true;
  recoveryAction:
    | "RUN_PREFLIGHT_AGAIN"
    | "REAPPROVE_CURRENT_DRAFT"
    | "REFRESH_CONTACT"
    | "RESELECT_GMAIL_ACCOUNT"
    | "VERIFY_SEND_IDENTITY"
    | "REVIEW_SUPPRESSION"
    | "REVIEW_KILL_SWITCH"
    | "WAIT_AND_RUN_PREFLIGHT";
}>;

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

const readinessConditionSet = new Set<string>(
  gmailSendReadinessConditionCodes,
);

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (
    typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Gmail readiness content is not JSON-compatible.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const readinessHash = (
  value: Omit<GmailSendReadinessSnapshot, "snapshotVersion">,
): string =>
  createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");

const recoveryActionFor = (
  code: GmailSendReadinessChangedCondition["code"],
): GmailSendReadinessChangedCondition["recoveryAction"] => {
  switch (code) {
    case "DRAFT_APPROVAL":
      return "REAPPROVE_CURRENT_DRAFT";
    case "CONTACT_VERSION":
      return "REFRESH_CONTACT";
    case "GMAIL_BINDING":
      return "RESELECT_GMAIL_ACCOUNT";
    case "GMAIL_IDENTITY":
      return "VERIFY_SEND_IDENTITY";
    case "SUPPRESSION":
      return "REVIEW_SUPPRESSION";
    case "KILL_SWITCH":
      return "REVIEW_KILL_SWITCH";
    case "COOLDOWN":
    case "QUOTA":
      return "WAIT_AND_RUN_PREFLIGHT";
    case "SNAPSHOT_VALIDITY":
      return "RUN_PREFLIGHT_AGAIN";
  }
};

const normalizeReadinessConditions = (
  conditions: readonly GmailSendReadinessCondition[],
): readonly GmailSendReadinessCondition[] => {
  const seen = new Set<string>();
  const normalized = conditions.map((condition) => {
    if (!readinessConditionSet.has(condition.code)) {
      throw new TypeError(
        `Unsupported Gmail readiness condition: ${condition.code}.`,
      );
    }
    assertNonBlank(condition.revision, `${condition.code}.revision`);
    if (seen.has(condition.code)) {
      throw new TypeError(
        `Duplicate Gmail readiness condition: ${condition.code}.`,
      );
    }
    seen.add(condition.code);
    return Object.freeze({
      code: condition.code,
      revision: condition.revision,
    });
  }).sort((left, right) => left.code.localeCompare(right.code));
  if (seen.size !== gmailSendReadinessConditionCodes.length) {
    throw new TypeError("Gmail readiness conditions are incomplete.");
  }
  return Object.freeze(normalized);
};

export function createGmailSendReadinessSnapshot(input: Readonly<{
  evaluatedAt: Date;
  conditions: readonly GmailSendReadinessCondition[];
  ttlSeconds?: number;
}>): GmailSendReadinessSnapshot {
  if (!Number.isFinite(input.evaluatedAt.getTime())) {
    throw new TypeError("Gmail readiness evaluatedAt must be valid.");
  }
  const ttlSeconds =
    input.ttlSeconds ?? gmailSendReadinessDefaultTtlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("Gmail readiness ttlSeconds must be positive.");
  }
  const snapshot = Object.freeze({
    schemaVersion: gmailSendReadinessSchemaVersion,
    policyVersion: gmailSendPolicyVersion,
    evaluatedAt: input.evaluatedAt.toISOString(),
    expiresAt: new Date(
      input.evaluatedAt.getTime() + ttlSeconds * 1000,
    ).toISOString(),
    conditions: normalizeReadinessConditions(input.conditions),
  });
  return Object.freeze({
    ...snapshot,
    snapshotVersion: readinessHash(snapshot),
  });
}

export function compareGmailSendReadinessSnapshot(input: Readonly<{
  expected: GmailSendReadinessSnapshot;
  currentConditions: readonly GmailSendReadinessCondition[];
  comparedAt: Date;
}>): readonly GmailSendReadinessChangedCondition[] {
  if (!Number.isFinite(input.comparedAt.getTime())) {
    throw new TypeError("Gmail readiness comparedAt must be valid.");
  }
  const expectedWithoutVersion = {
    schemaVersion: input.expected.schemaVersion,
    policyVersion: input.expected.policyVersion,
    evaluatedAt: input.expected.evaluatedAt,
    expiresAt: input.expected.expiresAt,
    conditions: normalizeReadinessConditions(input.expected.conditions),
  };
  if (
    input.expected.schemaVersion !== gmailSendReadinessSchemaVersion
    || input.expected.policyVersion !== gmailSendPolicyVersion
    || readinessHash(expectedWithoutVersion)
      !== input.expected.snapshotVersion
  ) {
    return Object.freeze([Object.freeze({
      code: "SNAPSHOT_VALIDITY",
      reason: "MISSING",
      expectedRevision: input.expected.snapshotVersion || null,
      currentRevision: null,
      retryable: true,
      recoveryAction: recoveryActionFor("SNAPSHOT_VALIDITY"),
    })]);
  }
  const expiresAt = asTimestamp(input.expected.expiresAt, "expiresAt");
  if (input.comparedAt.getTime() > expiresAt) {
    return Object.freeze([Object.freeze({
      code: "SNAPSHOT_VALIDITY",
      reason: "EXPIRED",
      expectedRevision: input.expected.snapshotVersion,
      currentRevision: null,
      retryable: true,
      recoveryAction: recoveryActionFor("SNAPSHOT_VALIDITY"),
    })]);
  }

  const expectedByCode = new Map(
    input.expected.conditions.map((condition) => [
      condition.code,
      condition.revision,
    ]),
  );
  const currentByCode = new Map(
    normalizeReadinessConditions(input.currentConditions).map(
      (condition) => [condition.code, condition.revision],
    ),
  );
  const changes = gmailSendReadinessConditionCodes.flatMap((code) => {
    const expectedRevision = expectedByCode.get(code) ?? null;
    const currentRevision = currentByCode.get(code) ?? null;
    if (expectedRevision === currentRevision) return [];
    return [Object.freeze({
      code,
      reason: expectedRevision === null || currentRevision === null
        ? "MISSING" as const
        : "CHANGED" as const,
      expectedRevision,
      currentRevision,
      retryable: true as const,
      recoveryAction: recoveryActionFor(code),
    })];
  });
  return Object.freeze(changes);
}

export function describeGmailSendReadinessChange(input: Readonly<{
  expected: GmailSendReadinessSnapshot;
  code: GmailSendReadinessConditionCode;
  currentRevision: string | null;
}>): GmailSendReadinessChangedCondition {
  const expectedRevision = input.expected.conditions.find(
    (condition) => condition.code === input.code,
  )?.revision ?? null;
  return Object.freeze({
    code: input.code,
    reason: expectedRevision === null || input.currentRevision === null
      ? "MISSING"
      : "CHANGED",
    expectedRevision,
    currentRevision: input.currentRevision,
    retryable: true,
    recoveryAction: recoveryActionFor(input.code),
  });
}

export function describeGmailSendReadinessSnapshotValidity(
  input: Readonly<{
    expected: GmailSendReadinessSnapshot;
    reason: "CHANGED" | "MISSING" | "EXPIRED";
    currentRevision: string | null;
  }>,
): GmailSendReadinessChangedCondition {
  return Object.freeze({
    code: "SNAPSHOT_VALIDITY",
    reason: input.reason,
    expectedRevision: input.expected.snapshotVersion || null,
    currentRevision: input.currentRevision,
    retryable: true,
    recoveryAction: recoveryActionFor("SNAPSHOT_VALIDITY"),
  });
}

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
