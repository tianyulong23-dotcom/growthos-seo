export const commercialRefillTiers = [
  "curated_resource_library",
  "exact_product_target_market",
  "same_topic_target_market",
  "adjacent_industry_same_audience",
  "resource_media_review_partner_ecosystem",
  "same_language_expansion",
] as const;

export type CommercialRefillTier = (typeof commercialRefillTiers)[number];
export const commercialPaidRefillTiers = [
  "exact_product_target_market",
  "same_topic_target_market",
  "adjacent_industry_same_audience",
  "resource_media_review_partner_ecosystem",
  "same_language_expansion",
] as const satisfies readonly Exclude<
  CommercialRefillTier,
  "curated_resource_library"
>[];

const commercialRefillWindowKeyTiers = [
  "exact_product_target_market",
  "same_topic_target_market",
  "adjacent_industry_same_audience",
  "resource_media_review_partner_ecosystem",
  "same_language_expansion",
  "curated_resource_library",
] as const satisfies readonly CommercialRefillTier[];

export const defaultCommercialSupplyPublishedTarget = 10;

export function resolveCommercialSupplyPublishedTarget(
  value: unknown,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : defaultCommercialSupplyPublishedTarget;
}

export type CommercialSupplyOutcome =
  | "TARGET_REACHED"
  | "PAUSED_BUDGET"
  | "PAUSED_PROVIDER"
  | "PROJECT_CONTEXT_REQUIRED"
  | "SUPPLY_FLOOR_REACHED";

export type CommercialPaidRefillTier =
  (typeof commercialPaidRefillTiers)[number];

export type CommercialRefillAttempt = Readonly<{
  tier: CommercialRefillTier;
  round: number;
  window: number;
  rawCandidateCount?: number | undefined;
  eligibleCandidateCount?: number | undefined;
  contactReadyCount?: number | undefined;
  publishedCount?: number | undefined;
}>;

export type CommercialSupplyCursor = Readonly<{
  tier: CommercialRefillTier;
  round: number;
}>;

export type CommercialSupplyProviderState =
  "available" | "budget_paused" | "provider_paused";

