export const providerBudgetAutomaticOverageMultiplier = 1;
export const commercialSemanticDiscoveryPaidCallReserve = 4;
export const providerOperationBudgetMaximumPaidCalls = 1_000;
export const providerOperationBudgetMaximumCostMicros = 100_000_000;

export function applyProviderBudgetAutomaticOverage(
  approvedLimit: number,
): number {
  if (!Number.isSafeInteger(approvedLimit) || approvedLimit < 1) {
    throw new TypeError("Approved provider budget limit must be positive");
  }
  const automaticLimit =
    approvedLimit * providerBudgetAutomaticOverageMultiplier;
  if (!Number.isSafeInteger(automaticLimit)) {
    throw new TypeError("Automatic provider budget limit is not safe");
  }
  return automaticLimit;
}

export type ProviderOperationBudgetGrant = Readonly<{
  provider: "dataforseo";
  reasonCode:
    | "user_authorized_persistent_discovery"
    | "user_authorized_bounded_real_refill";
  maxPaidCalls: number;
  maxCostMicros: number;
}>;

export type ProviderOperationBudgetAuthorization = Readonly<
  ProviderOperationBudgetGrant & {
    authorizedBy: string;
  }
>;

export type ProviderOperationBudgetWindow = Readonly<{
  maxPaidCalls: number;
  maxCostMicros: number;
  replenished: boolean;
}>;

export function replenishProviderBudgetLimit(
  approvedLimit: number,
  requiredLimit: number,
  maximumLimit: number,
): number {
  if (
    !Number.isSafeInteger(approvedLimit)
    || approvedLimit < 1
    || !Number.isSafeInteger(requiredLimit)
    || requiredLimit < 0
    || !Number.isSafeInteger(maximumLimit)
    || maximumLimit < approvedLimit
  ) {
    throw new TypeError("Provider budget window is invalid");
  }
  return approvedLimit;
}

export function resolveProviderOperationBudgetWindow(
  input: Readonly<{
    authorization: ProviderOperationBudgetAuthorization;
    paidCallCount: number;
    exposureMicros: number;
    requiredPaidCalls: number;
    requiredCostMicros: number;
  }>,
): ProviderOperationBudgetWindow {
  if (
    !Number.isSafeInteger(input.paidCallCount)
    || input.paidCallCount < 0
    || !Number.isSafeInteger(input.exposureMicros)
    || input.exposureMicros < 0
    || !Number.isSafeInteger(input.requiredPaidCalls)
    || input.requiredPaidCalls < 0
    || !Number.isSafeInteger(input.requiredCostMicros)
    || input.requiredCostMicros < 0
  ) {
    throw new TypeError("Provider operation budget usage is invalid");
  }
  return Object.freeze({
    maxPaidCalls: input.authorization.maxPaidCalls,
    maxCostMicros: input.authorization.maxCostMicros,
    replenished: false,
  });
}

const authorizationKeys = new Set([
  "provider",
  "reasonCode",
  "maxPaidCalls",
  "maxCostMicros",
  "authorizedBy",
  "recommendationContextVersionId",
  "visiblePoolGeneration",
]);

function invalidAuthorization(): never {
  throw new Error(
    "BACKLINK_PROVIDER_OPERATION_BUDGET_AUTHORIZATION_INVALID",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuthorization(
  value: unknown,
): ProviderOperationBudgetAuthorization {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !authorizationKeys.has(key))
    || value.provider !== "dataforseo"
    || (
      value.reasonCode !== "user_authorized_persistent_discovery"
      && value.reasonCode !== "user_authorized_bounded_real_refill"
    )
    || !Number.isSafeInteger(value.maxPaidCalls)
    || Number(value.maxPaidCalls) < 1
    || Number(value.maxPaidCalls) > providerOperationBudgetMaximumPaidCalls
    || !Number.isSafeInteger(value.maxCostMicros)
    || Number(value.maxCostMicros) < 1
    || Number(value.maxCostMicros) > providerOperationBudgetMaximumCostMicros
    || typeof value.authorizedBy !== "string"
    || value.authorizedBy.trim().length < 1
    || value.authorizedBy.trim().length > 512
    || (
      value.recommendationContextVersionId !== undefined
      && (
        typeof value.recommendationContextVersionId !== "string"
        || value.recommendationContextVersionId.trim().length < 1
      )
    )
    || (
      value.visiblePoolGeneration !== undefined
      && (
        !Number.isSafeInteger(value.visiblePoolGeneration)
        || Number(value.visiblePoolGeneration) < 1
      )
    )
  ) {
    return invalidAuthorization();
  }
  return Object.freeze({
    provider: value.provider,
    reasonCode: value.reasonCode,
    maxPaidCalls: Number(value.maxPaidCalls),
    maxCostMicros: Number(value.maxCostMicros),
    authorizedBy: value.authorizedBy.trim(),
  });
}

export function bindProviderOperationBudgetAuthorization(
  grant: ProviderOperationBudgetGrant,
  binding: Readonly<{
    authorizedBy: string;
  }>,
): ProviderOperationBudgetAuthorization {
  return parseAuthorization({ ...grant, ...binding });
}

export function parseProviderOperationBudgetAuthorization(
  value: unknown,
): ProviderOperationBudgetAuthorization {
  return parseAuthorization(value);
}
