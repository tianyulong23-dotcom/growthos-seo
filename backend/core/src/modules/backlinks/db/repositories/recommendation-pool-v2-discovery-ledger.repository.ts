import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";

export type RecommendationDiscoveryGenerationLineage = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
  discoveryBudgetPolicyVersion: string;
}>;

export type RecommendationDiscoveryRequestIntentInput =
  RecommendationDiscoveryGenerationLineage &
    Readonly<{
      id: string;
      seedId: string;
      seedFingerprint: string;
      seedKind: "KEYWORD" | "CATEGORY" | "SEO_COMPETITOR";
      seedSource:
        | "USER_INPUT"
        | "USER_TRIGGERED_GENERATION"
        | "SYSTEM_FALLBACK"
        | "SYSTEM_SUPPLEMENT";
      roundNumber: 1 | 2;
      discoveryWindowOrdinal: number;
      discoverySource: string;
      requestType: string;
      pageType: string;
      pageOrdinal: number;
      canonicalRequestFingerprint: string;
      canonicalPathFingerprint: string;
      countryCode: string;
      languageCode: string;
      businessDirectionFingerprint: string;
      authorizedCostMicros: number;
      idempotencyKey: string;
      idempotencyHash: string;
      startedAt: string;
      createdBy: string;
    }>;

export type RecommendationDiscoveryRequestOutcomeInput =
  RecommendationDiscoveryGenerationLineage &
    Readonly<{
      id: string;
      requestIntentId: string;
      acquisitionMode?: "LIVE_PROVIDER" | "EVIDENCE_REPLAY";
      sourceRequestOutcomeId?: string | null;
      providerRequestId: string | null;
      providerBatchRequestId: string | null;
      providerUsageLedgerId: string | null;
      providerTaskId: string | null;
      rawCandidateCount: number;
      effectiveCandidateCount: number;
      newUniqueCount: number;
      duplicateCount: number;
      actualCostMicros: number | null;
      cumulativeCostMicros: number | null;
      status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "UNKNOWN_CHARGE";
      chargeState: "SETTLED" | "RELEASED" | "UNKNOWN_CHARGE";
      failureCode: string | null;
      finishedAt: string;
      createdBy: string;
    }>;

export type RecommendationDiscoveryWindowFactInput =
  RecommendationDiscoveryGenerationLineage &
    Readonly<{
      id: string;
      roundNumber: 1 | 2;
      windowOrdinal: number;
      completedRequestCount: number;
      rawCandidateCount: number;
      effectiveCandidateCount: number;
      newUniqueCount: number;
      duplicateCount: number;
      newUniqueRateNumerator: number;
      newUniqueRateDenominator: number;
      windowAuthorizedCostMicros: number;
      windowSettledCostMicros: number | null;
      chargeState: "SETTLED" | "UNKNOWN_CHARGE";
      canonicalRequestSetFingerprint: string;
      completedAt: string;
      createdBy: string;
    }>;

export type RecommendationDiscoveryRoundFactInput =
  RecommendationDiscoveryGenerationLineage &
    Readonly<{
      id: string;
      roundNumber: 1 | 2;
      completedWindowCount: number;
      completedRequestCount: number;
      rawCandidateCount: number;
      effectiveCandidateCount: number;
      newUniqueCount: number;
      duplicateCount: number;
      newUniqueRateNumerator: number;
      newUniqueRateDenominator: number;
      roundAuthorizedCostMicros: number;
      roundSettledCostMicros: number | null;
      cumulativeSettledCostMicros: number | null;
      chargeState: "SETTLED" | "UNKNOWN_CHARGE";
      pathsExhausted: boolean;
      changedDimensions: readonly (
        "KEYWORD" | "COMPETITOR" | "SOURCE" | "PAGE" | "STRATEGY"
      )[];
      canonicalRequestSetFingerprint: string;
      policyDecision: "START_ROUND_2" | "STOP";
      terminalReason: RecommendationDiscoveryTerminalReason | null;
      completedAt: string;
      createdBy: string;
    }>;

export type RecommendationDiscoveryTerminalReason =
  | "CANDIDATE_LIMIT_REACHED"
  | "SAFE_SUPPLY_REACHED"
  | "LOW_YIELD"
  | "BUDGET_EXHAUSTED"
  | "PATHS_EXHAUSTED"
  | "CONTEXT_SUPERSEDED"
  | "UNKNOWN_CHARGE"
  | "REQUEST_SCOPE_CHANGED";

export type RecommendationDiscoveryTerminalFactInput =
  RecommendationDiscoveryGenerationLineage &
    Readonly<{
      id: string;
      effectiveUniqueCandidateCount: number;
      terminalReason: RecommendationDiscoveryTerminalReason;
      totalSettledCostMicros: number | null;
      chargeState: "SETTLED" | "UNKNOWN_CHARGE";
      completedRoundCount: 1 | 2;
      completedWindowCount: number;
      canonicalRequestSetFingerprint: string;
      completedAt: string;
      createdBy: string;
    }>;

type PersistedFact<T> = Readonly<
  T & {
    poolContractVersion: "recommendation-pool.v2";
    createdAt: string;
  }
>;

export type RecommendationDiscoveryRequestIntent =
  PersistedFact<RecommendationDiscoveryRequestIntentInput>;
