export const gmailProgressiveVerificationLevels = Object.freeze({
  restricted: "RESTRICTED",
  newConnection: "NEW_CONNECTION",
  reputationBuilding: "REPUTATION_BUILDING",
  standard: "STANDARD",
} as const);

export type GmailProgressiveVerificationLevel =
  (typeof gmailProgressiveVerificationLevels)[keyof typeof gmailProgressiveVerificationLevels];

export type GmailProgressiveVerificationProfile = Readonly<{
  rolling24HourSendLimit: number;
  minimumIntervalSeconds: number;
  bulkSendingAllowed: false;
  automatedSendingAllowed: false;
}>;

export const gmailProgressiveVerificationProfiles: Readonly<
  Record<GmailProgressiveVerificationLevel, GmailProgressiveVerificationProfile>
> = Object.freeze({
  RESTRICTED: Object.freeze({
    rolling24HourSendLimit: 1,
    minimumIntervalSeconds: 900,
    bulkSendingAllowed: false,
    automatedSendingAllowed: false,
  }),
  NEW_CONNECTION: Object.freeze({
    rolling24HourSendLimit: 5,
    minimumIntervalSeconds: 300,
    bulkSendingAllowed: false,
    automatedSendingAllowed: false,
  }),
  REPUTATION_BUILDING: Object.freeze({
    rolling24HourSendLimit: 20,
    minimumIntervalSeconds: 120,
    bulkSendingAllowed: false,
    automatedSendingAllowed: false,
  }),
  STANDARD: Object.freeze({
    rolling24HourSendLimit: 50,
    minimumIntervalSeconds: 60,
    bulkSendingAllowed: false,
    automatedSendingAllowed: false,
  }),
});

export const gmailProgressiveVerificationReasonCodes = Object.freeze({
  newConnection: "NEW_CONNECTION",
  highAnomalyRate: "HIGH_ANOMALY_RATE",
  elevatedAnomalyRate: "ELEVATED_ANOMALY_RATE",
  lowReputation: "LOW_REPUTATION",
  insufficientEvidence: "INSUFFICIENT_EVIDENCE",
  restrictionCooldown: "RESTRICTION_COOLDOWN",
  advancedOneLevel: "ADVANCED_ONE_LEVEL",
  heldCurrentLevel: "HELD_CURRENT_LEVEL",
  recoveredToNewConnection: "RECOVERED_TO_NEW_CONNECTION",
} as const);

export type GmailProgressiveVerificationReasonCode =
  (typeof gmailProgressiveVerificationReasonCodes)[keyof typeof gmailProgressiveVerificationReasonCodes];

declare const gmailProgressiveVerificationStateBrand: unique symbol;

export type GmailProgressiveVerificationState = Readonly<{
  level: GmailProgressiveVerificationLevel;
  enteredAt: string;
  evaluatedAt: string;
  [gmailProgressiveVerificationStateBrand]: true;
}>;

export type GmailProgressiveVerificationSignals = Readonly<{
  connectedAt: string;
  evaluatedAt: string;
  acceptedSendCount: number;
  recentAttemptCount: number;
  recentAnomalyCount: number;
  reputationScore: number | null;
}>;

export type GmailProgressiveVerificationDecision = Readonly<{
  state: GmailProgressiveVerificationState;
  profile: GmailProgressiveVerificationProfile;
  anomalyRate: number;
  reasons: readonly GmailProgressiveVerificationReasonCode[];
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

const parseTimestamp = (value: string): number => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Gmail progressive verification timestamp is invalid.");
  }
  return timestamp;
};

const assertCount = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Gmail progressive verification count is invalid.");
  }
};

