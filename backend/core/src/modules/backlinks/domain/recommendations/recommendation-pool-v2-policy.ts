export const recommendationPoolV2ContractVersion = "recommendation-pool.v2";
export const recommendationPoolV2AdmissionContractVersion =
  "recommendation-pool-admission.v2";
export const recommendationPoolV2AdmissionPolicyVersion =
  "recommendation-pool-admission-policy.v1";
export const recommendationSeedContractVersion = "recommendation-seed.v1";
export const recommendationReleaseContractVersion = "recommendation-release.v1";
export const recommendationMarkerVersion = "recommendation-marker.v1";
export const recommendationDiscoveryBudgetPolicyVersion =
  "recommendation-discovery-budget.v1";
export const recommendationPoolV2OperationalPolicyVersion =
  "recommendation-pool-operations.v1";

export const recommendationDiscoveryRoundBudgetMicros = 1_000_000;
export const recommendationDiscoveryTotalBudgetMicros = 2_000_000;
export const recommendationDiscoverySupplyThreshold = 100;
export const recommendationDiscoveryHardCandidateLimit = 1_000;
export const recommendationLowYieldMinimumNewUnique = 5;
export const recommendationLowYieldMinimumRate = 0.05;

export const recommendationPoolV2HardExclusionCodes = [
  "SELF_DOMAIN",
  "INVALID_DOMAIN",
  "UNREACHABLE_DOMAIN",
  "MALICIOUS_OR_BLOCKED",
  "ALREADY_RELEASED_TO_PROJECT",
  "EXISTING_PROJECT_OPPORTUNITY",
  "OBVIOUSLY_UNRELATED",
  "PERMANENTLY_EXCLUDED",
] as const;

export type RecommendationPoolV2HardExclusionCode =
  (typeof recommendationPoolV2HardExclusionCodes)[number];

export const recommendationPoolV2AdmissionPolicy = Object.freeze({
  version: recommendationPoolV2AdmissionPolicyVersion,
  admissionContractVersion: recommendationPoolV2AdmissionContractVersion,
  hardExclusionCodes: Object.freeze([
    ...recommendationPoolV2HardExclusionCodes,
  ]),
});

export const recommendationPoolV2OperationalPolicy = Object.freeze({
  version: recommendationPoolV2OperationalPolicyVersion,
  discovery: Object.freeze({
    maximumPaidRequests: 25,
    maximumRowsPerRequest: 100,
    rawObservationLimit: 2_500,
  }),
  contactPreparation: Object.freeze({
    batchPreparationDeadlineHours: 24,
    pollIntervalMs: 15 * 60_000,
    maxPages: 8,
    maxDepth: 2,
    maxAttempts: 3,
    retryDelayMs: 30_000,
    staticFetchTimeoutMs: 12_000,
    browserWorkerTimeoutMs: 20_000,
    activityTimeoutMs: 8 * 60_000,
  }),
});

// New workflow histories opt in; the original policy remains immutable.
export const recommendationPoolV2PublicationPollingPolicy = Object.freeze({
  version: "recommendation-pool-publication-poll.v2",
  pollIntervalMs: 5_000,
});

export type RecommendationDiscoveryWindow = Readonly<{
  completed: boolean;
  rawCandidateCount: number;
  canonicalCandidateCount: number;
  newUniqueCount: number;
  admittedCount?: number;
  hardExcludedCount?: number;
}>;

export type RecommendationDiscoveryRequestPlan = Readonly<{
  canonicalRequestFingerprint: string;
  keywordFingerprint: string;
  competitorFingerprint: string;
  sourceType: string;
  pageType: string;
  strategyVersion: string;
  countryCode: string;
  languageCode: string;
  businessDirectionFingerprint: string;
  authorizedCostMicros: number;
}>;

export type RecommendationDiscoveryChargeState =
  "settled" | "unknown_charge" | "ambiguous_charge";

export type RecommendationDiscoveryStopReason =
  | "CANDIDATE_LIMIT_REACHED"
  | "SAFE_SUPPLY_REACHED"
  | "LOW_YIELD"
  | "BUDGET_EXHAUSTED"
  | "PATHS_EXHAUSTED"
  | "CONTEXT_SUPERSEDED"
  | "UNKNOWN_CHARGE"
  | "REQUEST_SCOPE_CHANGED";

export type RecommendationDiscoveryTerminalFacts = Readonly<{
  policyVersion: typeof recommendationDiscoveryBudgetPolicyVersion;
  reason: RecommendationDiscoveryStopReason;
  uniqueCandidateCount: number;
  settledCostMicros: number;
  completedWindowCount: number;
}>;