export type RecommendationDiscoveryRequestOutcome =
  PersistedFact<RecommendationDiscoveryRequestOutcomeInput>;
export type RecommendationDiscoveryWindowFact =
  PersistedFact<RecommendationDiscoveryWindowFactInput>;
export type RecommendationDiscoveryRoundFact =
  PersistedFact<RecommendationDiscoveryRoundFactInput>;
export type RecommendationDiscoveryTerminalFact =
  PersistedFact<RecommendationDiscoveryTerminalFactInput>;

export type RecommendationDiscoveryPersistedState = Readonly<{
  lineage: RecommendationDiscoveryGenerationLineage;
  requestIntents: readonly RecommendationDiscoveryRequestIntent[];
  requestOutcomes: readonly RecommendationDiscoveryRequestOutcome[];
  windowFacts: readonly RecommendationDiscoveryWindowFact[];
  roundFacts: readonly RecommendationDiscoveryRoundFact[];
  terminalFact: RecommendationDiscoveryTerminalFact | null;
}>;

export type RecommendationDiscoveryAtomicFinalizationProposal<TResult> =
  Readonly<{
    result: TResult;
    roundFact: RecommendationDiscoveryRoundFactInput;
    terminalFact: RecommendationDiscoveryTerminalFactInput | null;
  }>;

export type RecommendationDiscoveryAtomicFinalizationResult<TResult> =
  Readonly<{
    result: TResult;
    roundFact: RecommendationDiscoveryRoundFact;
    terminalFact: RecommendationDiscoveryTerminalFact | null;
  }>;

export type RecommendationPoolV2DiscoveryLedgerRepository = Readonly<{
  recordRequestIntent(
    input: RecommendationDiscoveryRequestIntentInput,
  ): Promise<RecommendationDiscoveryRequestIntent>;
  recordRequestOutcome(
    input: RecommendationDiscoveryRequestOutcomeInput,
  ): Promise<RecommendationDiscoveryRequestOutcome>;
  recordWindowFact(
    input: RecommendationDiscoveryWindowFactInput,
  ): Promise<RecommendationDiscoveryWindowFact>;
  recordRoundFact(
    input: RecommendationDiscoveryRoundFactInput,
  ): Promise<RecommendationDiscoveryRoundFact>;
  recordTerminalFact(
    input: RecommendationDiscoveryTerminalFactInput,
  ): Promise<RecommendationDiscoveryTerminalFact>;
  finalizeGeneration<TResult>(
    lineage: RecommendationDiscoveryGenerationLineage,
    decide: (
      state: RecommendationDiscoveryPersistedState,
    ) => RecommendationDiscoveryAtomicFinalizationProposal<TResult>,
  ): Promise<RecommendationDiscoveryAtomicFinalizationResult<TResult>>;
}>;

type Row = Record<string, unknown>;

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw conflict(`Discovery ledger row is missing ${key}.`);
  }
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return requiredString(row, key);
}

function requiredNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) {
    throw conflict(`Discovery ledger row has invalid ${key}.`);
  }
  return value;
}

function nullableNumber(row: Row, key: string): number | null {
  if (row[key] === null) return null;
  return requiredNumber(row, key);
}

function requiredBoolean(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw conflict(`Discovery ledger row has invalid ${key}.`);
  }
  return value;
}

function requiredDate(row: Row, key: string): string {
  const value = row[key];
  const date =
    value instanceof Date ? value : new Date(requiredString(row, key));
  if (Number.isNaN(date.getTime())) {
    throw conflict(`Discovery ledger row has invalid ${key}.`);
  }
  return date.toISOString();
}

function requiredStrings(row: Row, key: string): readonly string[] {
  const value = row[key];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw conflict(`Discovery ledger row has invalid ${key}.`);
  }
  return Object.freeze([...value]);
}

function generationLineage(
  row: Row,
  discoveryBudgetPolicyVersion?: string,
): RecommendationDiscoveryGenerationLineage {
  return {
    organizationId: requiredString(row, "organization_id"),
    workspaceId: requiredString(row, "workspace_id"),
    websiteProjectId: requiredString(row, "website_project_id"),
    generationContractId: requiredString(row, "generation_contract_id"),
    recommendationContextVersionId: requiredString(
      row,
      "recommendation_context_version_id",
    ),
    visiblePoolGeneration: requiredNumber(row, "visible_pool_generation"),
    inputPinId: requiredString(row, "input_pin_id"),
    discoveryBudgetPolicyVersion:
      discoveryBudgetPolicyVersion ??
      requiredString(row, "discovery_budget_policy_version"),
  };
}

