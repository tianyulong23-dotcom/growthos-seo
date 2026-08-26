import type {
  RecommendationRefillRootCause,
} from "./refill-failure.js";

export const recommendationProductStates = [
  "running",
  "waiting_retry",
  "paused_provider",
  "partial_exhausted",
  "maintenance",
  "blocked",
] as const;

export type RecommendationProductState =
  (typeof recommendationProductStates)[number];

export const recommendationRecoveryCommands = [
  "CONTINUE_SAME_CRITERIA",
  "EDIT_PROJECT_MATCH_INPUTS",
  "BROADEN_MARKET_OR_KEYWORDS",
  "CHANGE_DISCOVERY_SOURCE",
  "WAIT_PROVIDER",
  "RESTART_SERVICE",
  "CONTACT_SUPPORT",
] as const;

export type RecommendationRecoveryCommand =
  (typeof recommendationRecoveryCommands)[number];

export type RecommendationProviderAvailability =
  "available" | "paused" | "unknown";

export type RecommendationProductStateInput = Readonly<{
  visibleCount: number;
  targetCount: number;
  refillInFlight: boolean;
  nextRetryAt: string | null;
  terminationReason:
    | "HIGH_WATERMARK"
    | "BUDGET"
    | "PROVIDER_UNAVAILABLE"
    | "TIERS_EXHAUSTED"
    | "PROJECT_CONTEXT"
    | null;
  failureRootCause: RecommendationRefillRootCause | null;
  canResumeSameOperation: boolean;
  unknownChargeCount: number;
}>;

export type RecommendationProductStateResult = Readonly<{
  state: RecommendationProductState;
  reasonCode: string;
  recoveryCommand: RecommendationRecoveryCommand | null;
  providerAvailability: RecommendationProviderAvailability;
}>;

export function deriveRecommendationProductState(
  input: RecommendationProductStateInput,
): RecommendationProductStateResult {
  if (input.unknownChargeCount > 0) {
    return {
      state: "blocked",
      reasonCode: "PROVIDER_CHARGE_REQUIRES_RECONCILIATION",
      recoveryCommand: "CONTACT_SUPPORT",
      providerAvailability: "unknown",
    };
  }

  if (input.failureRootCause === "UNKNOWN_INTERNAL") {
    return input.canResumeSameOperation
      ? {
          state: "maintenance",
          reasonCode: input.failureRootCause,
          recoveryCommand: "CONTINUE_SAME_CRITERIA",
          providerAvailability: "available",
        }
      : {
          state: "blocked",
          reasonCode: input.failureRootCause,
          recoveryCommand: "CONTACT_SUPPORT",
          providerAvailability: "unknown",
        };
  }

  if (input.failureRootCause === "RECOVERY_CONFLICT") {
    return {
      state: "maintenance",
      reasonCode: input.failureRootCause,
      recoveryCommand: "CONTINUE_SAME_CRITERIA",
      providerAvailability: "available",
    };
  }

  if (
    input.failureRootCause === "STALE_BUILD"
    || input.failureRootCause === "ORPHAN_OPERATION"
  ) {
    return {
      state: "maintenance",
      reasonCode: input.failureRootCause,
      recoveryCommand: "RESTART_SERVICE",
      providerAvailability: "unknown",
    };
  }

  if (input.nextRetryAt !== null) {
    return {
      state: "waiting_retry",
      reasonCode: "RETRY_SCHEDULED",
      recoveryCommand: "CONTINUE_SAME_CRITERIA",
      providerAvailability: "available",
    };
  }

  if (
    input.terminationReason === "PROVIDER_UNAVAILABLE"
    || input.failureRootCause === "PROVIDER_UNAVAILABLE"
  ) {
    return {
      state: "paused_provider",
      reasonCode: "PROVIDER_UNAVAILABLE",
      recoveryCommand: "WAIT_PROVIDER",
      providerAvailability: "paused",
    };
  }

  if (
    input.visibleCount < input.targetCount
    && (
      input.terminationReason === "BUDGET"
      || input.terminationReason === "TIERS_EXHAUSTED"
      || input.terminationReason === "PROJECT_CONTEXT"
      || input.failureRootCause === "BUDGET_PAUSED"
      || input.failureRootCause === "PROJECT_CONTEXT_REQUIRED"
      || input.failureRootCause === "SUPPLY_FLOOR_REACHED"
    )
  ) {
    const reasonCode = input.failureRootCause ?? input.terminationReason
      ?? "SUPPLY_FLOOR_REACHED";
    const recoveryCommand: RecommendationRecoveryCommand =
      reasonCode === "PROJECT_CONTEXT"
        || reasonCode === "PROJECT_CONTEXT_REQUIRED"
        ? "EDIT_PROJECT_MATCH_INPUTS"
        : reasonCode === "TIERS_EXHAUSTED"
          || reasonCode === "SUPPLY_FLOOR_REACHED"
          ? "BROADEN_MARKET_OR_KEYWORDS"
          : "CONTINUE_SAME_CRITERIA";
    return {
      state: "partial_exhausted",
      reasonCode,
      recoveryCommand,
      providerAvailability: "available",
    };
  }

  return {
    state: "running",
    reasonCode: input.visibleCount >= input.targetCount
      ? "VISIBLE_TARGET_REACHED"
      : input.refillInFlight
        ? "REFILL_IN_PROGRESS"
        : "READY_TO_CONTINUE",
    recoveryCommand: input.visibleCount >= input.targetCount
      ? null
      : "CONTINUE_SAME_CRITERIA",
    providerAvailability: "available",
  };
}
