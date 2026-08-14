export const recommendationRefillRootCauses = [
  "BUDGET_PAUSED",
  "PROVIDER_UNAVAILABLE",
  "PROJECT_CONTEXT_REQUIRED",
  "RECOVERY_CONFLICT",
  "STALE_BUILD",
  "ORPHAN_OPERATION",
  "SUPPLY_FLOOR_REACHED",
  "UNKNOWN_INTERNAL",
] as const;

export type RecommendationRefillRootCause =
  (typeof recommendationRefillRootCauses)[number];

export const recommendationRefillRecoveries = [
  "RESUME_OPERATION",
  "WAIT_PROVIDER",
  "COMPLETE_PROJECT_CONTEXT",
  "RESTART_SERVICE",
  "CONTACT_SUPPORT",
] as const;

export type RecommendationRefillRecovery =
  (typeof recommendationRefillRecoveries)[number];

export type RecommendationRefillFailure = Readonly<{
  rootCause: RecommendationRefillRootCause;
  recovery: RecommendationRefillRecovery;
  providerCallOccurred: boolean;
  diagnosticId: string;
  message: string;
}>;

type NormalizedFailure = Omit<
  RecommendationRefillFailure,
  "providerCallOccurred"
>;

const definitions: Readonly<Record<
  Exclude<RecommendationRefillRootCause, "UNKNOWN_INTERNAL">,
  Readonly<{ recovery: RecommendationRefillRecovery; message: string }>
>> = {
  BUDGET_PAUSED: {
    recovery: "WAIT_PROVIDER",
    message: "Provider budget is paused. Existing recommendations were kept.",
  },
  PROVIDER_UNAVAILABLE: {
    recovery: "WAIT_PROVIDER",
    message: "The recommendation provider is unavailable. Retry after recovery.",
  },
  PROJECT_CONTEXT_REQUIRED: {
    recovery: "COMPLETE_PROJECT_CONTEXT",
    message: "Complete the current project context before resuming this operation.",
  },
  RECOVERY_CONFLICT: {
    recovery: "RESUME_OPERATION",
    message: "The current operation cannot be resumed from this request.",
  },
  STALE_BUILD: {
    recovery: "RESTART_SERVICE",
    message: "The running service build is stale. Restart the local product.",
  },
  ORPHAN_OPERATION: {
    recovery: "RESTART_SERVICE",
    message: "The operation has no live owner. Reconcile or restart the service.",
  },
  SUPPLY_FLOOR_REACHED: {
    recovery: "RESUME_OPERATION",
    message:
      "Eligible recommendation supply remains below target. Resume the same operation.",
  },
};

function diagnosticHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function errorText(error: unknown): string {
  const fragments: string[] = [];
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6; depth++) {
    if (current instanceof Error) {
      if (visited.has(current)) break;
      visited.add(current);
      const details = current as Error & Readonly<{
        cause?: unknown;
        code?: unknown;
        type?: unknown;
      }>;
      fragments.push([
        current.name,
        current.message,
        typeof details.code === "string" ? details.code : "",
        typeof details.type === "string" ? details.type : "",
      ].filter((value) => value !== "").join(":"));
      current = details.cause;
      if (current === undefined) break;
      continue;
    }
    if (typeof current === "string") fragments.push(current);
    break;
  }
  return fragments.length > 0 ? fragments.join("|caused-by|") : "UNKNOWN";
}

function classify(value: string): RecommendationRefillRootCause {
  const upper = value.toUpperCase();
  if (upper.includes("BUDGET")) return "BUDGET_PAUSED";
  if (upper.includes("PROVIDER") || upper.includes("DATAFORSEO")) {
    return "PROVIDER_UNAVAILABLE";
  }
  if (upper.includes("PROJECT_CONTEXT")) return "PROJECT_CONTEXT_REQUIRED";
  if (
    upper.includes("CONFLICT")
    || upper.includes("ALREADY_STARTED")
    || upper.includes("RESUME_NOT_ALLOWED")
    || upper.includes("LOCK TIMEOUT")
    || upper.includes("55P03")
  ) {
    return "RECOVERY_CONFLICT";
  }
  if (upper.includes("STALE_BUILD") || upper.includes("BUILD_ID")) {
    return "STALE_BUILD";
  }
  if (upper.includes("ORPHAN")) return "ORPHAN_OPERATION";
  if (
    upper.includes("TIER")
    || upper.includes("SUPPLY_FLOOR")
    || upper.includes("SUPPLY_EXHAUSTED")
  ) {
    return "SUPPLY_FLOOR_REACHED";
  }
  return "UNKNOWN_INTERNAL";
}

export function normalizeRecommendationRefillFailure(
  error: unknown,
  operationId: string,
): NormalizedFailure {
  const text = errorText(error);
  const rootCause = classify(text);
  const diagnosticId = [
    "refill",
    operationId.replaceAll("-", "").slice(0, 12),
    diagnosticHash(text),
  ].join("-");
  if (rootCause === "UNKNOWN_INTERNAL") {
    return {
      rootCause,
      recovery: "CONTACT_SUPPORT",
      diagnosticId,
      message: "The recommendation operation failed unexpectedly.",
    };
  }
  return { rootCause, diagnosticId, ...definitions[rootCause] };
}