export type CommercialSupplyPlan =
  | Readonly<{
      kind: "execute";
      source: "paid" | "resource" | "existing";
      cursor: Readonly<CommercialSupplyCursor & { window: number }>;
      requestedCandidateCount: number;
    }>
  | Readonly<{
      kind: "wait";
      outcome: Exclude<
        CommercialSupplyOutcome,
        "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED"
      > | null;
      reason: "budget" | "provider" | "project_context";
    }>
  | Readonly<{
      kind: "complete";
      outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED";
    }>;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Commercial refill ${label} is invalid`);
  }
}

export function isCommercialRefillTier(
  value: unknown,
): value is CommercialRefillTier {
  return (
    typeof value === "string" &&
    (commercialRefillTiers as readonly string[]).includes(value)
  );
}

export function nextCommercialRefillTier(
  tier: CommercialRefillTier,
): CommercialRefillTier | null {
  const index = commercialRefillTiers.indexOf(tier);
  return commercialRefillTiers[index + 1] ?? null;
}

export function isCommercialPaidRefillTier(
  value: unknown,
): value is CommercialPaidRefillTier {
  return (
    typeof value === "string" &&
    (commercialPaidRefillTiers as readonly string[]).includes(value)
  );
}

export function buildCommercialRefillWindowKey(
  input: Readonly<{
    websiteProjectId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    tier: CommercialRefillTier;
    round: number;
    window?: number | undefined;
  }>,
): string {
  assertPositiveInteger(
    input.visiblePoolGeneration,
    "visiblePoolGeneration",
  );
  assertPositiveInteger(input.round, "round");
  const window = input.window ?? 1;
  assertPositiveInteger(window, "window");
  const tierIndex = commercialRefillWindowKeyTiers.indexOf(input.tier);
  if (tierIndex < 0) {
    throw new TypeError("Commercial refill tier is invalid");
  }
  return [
    "commercial-refill",
    input.websiteProjectId,
    input.projectContextVersionId,
    `g${input.visiblePoolGeneration}`,
    `t${tierIndex + 1}`,
    `r${input.round}`,
    `w${window}`,
  ].join(":");
}

export function parseCommercialRefillWindowKey(value: string): Readonly<{
  websiteProjectId: string;
  projectContextVersionId: string;
  visiblePoolGeneration: number;
  tier: CommercialRefillTier;
  round: number;
  window: number;
}> | null {
  const match =
    /^commercial-refill:([^:]+):([^:]+)(?::g([1-9]\d*))?:t([1-6]):r([1-9]\d*)(?::w([1-9]\d*))?$/u.exec(
      value,
    );
  if (match === null) return null;
  const visiblePoolGeneration = Number(match[3] ?? 1);
  const tier = commercialRefillWindowKeyTiers[Number(match[4]) - 1];
  const round = Number(match[5]);
  const window = Number(match[6] ?? 1);
  if (
    match[1] === undefined ||
    match[2] === undefined ||
    tier === undefined ||
    !Number.isSafeInteger(visiblePoolGeneration) ||
    !Number.isSafeInteger(round) ||
    !Number.isSafeInteger(window)
  ) {
    return null;
  }
  return Object.freeze({
    websiteProjectId: match[1],
    projectContextVersionId: match[2],
    visiblePoolGeneration,
    tier,
    round,
    window,
  });
}

export function parseCommercialRefillAttempts(
  value: unknown,
): readonly CommercialRefillAttempt[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const attempts = value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const round = Number(record.round);
    const window = record.window === undefined ? 1 : Number(record.window);
    const optionalCount = (name: string): number | undefined => {
      if (record[name] === undefined) return undefined;
      const parsed = Number(record[name]);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    };
    return isCommercialRefillTier(record.tier) &&
      Number.isSafeInteger(round) &&
      round >= 1 &&
      Number.isSafeInteger(window) &&
      window >= 1
      ? [
          Object.freeze({
            tier: record.tier,
            round,
            window,
            ...(optionalCount("rawCandidateCount") === undefined
              ? {}
              : { rawCandidateCount: optionalCount("rawCandidateCount") }),
            ...(optionalCount("eligibleCandidateCount") === undefined
              ? {}
              : {
                  eligibleCandidateCount: optionalCount(
                    "eligibleCandidateCount",
                  ),
                }),
            ...(optionalCount("contactReadyCount") === undefined
              ? {}
              : { contactReadyCount: optionalCount("contactReadyCount") }),
            ...(optionalCount("publishedCount") === undefined
              ? {}
              : { publishedCount: optionalCount("publishedCount") }),
          }),
        ]
      : [];
  });
  return Object.freeze(attempts);
}

export function hasCommercialRefillAttempt(
  attempts: readonly CommercialRefillAttempt[],
  tier: CommercialRefillTier,
  round: number,
  window = 1,
): boolean {
  return attempts.some(
    (attempt) =>
      attempt.tier === tier &&
      attempt.round === round &&
      attempt.window === window,
  );
}

export function nextCommercialRefillWindow(
  attempts: readonly CommercialRefillAttempt[],
  tier: CommercialRefillTier,
  round: number,
): number {
  const unfinishedWindow = attempts.reduce(
    (maximum, attempt) =>
      attempt.tier === tier &&
      attempt.round === round &&
      attempt.eligibleCandidateCount === undefined
        ? Math.max(maximum, attempt.window)
        : maximum,
    0,
  );
  if (unfinishedWindow > 0) return unfinishedWindow;
  return (
    attempts.reduce(
      (maximum, attempt) =>
        attempt.tier === tier && attempt.round === round
          ? Math.max(maximum, attempt.window)
          : maximum,
      0,
    ) + 1
  );
}

export function recordCommercialRefillAttemptOutcome(
  attempts: readonly CommercialRefillAttempt[],
  outcome: CommercialRefillAttempt,
): readonly CommercialRefillAttempt[] {
  const withoutCurrent = attempts.filter(
    (attempt) =>
      attempt.tier !== outcome.tier ||
      attempt.round !== outcome.round ||
      attempt.window !== outcome.window,
  );
  return Object.freeze([...withoutCurrent, Object.freeze({ ...outcome })]);
}

export function hasTwoConsecutiveEmptyCommercialRefillWindows(
  attempts: readonly CommercialRefillAttempt[],
  tier: CommercialRefillTier,
  round: number,
): boolean {
  const completed = attempts
    .filter(
      (attempt) =>
        attempt.tier === tier &&
        attempt.round === round &&
        attempt.eligibleCandidateCount !== undefined,
    )
    .sort((left, right) => right.window - left.window);
  return (
    completed.length >= 2 &&
    completed[0]?.eligibleCandidateCount === 0 &&
    completed[1]?.eligibleCandidateCount === 0
  );
}

function hasTwoConsecutiveZeroRawCommercialRefillRounds(
  attempts: readonly CommercialRefillAttempt[],
): boolean {
  const completedZeroRawRounds = new Set(
    [...new Set(attempts.map((attempt) => attempt.round))].filter((round) => {
      const roundAttempts = attempts.filter(
        (attempt) => attempt.round === round,
      );
      return (
        commercialRefillTiers.every((tier) =>
          hasTwoConsecutiveEmptyCommercialRefillWindows(
            attempts,
            tier,
            round,
          ),
        ) &&
        roundAttempts.length > 0 &&
        roundAttempts.every((attempt) => attempt.rawCandidateCount === 0)
      );
    }),
  );
  return [...completedZeroRawRounds].some((round) =>
    completedZeroRawRounds.has(round - 1),
  );
}

function rate(
  numerator: number,
  denominator: number,
  fallback: number,
): number {
  if (denominator <= 0) return fallback;
  return Math.min(1, Math.max(0.05, numerator / denominator));
}

export function calculateCommercialSupplySampleSize(
  input: Readonly<{
    targetPublishedCount: number;
    publishedCount: number;
    rawCandidateCount: number;
    fitCandidateCount: number;
    contactReadyCount: number;
    candidateLimit: number;
  }>,
): Readonly<{
  requestedCandidateCount: number;
  rawToFitRate: number;
  fitToContactRate: number;
  contactToPublishedRate: number;
}> {
  assertPositiveInteger(input.targetPublishedCount, "target");
  assertPositiveInteger(input.candidateLimit, "candidate limit");
  const rawToFitRate = rate(
    input.fitCandidateCount,
    input.rawCandidateCount,
    0.25,
  );
  const fitToContactRate = rate(
    input.contactReadyCount,
    input.fitCandidateCount,
    0.2,
  );
  const contactToPublishedRate = rate(
    input.publishedCount,
    input.contactReadyCount,
    0.8,
  );
  const deficit = Math.max(
    0,
    input.targetPublishedCount - input.publishedCount,
  );
  const conversionRate = rawToFitRate;
  return Object.freeze({
    requestedCandidateCount:
      deficit === 0
        ? 0
        : Math.min(
            input.candidateLimit,
            Math.max(2, Math.ceil(deficit / conversionRate)),
          ),
    rawToFitRate,
    fitToContactRate,
    contactToPublishedRate,
  });
}

function nextPaidCursor(
  cursor: Readonly<{
    tier: CommercialPaidRefillTier;
    round: number;
  }>,
  attempts: readonly CommercialRefillAttempt[],
): Readonly<{
  exhausted: boolean;
  cursor: Readonly<{
    tier: CommercialPaidRefillTier;
    round: number;
  }>;
  window: number;
}> {
  if (
    !hasTwoConsecutiveEmptyCommercialRefillWindows(
      attempts,
      cursor.tier,
      cursor.round,
    )
  ) {
    return Object.freeze({
      exhausted: false,
      cursor,
      window: nextCommercialRefillWindow(attempts, cursor.tier, cursor.round),
    });
  }
  const currentIndex = commercialPaidRefillTiers.indexOf(cursor.tier);
  const nextTier = commercialPaidRefillTiers[currentIndex + 1];
  return nextTier === undefined
    ? Object.freeze({
        exhausted: true,
        cursor,
        window: nextCommercialRefillWindow(attempts, cursor.tier, cursor.round),
      })
    : Object.freeze({
        exhausted: false,
        cursor: Object.freeze({ tier: nextTier, round: cursor.round }),
        window: nextCommercialRefillWindow(attempts, nextTier, cursor.round),
      });
}

function nextResourceCursor(
  cursor: Readonly<{
    tier: "curated_resource_library";
    round: number;
  }>,
  attempts: readonly CommercialRefillAttempt[],
): Readonly<{
  exhausted: boolean;
  cursor: Readonly<{
    tier: "curated_resource_library";
    round: number;
  }>;
  window: number;
}> {
  return Object.freeze({
    exhausted: hasTwoConsecutiveEmptyCommercialRefillWindows(
      attempts,
      cursor.tier,
      cursor.round,
    ),
    cursor,
    window: nextCommercialRefillWindow(attempts, cursor.tier, cursor.round),
  });
}

export function planCommercialSupplyOperation(
  input: Readonly<{
    projectContextReady: boolean;
    targetPublishedCount: number;
    publishedCount: number;
    rawCandidateCount: number;
    fitCandidateCount: number;
    readyFitCandidateCount: number;
    contactReadyCount: number;
    providerState: CommercialSupplyProviderState;
    paidCursor: Readonly<{
      tier: CommercialPaidRefillTier;
      round: number;
    }>;
    resourceCursor: Readonly<{
      tier: "curated_resource_library";
      round: number;
    }>;
    attempts: readonly CommercialRefillAttempt[];
    candidateLimit: number;
  }>,
): CommercialSupplyPlan {
  const sample = calculateCommercialSupplySampleSize({
    targetPublishedCount: input.targetPublishedCount,
    publishedCount: input.publishedCount,
    rawCandidateCount: input.rawCandidateCount,
    fitCandidateCount: input.fitCandidateCount,
    contactReadyCount: input.contactReadyCount,
    candidateLimit: input.candidateLimit,
  });
  if (input.publishedCount >= input.targetPublishedCount) {
    return Object.freeze({ kind: "complete", outcome: "TARGET_REACHED" });
  }
  if (!input.projectContextReady) {
    return Object.freeze({
      kind: "wait",
      outcome: "PROJECT_CONTEXT_REQUIRED",
      reason: "project_context",
    });
  }
  const paid = nextPaidCursor(input.paidCursor, input.attempts);
  const resource = nextResourceCursor(input.resourceCursor, input.attempts);
  const execute = (
    source: "paid" | "resource" | "existing",
    cursor: Readonly<CommercialSupplyCursor & { window: number }>,
    requestedCandidateCount = sample.requestedCandidateCount,
  ): CommercialSupplyPlan =>
    Object.freeze({
      kind: "execute",
      source,
      cursor,
      requestedCandidateCount,
    });

  if (input.readyFitCandidateCount > 0) {
    return execute(
      "existing",
      {
        ...input.paidCursor,
        window: nextCommercialRefillWindow(
          input.attempts,
          input.paidCursor.tier,
          input.paidCursor.round,
        ),
      },
      Math.min(sample.requestedCandidateCount, input.readyFitCandidateCount),
    );
  }
  if (hasTwoConsecutiveZeroRawCommercialRefillRounds(input.attempts)) {
    return Object.freeze({
      kind: "complete",
      outcome: "SUPPLY_FLOOR_REACHED",
    });
  }
  const paidAttemptPending = input.attempts.some(
    (attempt) =>
      attempt.tier === paid.cursor.tier &&
      attempt.round === paid.cursor.round &&
      attempt.window === paid.window &&
      attempt.eligibleCandidateCount === undefined,
  );
  if (input.providerState !== "available") {
    if (!resource.exhausted) {
      return execute("resource", {
        ...resource.cursor,
        window: resource.window,
      });
    }
    return Object.freeze({
      kind: "wait",
      outcome:
        input.providerState === "budget_paused"
          ? "PAUSED_BUDGET"
          : "PAUSED_PROVIDER",
      reason: input.providerState === "budget_paused" ? "budget" : "provider",
    });
  }
  if (paidAttemptPending && !paid.exhausted) {
    return execute("paid", {
      ...paid.cursor,
      window: paid.window,
    });
  }
  if (!resource.exhausted) {
    return execute("resource", {
      ...resource.cursor,
      window: resource.window,
    });
  }
  if (!paid.exhausted) {
    return execute("paid", {
      ...paid.cursor,
      window: paid.window,
    });
  }
  if (resource.cursor.round > paid.cursor.round) {
    return execute("paid", {
      tier: "exact_product_target_market",
      round: resource.cursor.round,
      window: 1,
    });
  }
  if (paid.cursor.round > resource.cursor.round) {
    return execute("resource", {
      tier: "curated_resource_library",
      round: paid.cursor.round,
      window: 1,
    });
  }
  const nextRound = Math.max(
    paid.cursor.round,
    resource.cursor.round,
  ) + 1;
  return execute("resource", {
    tier: "curated_resource_library",
    round: nextRound,
    window: 1,
  });
}

export function commercialSupplyOutcome(
  terminationReason: string | null,
): CommercialSupplyOutcome | null {
  switch (terminationReason) {
    case "HIGH_WATERMARK":
      return "TARGET_REACHED";
    case "BUDGET":
      return "PAUSED_BUDGET";
    case "PROVIDER_UNAVAILABLE":
      return "PAUSED_PROVIDER";
    case "PROJECT_CONTEXT":
      return "PROJECT_CONTEXT_REQUIRED";
    case "TIERS_EXHAUSTED":
      return "SUPPLY_FLOOR_REACHED";
    default:
      return null;
  }
}