const normalizeSignals = (
  signals: GmailProgressiveVerificationSignals,
): Readonly<{
  connectedAt: string;
  connectedAtMs: number;
  evaluatedAt: string;
  evaluatedAtMs: number;
  acceptedSendCount: number;
  recentAttemptCount: number;
  recentAnomalyCount: number;
  reputationScore: number | null;
  anomalyRate: number;
}> => {
  const connectedAtMs = parseTimestamp(signals.connectedAt);
  const evaluatedAtMs = parseTimestamp(signals.evaluatedAt);
  if (evaluatedAtMs < connectedAtMs) {
    throw new TypeError(
      "Gmail progressive verification cannot predate the connection.",
    );
  }

  assertCount(signals.acceptedSendCount);
  assertCount(signals.recentAttemptCount);
  assertCount(signals.recentAnomalyCount);
  if (signals.recentAnomalyCount > signals.recentAttemptCount) {
    throw new TypeError(
      "Gmail progressive verification anomaly count exceeds attempts.",
    );
  }
  if (
    signals.reputationScore !== null &&
    (!Number.isFinite(signals.reputationScore) ||
      signals.reputationScore < 0 ||
      signals.reputationScore > 100)
  ) {
    throw new TypeError(
      "Gmail progressive verification reputation score is invalid.",
    );
  }

  return Object.freeze({
    connectedAt: new Date(connectedAtMs).toISOString(),
    connectedAtMs,
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
    evaluatedAtMs,
    acceptedSendCount: signals.acceptedSendCount,
    recentAttemptCount: signals.recentAttemptCount,
    recentAnomalyCount: signals.recentAnomalyCount,
    reputationScore: signals.reputationScore,
    anomalyRate:
      signals.recentAttemptCount === 0
        ? 0
        : signals.recentAnomalyCount / signals.recentAttemptCount,
  });
};

const issueDecision = (
  level: GmailProgressiveVerificationLevel,
  enteredAt: string,
  evaluatedAt: string,
  anomalyRate: number,
  reasons: readonly GmailProgressiveVerificationReasonCode[],
): GmailProgressiveVerificationDecision => {
  const state = Object.freeze({
    level,
    enteredAt,
    evaluatedAt,
  }) as GmailProgressiveVerificationState;
  return Object.freeze({
    state,
    profile: gmailProgressiveVerificationProfiles[level],
    anomalyRate,
    reasons: Object.freeze([...reasons]),
  });
};

const hasSevereRisk = (signals: ReturnType<typeof normalizeSignals>): boolean =>
  (signals.reputationScore !== null && signals.reputationScore < 50) ||
  signals.anomalyRate >= 0.1;

const hasElevatedRisk = (
  signals: ReturnType<typeof normalizeSignals>,
): boolean =>
  (signals.reputationScore !== null && signals.reputationScore < 70) ||
  signals.anomalyRate >= 0.05;

const riskReasons = (
  signals: ReturnType<typeof normalizeSignals>,
): GmailProgressiveVerificationReasonCode[] => {
  const reasons: GmailProgressiveVerificationReasonCode[] = [];
  if (signals.reputationScore !== null && signals.reputationScore < 70) {
    reasons.push(gmailProgressiveVerificationReasonCodes.lowReputation);
  }
  if (signals.anomalyRate >= 0.1) {
    reasons.push(gmailProgressiveVerificationReasonCodes.highAnomalyRate);
  } else if (signals.anomalyRate >= 0.05) {
    reasons.push(gmailProgressiveVerificationReasonCodes.elevatedAnomalyRate);
  }
  return reasons;
};

const isNewConnectionUpgradeEligible = (
  signals: ReturnType<typeof normalizeSignals>,
): boolean =>
  signals.evaluatedAtMs - signals.connectedAtMs >= 7 * DAY_MS &&
  signals.acceptedSendCount >= 10 &&
  signals.recentAttemptCount >= 10 &&
  signals.reputationScore !== null &&
  signals.reputationScore >= 70 &&
  signals.anomalyRate < 0.05;

const isStandardUpgradeEligible = (
  signals: ReturnType<typeof normalizeSignals>,
): boolean =>
  signals.evaluatedAtMs - signals.connectedAtMs >= 21 * DAY_MS &&
  signals.acceptedSendCount >= 50 &&
  signals.recentAttemptCount >= 25 &&
  signals.reputationScore !== null &&
  signals.reputationScore >= 85 &&
  signals.anomalyRate < 0.02;

export const createGmailProgressiveVerification = (
  signals: GmailProgressiveVerificationSignals,
): GmailProgressiveVerificationDecision => {
  const normalized = normalizeSignals(signals);
  if (hasSevereRisk(normalized)) {
    return issueDecision(
      gmailProgressiveVerificationLevels.restricted,
      normalized.evaluatedAt,
      normalized.evaluatedAt,
      normalized.anomalyRate,
      riskReasons(normalized),
    );
  }

  return issueDecision(
    gmailProgressiveVerificationLevels.newConnection,
    normalized.evaluatedAt,
    normalized.evaluatedAt,
    normalized.anomalyRate,
    [gmailProgressiveVerificationReasonCodes.newConnection],
  );
};