function mapRequestIntent(row: Row): RecommendationDiscoveryRequestIntent {
  return Object.freeze({
    ...generationLineage(row),
    id: requiredString(row, "id"),
    poolContractVersion: "recommendation-pool.v2",
    seedId: requiredString(row, "seed_id"),
    seedFingerprint: requiredString(row, "seed_fingerprint"),
    seedKind: requiredString(
      row,
      "seed_kind",
    ) as RecommendationDiscoveryRequestIntentInput["seedKind"],
    seedSource: requiredString(
      row,
      "seed_source",
    ) as RecommendationDiscoveryRequestIntentInput["seedSource"],
    roundNumber: requiredNumber(row, "round_number") as 1 | 2,
    discoveryWindowOrdinal: requiredNumber(row, "discovery_window_ordinal"),
    discoverySource: requiredString(row, "discovery_source"),
    requestType: requiredString(row, "request_type"),
    pageType: requiredString(row, "page_type"),
    pageOrdinal: requiredNumber(row, "page_ordinal"),
    canonicalRequestFingerprint: requiredString(
      row,
      "canonical_request_fingerprint",
    ),
    canonicalPathFingerprint: requiredString(row, "canonical_path_fingerprint"),
    countryCode: requiredString(row, "country_code"),
    languageCode: requiredString(row, "language_code"),
    businessDirectionFingerprint: requiredString(
      row,
      "business_direction_fingerprint",
    ),
    authorizedCostMicros: requiredNumber(row, "authorized_cost_micros"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    idempotencyHash: requiredString(row, "idempotency_hash"),
    startedAt: requiredDate(row, "started_at"),
    createdAt: requiredDate(row, "created_at"),
    createdBy: requiredString(row, "created_by"),
  });
}

function mapRequestOutcome(
  row: Row,
  lineage: RecommendationDiscoveryGenerationLineage,
): RecommendationDiscoveryRequestOutcome {
  return Object.freeze({
    ...generationLineage(row, lineage.discoveryBudgetPolicyVersion),
    id: requiredString(row, "id"),
    poolContractVersion: "recommendation-pool.v2",
    requestIntentId: requiredString(row, "request_intent_id"),
    acquisitionMode: requiredString(
      row,
      "acquisition_mode",
    ) as NonNullable<
      RecommendationDiscoveryRequestOutcomeInput["acquisitionMode"]
    >,
    sourceRequestOutcomeId: nullableString(
      row,
      "source_request_outcome_id",
    ),
    providerRequestId: nullableString(row, "provider_request_id"),
    providerBatchRequestId: nullableString(row, "provider_batch_request_id"),
    providerUsageLedgerId: nullableString(row, "provider_usage_ledger_id"),
    providerTaskId: nullableString(row, "provider_task_id"),
    rawCandidateCount: requiredNumber(row, "raw_candidate_count"),
    effectiveCandidateCount: requiredNumber(row, "effective_candidate_count"),
    newUniqueCount: requiredNumber(row, "new_unique_count"),
    duplicateCount: requiredNumber(row, "duplicate_count"),
    actualCostMicros: nullableNumber(row, "actual_cost_micros"),
    cumulativeCostMicros: nullableNumber(row, "cumulative_cost_micros"),
    status: requiredString(
      row,
      "status",
    ) as RecommendationDiscoveryRequestOutcomeInput["status"],
    chargeState: requiredString(
      row,
      "charge_state",
    ) as RecommendationDiscoveryRequestOutcomeInput["chargeState"],
    failureCode: nullableString(row, "failure_code"),
    finishedAt: requiredDate(row, "finished_at"),
    createdAt: requiredDate(row, "created_at"),
    createdBy: requiredString(row, "created_by"),
  });
}

function mapWindowFact(row: Row): RecommendationDiscoveryWindowFact {
  return Object.freeze({
    ...generationLineage(row),
    id: requiredString(row, "id"),
    poolContractVersion: "recommendation-pool.v2",
    roundNumber: requiredNumber(row, "round_number") as 1 | 2,
    windowOrdinal: requiredNumber(row, "window_ordinal"),
    completedRequestCount: requiredNumber(row, "completed_request_count"),
    rawCandidateCount: requiredNumber(row, "raw_candidate_count"),
    effectiveCandidateCount: requiredNumber(row, "effective_candidate_count"),
    newUniqueCount: requiredNumber(row, "new_unique_count"),
    duplicateCount: requiredNumber(row, "duplicate_count"),
    newUniqueRateNumerator: requiredNumber(row, "new_unique_rate_numerator"),
    newUniqueRateDenominator: requiredNumber(
      row,
      "new_unique_rate_denominator",
    ),
    windowAuthorizedCostMicros: requiredNumber(
      row,
      "window_authorized_cost_micros",
    ),
    windowSettledCostMicros: nullableNumber(row, "window_settled_cost_micros"),
    chargeState: requiredString(
      row,
      "charge_state",
    ) as RecommendationDiscoveryWindowFactInput["chargeState"],
    canonicalRequestSetFingerprint: requiredString(
      row,
      "canonical_request_set_fingerprint",
    ),
    completedAt: requiredDate(row, "completed_at"),
    createdAt: requiredDate(row, "created_at"),
    createdBy: requiredString(row, "created_by"),
  });
}

function mapRoundFact(row: Row): RecommendationDiscoveryRoundFact {
  return Object.freeze({
    ...generationLineage(row),
    id: requiredString(row, "id"),
    poolContractVersion: "recommendation-pool.v2",
    roundNumber: requiredNumber(row, "round_number") as 1 | 2,
    completedWindowCount: requiredNumber(row, "completed_window_count"),
    completedRequestCount: requiredNumber(row, "completed_request_count"),
    rawCandidateCount: requiredNumber(row, "raw_candidate_count"),
    effectiveCandidateCount: requiredNumber(row, "effective_candidate_count"),
    newUniqueCount: requiredNumber(row, "new_unique_count"),
    duplicateCount: requiredNumber(row, "duplicate_count"),
    newUniqueRateNumerator: requiredNumber(row, "new_unique_rate_numerator"),
    newUniqueRateDenominator: requiredNumber(
      row,
      "new_unique_rate_denominator",
    ),
    roundAuthorizedCostMicros: requiredNumber(
      row,
      "round_authorized_cost_micros",
    ),
    roundSettledCostMicros: nullableNumber(row, "round_settled_cost_micros"),
    cumulativeSettledCostMicros: nullableNumber(
      row,
      "cumulative_settled_cost_micros",
    ),
    chargeState: requiredString(
      row,
      "charge_state",
    ) as RecommendationDiscoveryRoundFactInput["chargeState"],
    pathsExhausted: requiredBoolean(row, "paths_exhausted"),
    changedDimensions: requiredStrings(
      row,
      "changed_dimensions",
    ) as RecommendationDiscoveryRoundFact["changedDimensions"],
    canonicalRequestSetFingerprint: requiredString(
      row,
      "canonical_request_set_fingerprint",
    ),
    policyDecision: requiredString(
      row,
      "policy_decision",
    ) as RecommendationDiscoveryRoundFactInput["policyDecision"],
    terminalReason: nullableString(
      row,
      "terminal_reason",
    ) as RecommendationDiscoveryTerminalReason | null,
    completedAt: requiredDate(row, "completed_at"),
    createdAt: requiredDate(row, "created_at"),
    createdBy: requiredString(row, "created_by"),
  });
}

function mapTerminalFact(row: Row): RecommendationDiscoveryTerminalFact {
  return Object.freeze({
    ...generationLineage(row),
    id: requiredString(row, "id"),
    poolContractVersion: "recommendation-pool.v2",
    effectiveUniqueCandidateCount: requiredNumber(
      row,
      "effective_unique_candidate_count",
    ),
    terminalReason: requiredString(
      row,
      "terminal_reason",
    ) as RecommendationDiscoveryTerminalReason,
    totalSettledCostMicros: nullableNumber(row, "total_settled_cost_micros"),
    chargeState: requiredString(
      row,
      "charge_state",
    ) as RecommendationDiscoveryTerminalFactInput["chargeState"],
    completedRoundCount: requiredNumber(row, "completed_round_count") as 1 | 2,
    completedWindowCount: requiredNumber(row, "completed_window_count"),
    canonicalRequestSetFingerprint: requiredString(
      row,
      "canonical_request_set_fingerprint",
    ),
    completedAt: requiredDate(row, "completed_at"),
    createdAt: requiredDate(row, "created_at"),
    createdBy: requiredString(row, "created_by"),
  });
}

function dateSignature(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

function intentSignature(
  value:
    | RecommendationDiscoveryRequestIntentInput
    | RecommendationDiscoveryRequestIntent,
): string {
  return JSON.stringify({
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    websiteProjectId: value.websiteProjectId,
    generationContractId: value.generationContractId,
    recommendationContextVersionId: value.recommendationContextVersionId,
    visiblePoolGeneration: value.visiblePoolGeneration,
    inputPinId: value.inputPinId,
    discoveryBudgetPolicyVersion: value.discoveryBudgetPolicyVersion,
    seedId: value.seedId,
    seedFingerprint: value.seedFingerprint,
    seedKind: value.seedKind,
    seedSource: value.seedSource,
    roundNumber: value.roundNumber,
    discoveryWindowOrdinal: value.discoveryWindowOrdinal,
    discoverySource: value.discoverySource,
    requestType: value.requestType,
    pageType: value.pageType,
    pageOrdinal: value.pageOrdinal,
    canonicalRequestFingerprint: value.canonicalRequestFingerprint,
    canonicalPathFingerprint: value.canonicalPathFingerprint,
    countryCode: value.countryCode,
    languageCode: value.languageCode,
    businessDirectionFingerprint: value.businessDirectionFingerprint,
    authorizedCostMicros: value.authorizedCostMicros,
    idempotencyKey: value.idempotencyKey,
    idempotencyHash: value.idempotencyHash,
    startedAt: dateSignature(value.startedAt),
    createdBy: value.createdBy,
  });
}

function outcomeSignature(
  value:
    | RecommendationDiscoveryRequestOutcomeInput
    | RecommendationDiscoveryRequestOutcome,
): string {
  return JSON.stringify({
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    websiteProjectId: value.websiteProjectId,
    generationContractId: value.generationContractId,
    recommendationContextVersionId: value.recommendationContextVersionId,
    visiblePoolGeneration: value.visiblePoolGeneration,
    inputPinId: value.inputPinId,
    discoveryBudgetPolicyVersion: value.discoveryBudgetPolicyVersion,
    requestIntentId: value.requestIntentId,
    acquisitionMode: value.acquisitionMode ?? "LIVE_PROVIDER",
    sourceRequestOutcomeId: value.sourceRequestOutcomeId ?? null,
    providerRequestId: value.providerRequestId,
    providerBatchRequestId: value.providerBatchRequestId,
    providerUsageLedgerId: value.providerUsageLedgerId,
    providerTaskId: value.providerTaskId,
    rawCandidateCount: value.rawCandidateCount,
    effectiveCandidateCount: value.effectiveCandidateCount,
    newUniqueCount: value.newUniqueCount,
    duplicateCount: value.duplicateCount,
    actualCostMicros: value.actualCostMicros,
    cumulativeCostMicros: value.cumulativeCostMicros,
    status: value.status,
    chargeState: value.chargeState,
    failureCode: value.failureCode,
    finishedAt: dateSignature(value.finishedAt),
    createdBy: value.createdBy,
  });
}

function windowSignature(
  value:
    RecommendationDiscoveryWindowFactInput | RecommendationDiscoveryWindowFact,
): string {
  return JSON.stringify({
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    websiteProjectId: value.websiteProjectId,
    generationContractId: value.generationContractId,
    recommendationContextVersionId: value.recommendationContextVersionId,
    visiblePoolGeneration: value.visiblePoolGeneration,
    inputPinId: value.inputPinId,
    discoveryBudgetPolicyVersion: value.discoveryBudgetPolicyVersion,
    roundNumber: value.roundNumber,
    windowOrdinal: value.windowOrdinal,
    completedRequestCount: value.completedRequestCount,
    rawCandidateCount: value.rawCandidateCount,
    effectiveCandidateCount: value.effectiveCandidateCount,
    newUniqueCount: value.newUniqueCount,
    duplicateCount: value.duplicateCount,
    newUniqueRateNumerator: value.newUniqueRateNumerator,
    newUniqueRateDenominator: value.newUniqueRateDenominator,
    windowAuthorizedCostMicros: value.windowAuthorizedCostMicros,
    windowSettledCostMicros: value.windowSettledCostMicros,
    chargeState: value.chargeState,
    canonicalRequestSetFingerprint: value.canonicalRequestSetFingerprint,
    completedAt: dateSignature(value.completedAt),
    createdBy: value.createdBy,
  });
}

function roundSignature(
  value:
    RecommendationDiscoveryRoundFactInput | RecommendationDiscoveryRoundFact,
): string {
  return JSON.stringify({
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    websiteProjectId: value.websiteProjectId,
    generationContractId: value.generationContractId,
    recommendationContextVersionId: value.recommendationContextVersionId,
    visiblePoolGeneration: value.visiblePoolGeneration,
    inputPinId: value.inputPinId,
    discoveryBudgetPolicyVersion: value.discoveryBudgetPolicyVersion,
    roundNumber: value.roundNumber,
    completedWindowCount: value.completedWindowCount,
    completedRequestCount: value.completedRequestCount,
    rawCandidateCount: value.rawCandidateCount,
    effectiveCandidateCount: value.effectiveCandidateCount,
    newUniqueCount: value.newUniqueCount,
    duplicateCount: value.duplicateCount,
    newUniqueRateNumerator: value.newUniqueRateNumerator,
    newUniqueRateDenominator: value.newUniqueRateDenominator,
    roundAuthorizedCostMicros: value.roundAuthorizedCostMicros,
    roundSettledCostMicros: value.roundSettledCostMicros,
    cumulativeSettledCostMicros: value.cumulativeSettledCostMicros,
    chargeState: value.chargeState,
    pathsExhausted: value.pathsExhausted,
    changedDimensions: [...value.changedDimensions],
    canonicalRequestSetFingerprint: value.canonicalRequestSetFingerprint,
    policyDecision: value.policyDecision,
    terminalReason: value.terminalReason,
    completedAt: dateSignature(value.completedAt),
    createdBy: value.createdBy,
  });
}

function terminalSignature(
  value:
    | RecommendationDiscoveryTerminalFactInput
    | RecommendationDiscoveryTerminalFact,
): string {
  return JSON.stringify({
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    websiteProjectId: value.websiteProjectId,
    generationContractId: value.generationContractId,
    recommendationContextVersionId: value.recommendationContextVersionId,
    visiblePoolGeneration: value.visiblePoolGeneration,
    inputPinId: value.inputPinId,
    discoveryBudgetPolicyVersion: value.discoveryBudgetPolicyVersion,
    effectiveUniqueCandidateCount: value.effectiveUniqueCandidateCount,
    terminalReason: value.terminalReason,
    totalSettledCostMicros: value.totalSettledCostMicros,
    chargeState: value.chargeState,
    completedRoundCount: value.completedRoundCount,
    completedWindowCount: value.completedWindowCount,
    canonicalRequestSetFingerprint: value.canonicalRequestSetFingerprint,
    completedAt: dateSignature(value.completedAt),
    createdBy: value.createdBy,
  });
}

async function lockGeneration(
  client: BacklinkTransactionClient,
  lineage: RecommendationDiscoveryGenerationLineage,
): Promise<void> {
  const result = await client.query(
    `SELECT id
       FROM backlinks.backlink_recommendation_generation_contracts
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4
        AND recommendation_context_version_id=$5
        AND visible_pool_generation=$6 AND input_pin_id=$7
        AND pool_contract_version='recommendation-pool.v2'
        AND discovery_budget_policy_version=$8
      FOR UPDATE`,
    [
      lineage.organizationId,
      lineage.workspaceId,
      lineage.websiteProjectId,
      lineage.generationContractId,
      lineage.recommendationContextVersionId,
      lineage.visiblePoolGeneration,
      lineage.inputPinId,
      lineage.discoveryBudgetPolicyVersion,
    ],
  );
  if (result.rows[0] === undefined) {
    throw conflict(
      "Recommendation discovery generation lineage was not found in scope.",
    );
  }
}

async function readPersistedState(
  client: BacklinkTransactionClient,
  lineage: RecommendationDiscoveryGenerationLineage,
): Promise<RecommendationDiscoveryPersistedState> {
  const values = [
    lineage.organizationId,
    lineage.workspaceId,
    lineage.websiteProjectId,
    lineage.generationContractId,
  ] as const;
  const requestIntents = await client.query(
    `SELECT *
       FROM backlinks.backlink_recommendation_discovery_request_intents
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND generation_contract_id=$4
      ORDER BY round_number, discovery_window_ordinal, page_ordinal,
               started_at, id`,
    values,
  );
  const requestOutcomes = await client.query(
    `SELECT *
       FROM backlinks.backlink_recommendation_discovery_request_outcomes
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND generation_contract_id=$4
      ORDER BY finished_at, id`,
    values,
  );
  const windowFacts = await client.query(
    `SELECT *
       FROM backlinks.backlink_recommendation_discovery_window_facts
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND generation_contract_id=$4
      ORDER BY window_ordinal, id`,
    values,
  );
  const roundFacts = await client.query(
    `SELECT *
       FROM backlinks.backlink_recommendation_discovery_round_facts
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND generation_contract_id=$4
      ORDER BY round_number, id`,
    values,
  );
  const terminalFacts = await client.query(
    `SELECT *
       FROM
         backlinks.backlink_recommendation_discovery_generation_terminal_facts
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND generation_contract_id=$4`,
    values,
  );

  return Object.freeze({
    lineage: Object.freeze({ ...lineage }),
    requestIntents: Object.freeze(requestIntents.rows.map(mapRequestIntent)),
    requestOutcomes: Object.freeze(
      requestOutcomes.rows.map((row) => mapRequestOutcome(row, lineage)),
    ),
    windowFacts: Object.freeze(windowFacts.rows.map(mapWindowFact)),
    roundFacts: Object.freeze(roundFacts.rows.map(mapRoundFact)),
    terminalFact:
      terminalFacts.rows[0] === undefined
        ? null
        : mapTerminalFact(terminalFacts.rows[0]),
  });
}

function assertMatchingLineage(
  expected: RecommendationDiscoveryGenerationLineage,
  actual: RecommendationDiscoveryGenerationLineage,
  label: string,
): void {
  if (
    expected.organizationId !== actual.organizationId ||
    expected.workspaceId !== actual.workspaceId ||
    expected.websiteProjectId !== actual.websiteProjectId ||
    expected.generationContractId !== actual.generationContractId ||
    expected.recommendationContextVersionId !==
      actual.recommendationContextVersionId ||
    expected.visiblePoolGeneration !== actual.visiblePoolGeneration ||
    expected.inputPinId !== actual.inputPinId ||
    expected.discoveryBudgetPolicyVersion !==
      actual.discoveryBudgetPolicyVersion
  ) {
    throw conflict(`${label} differs from its locked generation lineage.`);
  }
}

type ReplayOptions<
  Input extends Readonly<{ id: string }>,
  Output extends Readonly<{ id: string }>,
> = Readonly<{
  label: string;
  findSql: string;
  findValues(input: Input): readonly unknown[];
  insertSql: string;
  insertValues(input: Input): readonly unknown[];
  map(row: Row, input: Input): Output;
  signature(value: Input | Output): string;
}>;

async function insertOrReplayLocked<
  Input extends RecommendationDiscoveryGenerationLineage &
    Readonly<{ id: string }>,
  Output extends Readonly<{ id: string }>,
>(
  client: BacklinkTransactionClient,
  input: Input,
  options: ReplayOptions<Input, Output>,
  requireMatchingId = false,
): Promise<Output> {
  const existing = await client.query(
    options.findSql,
    options.findValues(input),
  );
  if (existing.rows[0] !== undefined) {
    const fact = options.map(existing.rows[0], input);
    if (
      (requireMatchingId && fact.id !== input.id) ||
      options.signature(fact) !== options.signature(input)
    ) {
      throw conflict(
        `${options.label} replay conflicts with the persisted fact.`,
      );
    }
    return fact;
  }

  const inserted = await client.query(
    options.insertSql,
    options.insertValues(input),
  );
  if (inserted.rows[0] !== undefined) {
    return options.map(inserted.rows[0], input);
  }

  const raced = await client.query(options.findSql, options.findValues(input));
  if (raced.rows[0] !== undefined) {
    const fact = options.map(raced.rows[0], input);
    if (
      (!requireMatchingId || fact.id === input.id) &&
      options.signature(fact) === options.signature(input)
    ) {
      return fact;
    }
  }
  throw conflict(
    `${options.label} conflicts with an immutable discovery ledger fact.`,
  );
}

async function insertOrReplay<
  Input extends RecommendationDiscoveryGenerationLineage &
    Readonly<{ id: string }>,
  Output extends Readonly<{ id: string }>,
>(
  pool: BacklinkTenantPool,
  input: Input,
  options: ReplayOptions<Input, Output>,
): Promise<Output> {
  return withBacklinkTenantTransaction(pool, input, async (client) => {
    await lockGeneration(client, input);
    return insertOrReplayLocked(client, input, options);
  });
}

const requestIntentReplay: ReplayOptions<
  RecommendationDiscoveryRequestIntentInput,
  RecommendationDiscoveryRequestIntent
> = {
  label: "Discovery request intent",
  findSql: `SELECT *
              FROM backlinks.backlink_recommendation_discovery_request_intents
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3 AND generation_contract_id=$4
               AND idempotency_key=$5`,
  findValues: (input) => [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.idempotencyKey,
  ],
  insertSql: `INSERT INTO
    backlinks.backlink_recommendation_discovery_request_intents (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, pool_contract_version,
      seed_id, seed_fingerprint, seed_kind, seed_source,
      discovery_budget_policy_version, round_number,
      discovery_window_ordinal, discovery_source, request_type, page_type,
      page_ordinal, canonical_request_fingerprint,
      canonical_path_fingerprint, country_code, language_code,
      business_direction_fingerprint, authorized_cost_micros,
      idempotency_key, idempotency_hash, started_at, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
    )
    ON CONFLICT DO NOTHING
    RETURNING *`,
  insertValues: (input) => [
    input.id,
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.visiblePoolGeneration,
    input.inputPinId,
    input.seedId,
    input.seedFingerprint,
    input.seedKind,
    input.seedSource,
    input.discoveryBudgetPolicyVersion,
    input.roundNumber,
    input.discoveryWindowOrdinal,
    input.discoverySource,
    input.requestType,
    input.pageType,
    input.pageOrdinal,
    input.canonicalRequestFingerprint,
    input.canonicalPathFingerprint,
    input.countryCode,
    input.languageCode,
    input.businessDirectionFingerprint,
    input.authorizedCostMicros,
    input.idempotencyKey,
    input.idempotencyHash,
    input.startedAt,
    input.createdBy,
  ],
  map: mapRequestIntent,
  signature: intentSignature,
};

const requestOutcomeReplay: ReplayOptions<
  RecommendationDiscoveryRequestOutcomeInput,
  RecommendationDiscoveryRequestOutcome
> = {
  label: "Discovery request outcome",
  findSql: `SELECT *
              FROM backlinks.backlink_recommendation_discovery_request_outcomes
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3 AND request_intent_id=$4`,
  findValues: (input) => [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.requestIntentId,
  ],
  insertSql: `INSERT INTO
    backlinks.backlink_recommendation_discovery_request_outcomes (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, pool_contract_version,
      request_intent_id, acquisition_mode, source_request_outcome_id,
      provider_request_id, provider_batch_request_id, provider_usage_ledger_id,
      provider_task_id, raw_candidate_count, effective_candidate_count,
      new_unique_count, duplicate_count, actual_cost_micros,
      cumulative_cost_micros, status, charge_state, failure_code,
      finished_at, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
    )
    ON CONFLICT DO NOTHING
    RETURNING *`,
  insertValues: (input) => [
    input.id,
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.visiblePoolGeneration,
    input.inputPinId,
    input.requestIntentId,
    input.acquisitionMode ?? "LIVE_PROVIDER",
    input.sourceRequestOutcomeId ?? null,
    input.providerRequestId,
    input.providerBatchRequestId,
    input.providerUsageLedgerId,
    input.providerTaskId,
    input.rawCandidateCount,
    input.effectiveCandidateCount,
    input.newUniqueCount,
    input.duplicateCount,
    input.actualCostMicros,
    input.cumulativeCostMicros,
    input.status,
    input.chargeState,
    input.failureCode,
    input.finishedAt,
    input.createdBy,
  ],
  map: mapRequestOutcome,
  signature: outcomeSignature,
};

const windowFactReplay: ReplayOptions<
  RecommendationDiscoveryWindowFactInput,
  RecommendationDiscoveryWindowFact
> = {
  label: "Discovery window fact",
  findSql: `SELECT *
              FROM backlinks.backlink_recommendation_discovery_window_facts
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3 AND generation_contract_id=$4
               AND window_ordinal=$5`,
  findValues: (input) => [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.windowOrdinal,
  ],
  insertSql: `INSERT INTO
    backlinks.backlink_recommendation_discovery_window_facts (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, pool_contract_version,
      discovery_budget_policy_version, round_number, window_ordinal,
      completed_request_count, raw_candidate_count,
      effective_candidate_count, new_unique_count, duplicate_count,
      new_unique_rate_numerator, new_unique_rate_denominator,
      window_authorized_cost_micros, window_settled_cost_micros,
      charge_state, canonical_request_set_fingerprint, completed_at, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
    )
    ON CONFLICT DO NOTHING
    RETURNING *`,
  insertValues: (input) => [
    input.id,
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.visiblePoolGeneration,
    input.inputPinId,
    input.discoveryBudgetPolicyVersion,
    input.roundNumber,
    input.windowOrdinal,
    input.completedRequestCount,
    input.rawCandidateCount,
    input.effectiveCandidateCount,
    input.newUniqueCount,
    input.duplicateCount,
    input.newUniqueRateNumerator,
    input.newUniqueRateDenominator,
    input.windowAuthorizedCostMicros,
    input.windowSettledCostMicros,
    input.chargeState,
    input.canonicalRequestSetFingerprint,
    input.completedAt,
    input.createdBy,
  ],
  map: mapWindowFact,
  signature: windowSignature,
};

const roundFactReplay: ReplayOptions<
  RecommendationDiscoveryRoundFactInput,
  RecommendationDiscoveryRoundFact
> = {
  label: "Discovery round fact",
  findSql: `SELECT *
              FROM backlinks.backlink_recommendation_discovery_round_facts
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3 AND generation_contract_id=$4
               AND round_number=$5`,
  findValues: (input) => [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.roundNumber,
  ],
  insertSql: `INSERT INTO
    backlinks.backlink_recommendation_discovery_round_facts (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, pool_contract_version,
      discovery_budget_policy_version, round_number, completed_window_count,
      completed_request_count, raw_candidate_count, effective_candidate_count,
      new_unique_count, duplicate_count, new_unique_rate_numerator,
      new_unique_rate_denominator, round_authorized_cost_micros,
      round_settled_cost_micros, cumulative_settled_cost_micros, charge_state,
      paths_exhausted, changed_dimensions, canonical_request_set_fingerprint,
      policy_decision, terminal_reason, completed_at, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
    )
    ON CONFLICT DO NOTHING
    RETURNING *`,
  insertValues: (input) => [
    input.id,
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.visiblePoolGeneration,
    input.inputPinId,
    input.discoveryBudgetPolicyVersion,
    input.roundNumber,
    input.completedWindowCount,
    input.completedRequestCount,
    input.rawCandidateCount,
    input.effectiveCandidateCount,
    input.newUniqueCount,
    input.duplicateCount,
    input.newUniqueRateNumerator,
    input.newUniqueRateDenominator,
    input.roundAuthorizedCostMicros,
    input.roundSettledCostMicros,
    input.cumulativeSettledCostMicros,
    input.chargeState,
    input.pathsExhausted,
    input.changedDimensions,
    input.canonicalRequestSetFingerprint,
    input.policyDecision,
    input.terminalReason,
    input.completedAt,
    input.createdBy,
  ],
  map: mapRoundFact,
  signature: roundSignature,
};

const terminalFactReplay: ReplayOptions<
  RecommendationDiscoveryTerminalFactInput,
  RecommendationDiscoveryTerminalFact
> = {
  label: "Discovery generation terminal fact",
  findSql: `SELECT *
              FROM
                backlinks.backlink_recommendation_discovery_generation_terminal_facts
             WHERE organization_id=$1 AND workspace_id=$2
               AND website_project_id=$3 AND generation_contract_id=$4`,
  findValues: (input) => [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
  ],
  insertSql: `INSERT INTO
    backlinks.backlink_recommendation_discovery_generation_terminal_facts (
      id, organization_id, workspace_id, website_project_id,
      generation_contract_id, recommendation_context_version_id,
      visible_pool_generation, input_pin_id, pool_contract_version,
      discovery_budget_policy_version, effective_unique_candidate_count,
      terminal_reason, total_settled_cost_micros, charge_state,
      completed_round_count, completed_window_count,
      canonical_request_set_fingerprint, completed_at, created_by
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18
    )
    ON CONFLICT DO NOTHING
    RETURNING *`,
  insertValues: (input) => [
    input.id,
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.visiblePoolGeneration,
    input.inputPinId,
    input.discoveryBudgetPolicyVersion,
    input.effectiveUniqueCandidateCount,
    input.terminalReason,
    input.totalSettledCostMicros,
    input.chargeState,
    input.completedRoundCount,
    input.completedWindowCount,
    input.canonicalRequestSetFingerprint,
    input.completedAt,
    input.createdBy,
  ],
  map: mapTerminalFact,
  signature: terminalSignature,
};

async function finalizeGeneration<TResult>(
  pool: BacklinkTenantPool,
  lineage: RecommendationDiscoveryGenerationLineage,
  decide: (
    state: RecommendationDiscoveryPersistedState,
  ) => RecommendationDiscoveryAtomicFinalizationProposal<TResult>,
): Promise<RecommendationDiscoveryAtomicFinalizationResult<TResult>> {
  return withBacklinkTenantTransaction(pool, lineage, async (client) => {
    await lockGeneration(client, lineage);
    const state = await readPersistedState(client, lineage);
    const proposal = decide(state);
    assertMatchingLineage(lineage, proposal.roundFact, "Discovery round fact");
    if (proposal.terminalFact !== null) {
      assertMatchingLineage(
        lineage,
        proposal.terminalFact,
        "Discovery terminal fact",
      );
    }

    const roundFact = await insertOrReplayLocked(
      client,
      proposal.roundFact,
      roundFactReplay,
      true,
    );
    const terminalFact =
      proposal.terminalFact === null
        ? null
        : await insertOrReplayLocked(
            client,
            proposal.terminalFact,
            terminalFactReplay,
            true,
          );

    return Object.freeze({
      result: proposal.result,
      roundFact,
      terminalFact,
    });
  });
}

export function createRecommendationPoolV2DiscoveryLedgerRepository(
  pool: BacklinkTenantPool,
): RecommendationPoolV2DiscoveryLedgerRepository {
  return Object.freeze({
    recordRequestIntent: (input) =>
      insertOrReplay(pool, input, requestIntentReplay),
    recordRequestOutcome: (input) =>
      insertOrReplay(pool, input, requestOutcomeReplay),
    recordWindowFact: (input) => insertOrReplay(pool, input, windowFactReplay),
    recordRoundFact: (input) => insertOrReplay(pool, input, roundFactReplay),
    recordTerminalFact: (input) =>
      insertOrReplay(pool, input, terminalFactReplay),
    finalizeGeneration: (lineage, decide) =>
      finalizeGeneration(pool, lineage, decide),
  });
}