export type RecommendationSecondRoundDecision =
  | Readonly<{
      kind: "START_ROUND_2";
      policyVersion: typeof recommendationDiscoveryBudgetPolicyVersion;
      round: 2;
      authorizedCostMicros: number;
      canonicalRequestFingerprint: string;
    }>
  | Readonly<{
      kind: "STOP";
      reason: RecommendationDiscoveryStopReason;
      terminalFacts: RecommendationDiscoveryTerminalFacts;
    }>;

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Recommendation V2 ${label} is invalid`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`Recommendation V2 ${label} is invalid`);
  }
}

function validateDiscoveryRequestPlan(
  request: RecommendationDiscoveryRequestPlan,
  round: 1 | 2,
): void {
  assertNonEmptyString(
    request.canonicalRequestFingerprint,
    `round ${round} canonical request fingerprint`,
  );
  assertNonEmptyString(
    request.keywordFingerprint,
    `round ${round} keyword fingerprint`,
  );
  assertNonEmptyString(
    request.competitorFingerprint,
    `round ${round} competitor fingerprint`,
  );
  assertNonEmptyString(request.sourceType, `round ${round} source type`);
  assertNonEmptyString(request.pageType, `round ${round} page type`);
  assertNonEmptyString(
    request.strategyVersion,
    `round ${round} strategy version`,
  );
  assertNonEmptyString(request.countryCode, `round ${round} country`);
  assertNonEmptyString(request.languageCode, `round ${round} language`);
  assertNonEmptyString(
    request.businessDirectionFingerprint,
    `round ${round} business direction fingerprint`,
  );
  assertNonNegativeInteger(
    request.authorizedCostMicros,
    `round ${round} authorized cost`,
  );
  if (request.authorizedCostMicros > recommendationDiscoveryRoundBudgetMicros) {
    throw new TypeError(
      `Recommendation V2 round ${round} authorized cost exceeds 1 USD`,
    );
  }
}

export function isRecommendationLowYieldWindow(
  window: RecommendationDiscoveryWindow,
): boolean {
  assertNonNegativeInteger(window.rawCandidateCount, "raw candidate count");
  assertNonNegativeInteger(
    window.canonicalCandidateCount,
    "canonical candidate count",
  );
  assertNonNegativeInteger(window.newUniqueCount, "new unique count");
  if (window.newUniqueCount > window.canonicalCandidateCount) {
    throw new TypeError(
      "Recommendation V2 new unique count exceeds canonical candidate count",
    );
  }
  if (!window.completed) {
    return false;
  }
  if (window.newUniqueCount >= recommendationLowYieldMinimumNewUnique) {
    return false;
  }
  const rate =
    window.canonicalCandidateCount === 0
      ? 0
      : window.newUniqueCount / window.canonicalCandidateCount;
  return rate < recommendationLowYieldMinimumRate;
}

export function hasConsecutiveRecommendationLowYield(
  windows: readonly RecommendationDiscoveryWindow[],
): boolean {
  const completedWindows = windows.filter((window) => window.completed);
  if (completedWindows.length < 2) {
    return false;
  }
  return completedWindows
    .slice(-2)
    .every((window) => isRecommendationLowYieldWindow(window));
}

function discoveryPathChanged(
  round1: RecommendationDiscoveryRequestPlan,
  round2: RecommendationDiscoveryRequestPlan,
): boolean {
  return (
    round1.keywordFingerprint !== round2.keywordFingerprint ||
    round1.competitorFingerprint !== round2.competitorFingerprint ||
    round1.sourceType !== round2.sourceType ||
    round1.pageType !== round2.pageType ||
    round1.strategyVersion !== round2.strategyVersion
  );
}

export function decideRecommendationSecondRound(
  input: Readonly<{
    policyVersion: string;
    round1UniqueCandidateCount: number;
    round1SettledCostMicros: number;
    generationSettledCostMicros: number;
    chargeState: RecommendationDiscoveryChargeState;
    pathsExhausted: boolean;
    contextSuperseded: boolean;
    round1Request: RecommendationDiscoveryRequestPlan;
    round2Request: RecommendationDiscoveryRequestPlan | null;
    completedWindows: readonly RecommendationDiscoveryWindow[];
  }>,
): RecommendationSecondRoundDecision {
  if (input.policyVersion !== recommendationDiscoveryBudgetPolicyVersion) {
    throw new TypeError(
      `Recommendation V2 policy version ${input.policyVersion} is unsupported`,
    );
  }
  assertNonNegativeInteger(
    input.round1UniqueCandidateCount,
    "round 1 unique candidate count",
  );
  assertNonNegativeInteger(
    input.round1SettledCostMicros,
    "round 1 settled cost",
  );
  assertNonNegativeInteger(
    input.generationSettledCostMicros,
    "generation settled cost",
  );
  validateDiscoveryRequestPlan(input.round1Request, 1);
  if (
    input.round1SettledCostMicros > input.round1Request.authorizedCostMicros
  ) {
    throw new TypeError(
      "Recommendation V2 round 1 settled cost exceeds its authorization",
    );
  }
  if (input.generationSettledCostMicros < input.round1SettledCostMicros) {
    throw new TypeError(
      "Recommendation V2 generation settled cost excludes round 1",
    );
  }

  const stop = (
    reason: RecommendationDiscoveryStopReason,
  ): RecommendationSecondRoundDecision => ({
    kind: "STOP",
    reason,
    terminalFacts: {
      policyVersion: recommendationDiscoveryBudgetPolicyVersion,
      reason,
      uniqueCandidateCount: input.round1UniqueCandidateCount,
      settledCostMicros: input.generationSettledCostMicros,
      completedWindowCount: input.completedWindows.filter(
        (window) => window.completed,
      ).length,
    },
  });

  if (input.contextSuperseded) {
    return stop("CONTEXT_SUPERSEDED");
  }
  if (input.chargeState !== "settled") {
    return stop("UNKNOWN_CHARGE");
  }
  if (
    input.round1UniqueCandidateCount >=
    recommendationDiscoveryHardCandidateLimit
  ) {
    return stop("CANDIDATE_LIMIT_REACHED");
  }
  if (
    input.round1UniqueCandidateCount >= recommendationDiscoverySupplyThreshold
  ) {
    return stop("SAFE_SUPPLY_REACHED");
  }
  if (
    input.generationSettledCostMicros >=
    recommendationDiscoveryTotalBudgetMicros
  ) {
    return stop("BUDGET_EXHAUSTED");
  }
  if (hasConsecutiveRecommendationLowYield(input.completedWindows)) {
    return stop("LOW_YIELD");
  }
  if (input.pathsExhausted) {
    return stop("PATHS_EXHAUSTED");
  }
  if (input.round2Request === null) {
    return stop("PATHS_EXHAUSTED");
  }
  validateDiscoveryRequestPlan(input.round2Request, 2);
  if (
    input.round2Request.countryCode !== input.round1Request.countryCode ||
    input.round2Request.languageCode !== input.round1Request.languageCode ||
    input.round2Request.businessDirectionFingerprint !==
      input.round1Request.businessDirectionFingerprint
  ) {
    return stop("REQUEST_SCOPE_CHANGED");
  }
  if (
    input.round2Request.canonicalRequestFingerprint ===
      input.round1Request.canonicalRequestFingerprint ||
    !discoveryPathChanged(input.round1Request, input.round2Request)
  ) {
    return stop("PATHS_EXHAUSTED");
  }
  if (
    input.generationSettledCostMicros +
      input.round2Request.authorizedCostMicros >
    recommendationDiscoveryTotalBudgetMicros
  ) {
    return stop("BUDGET_EXHAUSTED");
  }
  return {
    kind: "START_ROUND_2",
    policyVersion: recommendationDiscoveryBudgetPolicyVersion,
    round: 2,
    authorizedCostMicros: input.round2Request.authorizedCostMicros,
    canonicalRequestFingerprint:
      input.round2Request.canonicalRequestFingerprint,
  };
}

export const recommendationContactTerminalStatuses = [
  "completed",
  "partially_completed",
  "no_contact_found",
  "stale_context",
] as const;

export type RecommendationContactStatus =
  | (typeof recommendationContactTerminalStatuses)[number]
  | "pending"
  | "running"
  | "retry_scheduled";

export function isRecommendationContactTerminal(
  status: RecommendationContactStatus,
): boolean {
  return (recommendationContactTerminalStatuses as readonly string[]).includes(
    status,
  );
}

export function resolveRecommendationContactTerminalReason(
  input: Readonly<{
    status: RecommendationContactStatus;
    terminalReasonCode: string | null;
    deadlineReached: boolean;
  }>,
): string | null {
  if (isRecommendationContactTerminal(input.status)) {
    return input.terminalReasonCode ?? input.status.toUpperCase();
  }
  return input.deadlineReached ? "COMPLETED_PARTIAL" : null;
}