export const evaluateGmailProgressiveVerification = (
  current: GmailProgressiveVerificationState,
  signals: GmailProgressiveVerificationSignals,
): GmailProgressiveVerificationDecision => {
  const normalized = normalizeSignals(signals);
  if (
    !Object.values(gmailProgressiveVerificationLevels).includes(current.level)
  ) {
    throw new TypeError(
      "Gmail progressive verification state level is invalid.",
    );
  }
  const currentEvaluatedAtMs = parseTimestamp(current.evaluatedAt);
  const currentEnteredAtMs = parseTimestamp(current.enteredAt);
  if (
    currentEnteredAtMs > currentEvaluatedAtMs ||
    normalized.evaluatedAtMs < currentEvaluatedAtMs
  ) {
    throw new TypeError(
      "Gmail progressive verification state chronology is invalid.",
    );
  }

  if (hasSevereRisk(normalized)) {
    return issueDecision(
      gmailProgressiveVerificationLevels.restricted,
      current.level === gmailProgressiveVerificationLevels.restricted
        ? current.enteredAt
        : normalized.evaluatedAt,
      normalized.evaluatedAt,
      normalized.anomalyRate,
      riskReasons(normalized),
    );
  }

  if (current.level === gmailProgressiveVerificationLevels.restricted) {
    const restrictionExpired =
      normalized.evaluatedAtMs - currentEnteredAtMs >= 7 * DAY_MS;
    const healthyRecoveryEvidence =
      normalized.reputationScore !== null &&
      normalized.reputationScore >= 70 &&
      normalized.recentAttemptCount >= 10 &&
      normalized.anomalyRate < 0.02;
    if (restrictionExpired && healthyRecoveryEvidence) {
      return issueDecision(
        gmailProgressiveVerificationLevels.newConnection,
        normalized.evaluatedAt,
        normalized.evaluatedAt,
        normalized.anomalyRate,
        [gmailProgressiveVerificationReasonCodes.recoveredToNewConnection],
      );
    }

    return issueDecision(
      current.level,
      current.enteredAt,
      normalized.evaluatedAt,
      normalized.anomalyRate,
      [
        restrictionExpired
          ? gmailProgressiveVerificationReasonCodes.insufficientEvidence
          : gmailProgressiveVerificationReasonCodes.restrictionCooldown,
      ],
    );
  }

  if (hasElevatedRisk(normalized)) {
    const downgradedLevel =
      current.level === gmailProgressiveVerificationLevels.standard
        ? gmailProgressiveVerificationLevels.reputationBuilding
        : current.level ===
            gmailProgressiveVerificationLevels.reputationBuilding
          ? gmailProgressiveVerificationLevels.newConnection
          : current.level;
    return issueDecision(
      downgradedLevel,
      downgradedLevel === current.level
        ? current.enteredAt
        : normalized.evaluatedAt,
      normalized.evaluatedAt,
      normalized.anomalyRate,
      riskReasons(normalized),
    );
  }

  if (
    current.level === gmailProgressiveVerificationLevels.newConnection &&
    isNewConnectionUpgradeEligible(normalized)
  ) {
    return issueDecision(
      gmailProgressiveVerificationLevels.reputationBuilding,
      normalized.evaluatedAt,
      normalized.evaluatedAt,
      normalized.anomalyRate,
      [gmailProgressiveVerificationReasonCodes.advancedOneLevel],
    );
  }

  if (
    current.level === gmailProgressiveVerificationLevels.reputationBuilding &&
    isStandardUpgradeEligible(normalized)
  ) {
    return issueDecision(
      gmailProgressiveVerificationLevels.standard,
      normalized.evaluatedAt,
      normalized.evaluatedAt,
      normalized.anomalyRate,
      [gmailProgressiveVerificationReasonCodes.advancedOneLevel],
    );
  }

  return issueDecision(
    current.level,
    current.enteredAt,
    normalized.evaluatedAt,
    normalized.anomalyRate,
    [
      current.level === gmailProgressiveVerificationLevels.standard
        ? gmailProgressiveVerificationReasonCodes.heldCurrentLevel
        : gmailProgressiveVerificationReasonCodes.insufficientEvidence,
    ],
  );
};
