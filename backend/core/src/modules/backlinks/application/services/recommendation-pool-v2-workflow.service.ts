import {
  hasConsecutiveRecommendationLowYield,
  recommendationDiscoveryHardCandidateLimit,
  recommendationDiscoveryRoundBudgetMicros,
  recommendationDiscoverySupplyThreshold,
  recommendationDiscoveryTotalBudgetMicros,
  type RecommendationDiscoveryStopReason,
  type RecommendationDiscoveryWindow,
} from "../../domain/recommendations/recommendation-pool-v2-policy.js";

export type RecommendationPoolV2Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type RecommendationPoolV2WorkflowInput = RecommendationPoolV2Scope &
  Readonly<{
    generationContractId: string;
    recommendationContextVersionId: string;
    visiblePoolGeneration: number;
    inputPinId: string;
    jobId: string;
    workflowId: string;
    actorId: string;
    rounds: readonly RecommendationPoolV2DiscoveryRound[];
  }>;

export type RecommendationPoolV2DiscoveryRound = Readonly<{
  round: 1 | 2;
  requestFingerprint: string;
  idempotencyKey: string;
  maxCostMicros: number;
}>;

export type RecommendationPoolV2DiscoveryRoundResult = Readonly<{
  round: 1 | 2;
  requestFingerprint: string;
  chargeState: "settled" | "unknown_charge";
  costMicros: number | null;
  totalUniqueCandidateCount: number;
  pathsExhausted: boolean;
  completedWindows: readonly RecommendationDiscoveryWindow[];
}>;

export type RecommendationPoolV2CanonicalBatch = Readonly<{
  batchId: string;
  ordinal: number;
  originalBatchSize: number;
}>;

export type RecommendationPoolV2GenerationFinalization = Readonly<{
  effectiveUniqueCandidateCount: number;
  discoveryTerminalReason: RecommendationDiscoveryStopReason;
  totalSettledCostMicros: number;
  discoveryCompletedAt: string;
  preparationStartedAt: string;
  preparationDeadlineAt: string;
  batches: readonly RecommendationPoolV2CanonicalBatch[];
}>;

export type RecommendationPoolV2PublicationOutcome =
  | "READY"
  | "PARTIAL_EXHAUSTED";

export type RecommendationPoolV2ProductTerminalReason =
  | RecommendationDiscoveryStopReason
  | "NO_VALID_CANDIDATES_AFTER_EXHAUSTION";

export type RecommendationPoolV2PreparationInspection = Readonly<{
  databaseNow: string;
  state: "PREPARING" | "AVAILABLE" | "SUPERSEDED";
  terminalBatchCount: number;
  totalBatchCount: number;
}>;

export type RecommendationPoolV2Supersession = Readonly<{
  contractVersion: 2;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  generationContractId: string;
  oldRecommendationContextVersionId: string;
  authoritativeRecommendationContextVersionId: string;
  reason: "PROJECT_CONTEXT_SUPERSEDED" | "PROJECT_ARCHIVED" | "PROJECT_DELETED";
}>;

export type RecommendationPoolV2GenerationStart =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "already_completed";
      finalization: RecommendationPoolV2GenerationFinalization;
    }>
  | Readonly<{ status: "input_required"; reason: string }>
  | Readonly<{ status: "superseded" }>;

type GenerationActivityInput = Omit<
  RecommendationPoolV2WorkflowInput,
  "rounds"
>;

export type RecommendationPoolV2WorkflowActivities = Readonly<{
  loadGeneration(
    input: RecommendationPoolV2WorkflowInput,
  ): Promise<RecommendationPoolV2GenerationStart>;
  executeDiscoveryRound(
    input: GenerationActivityInput & RecommendationPoolV2DiscoveryRound,
  ): Promise<RecommendationPoolV2DiscoveryRoundResult>;
  finalizeGeneration(
    input: GenerationActivityInput &
      Readonly<{
        terminalReason: RecommendationDiscoveryStopReason;
        totalSettledCostMicros: number;
        hardCandidateLimit: number;
        rounds: readonly RecommendationPoolV2DiscoveryRoundResult[];
      }>,
  ): Promise<RecommendationPoolV2GenerationFinalization>;
  prepareCanonicalBatches(
    input: GenerationActivityInput &
      Readonly<{
        batchIds: readonly string[];
        preparationDeadlineAt: string;
      }>,
  ): Promise<void>;
  inspectCanonicalBatchPreparation(
    input: GenerationActivityInput &
      Readonly<{
        batchIds: readonly string[];
        preparationDeadlineAt: string;
      }>,
  ): Promise<RecommendationPoolV2PreparationInspection>;
  convergeCanonicalBatchPreparation(
    input: GenerationActivityInput &
      Readonly<{
        batchIds: readonly string[];
        preparationDeadlineAt: string;
        terminalReason: "COMPLETED_PARTIAL";
      }>,
  ): Promise<void>;
  activateGeneration(
    input: GenerationActivityInput &
      Readonly<{
        batchIds: readonly string[];
        publicationOutcome?: RecommendationPoolV2PublicationOutcome;
      }>,
  ): Promise<void>;
  completeGenerationWithoutPublication(
    input: GenerationActivityInput &
      Readonly<{
        reason:
          | "RECOMMENDATION_POOL_V2_NO_NATIVE_CANDIDATES"
          | "NO_VALID_CANDIDATES_AFTER_EXHAUSTION";
      }>,
  ): Promise<void>;
  failGeneration(
    input: GenerationActivityInput &
      Readonly<{
        failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED";
        failureMessage: string;
        failureRetryable?: boolean;
      }>,
  ): Promise<void>;
  completeGenerationSupersession(
    input: GenerationActivityInput &
      Readonly<{
        supersession: RecommendationPoolV2Supersession | null;
      }>,
  ): Promise<void>;
}>;

export type RecommendationPoolV2WorkflowHooks = Readonly<{
  terminalSemanticsVersion: 1 | 2;
  readSupersession(): RecommendationPoolV2Supersession | undefined;
  waitForPreparationPoll(input: Readonly<{ delayMs: number }>): Promise<void>;
}>;

export type RecommendationPoolV2WorkflowResult =
  | Readonly<{
      status: "completed";
      discoveryTerminalReason: RecommendationPoolV2ProductTerminalReason;
      effectiveUniqueCandidateCount: number;
      preparedBatchIds: readonly string[];
      totalSettledCostMicros: number;
    }>
  | Readonly<{
      status: "partial_exhausted";
      discoveryTerminalReason: RecommendationDiscoveryStopReason;
      effectiveUniqueCandidateCount: number;
      preparedBatchIds: readonly string[];
      totalSettledCostMicros: number;
    }>
  | Readonly<{
      status: "failed";
      failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED";
      failureMessage: string;
      failureRetryable: boolean;
    }>
  | Readonly<{ status: "input_required"; reason: string }>
  | Readonly<{ status: "superseded" }>;

const contactPreparationPollMs = 15 * 60 * 1_000;
const contactPreparationDeadlineMs = 24 * 60 * 60 * 1_000;
const boundedExhaustionReasons =
  new Set<RecommendationDiscoveryStopReason>([
    "LOW_YIELD",
    "BUDGET_EXHAUSTED",
    "PATHS_EXHAUSTED",
    "REQUEST_SCOPE_CHANGED",
  ]);

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`Recommendation V2 ${label} is required`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Recommendation V2 ${label} is invalid`);
  }
}

function validateWorkflowInput(input: RecommendationPoolV2WorkflowInput): void {
  [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.inputPinId,
    input.jobId,
    input.workflowId,
    input.actorId,
  ].forEach((value, index) => assertNonEmpty(value, `identity ${index + 1}`));
  if (
    !Number.isSafeInteger(input.visiblePoolGeneration) ||
    input.visiblePoolGeneration < 1
  ) {
    throw new TypeError("Recommendation V2 visible pool generation is invalid");
  }
  if (input.rounds.length < 1 || input.rounds.length > 2) {
    throw new TypeError("Recommendation V2 requires one or two rounds");
  }
  const sorted = [...input.rounds].sort(
    (left, right) => left.round - right.round,
  );
  if (sorted[0]?.round !== 1 || sorted[1]?.round === 1) {
    throw new TypeError("Recommendation V2 discovery rounds are invalid");
  }
  let totalAuthorizedMicros = 0;
  for (const round of sorted) {
    assertNonEmpty(round.requestFingerprint, "request fingerprint");
    assertNonEmpty(round.idempotencyKey, "round idempotency key");
    if (
      !Number.isSafeInteger(round.maxCostMicros) ||
      round.maxCostMicros < 0 ||
      round.maxCostMicros > recommendationDiscoveryRoundBudgetMicros
    ) {
      throw new TypeError("Recommendation V2 round budget exceeds 1 USD");
    }
    totalAuthorizedMicros += round.maxCostMicros;
  }
  if (totalAuthorizedMicros > recommendationDiscoveryTotalBudgetMicros) {
    throw new TypeError("Recommendation V2 total budget exceeds 2 USD");
  }
  if (
    sorted.length === 2 &&
    sorted[0]?.idempotencyKey === sorted[1]?.idempotencyKey
  ) {
    throw new TypeError(
      "Recommendation V2 discovery idempotency keys must be distinct",
    );
  }
}

function validateRoundResult(
  plan: RecommendationPoolV2DiscoveryRound,
  result: RecommendationPoolV2DiscoveryRoundResult,
): void {
  if (result.round !== plan.round) {
    throw new TypeError("Recommendation V2 discovery round identity changed");
  }
  if (result.requestFingerprint !== plan.requestFingerprint) {
    throw new TypeError("Recommendation V2 provider fingerprint changed");
  }
  assertNonNegativeInteger(
    result.totalUniqueCandidateCount,
    "unique candidate count",
  );
  if (
    result.totalUniqueCandidateCount > recommendationDiscoveryHardCandidateLimit
  ) {
    throw new TypeError("Recommendation V2 hard candidate limit exceeded");
  }
  for (const window of result.completedWindows) {
    if (typeof window.completed !== "boolean") {
      throw new TypeError(
        "Recommendation V2 discovery window completion is invalid",
      );
    }
    assertNonNegativeInteger(window.rawCandidateCount, "raw candidate count");
    assertNonNegativeInteger(
      window.canonicalCandidateCount,
      "canonical candidate count",
    );
    assertNonNegativeInteger(window.newUniqueCount, "new unique count");
    if (
      window.canonicalCandidateCount > window.rawCandidateCount ||
      window.newUniqueCount > window.canonicalCandidateCount
    ) {
      throw new TypeError("Recommendation V2 discovery window is invalid");
    }
  }
  if (result.chargeState === "unknown_charge") {
    if (result.costMicros !== null) {
      throw new TypeError(
        "Recommendation V2 unknown charge cannot report settled cost",
      );
    }
    return;
  }
  if (
    result.costMicros === null ||
    !Number.isSafeInteger(result.costMicros) ||
    result.costMicros < 0 ||
    result.costMicros > plan.maxCostMicros
  ) {
    throw new TypeError("Recommendation V2 settled round cost is invalid");
  }
}

function stopAfterRound(
  result: RecommendationPoolV2DiscoveryRoundResult,
  allWindows: readonly RecommendationDiscoveryWindow[],
): RecommendationDiscoveryStopReason | null {
  if (result.chargeState === "unknown_charge") return "UNKNOWN_CHARGE";
  if (
    result.totalUniqueCandidateCount >=
    recommendationDiscoveryHardCandidateLimit
  ) {
    return "CANDIDATE_LIMIT_REACHED";
  }
  if (
    result.totalUniqueCandidateCount >= recommendationDiscoverySupplyThreshold
  ) {
    return "SAFE_SUPPLY_REACHED";
  }
  if (hasConsecutiveRecommendationLowYield(allWindows)) return "LOW_YIELD";
  if (result.pathsExhausted) return "PATHS_EXHAUSTED";
  return null;
}

function isBoundedExhaustion(
  reason: RecommendationDiscoveryStopReason,
): boolean {
  return boundedExhaustionReasons.has(reason);
}

function failureRetryability(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) return false;
    if (
      "retryable" in candidate &&
      typeof candidate.retryable === "boolean"
    ) {
      return candidate.retryable;
    }
    if (
      "nonRetryable" in candidate &&
      typeof candidate.nonRetryable === "boolean"
    ) {
      return !candidate.nonRetryable;
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
  return false;
}

function selectPreparationBatches(
  batches: readonly RecommendationPoolV2CanonicalBatch[],
): readonly RecommendationPoolV2CanonicalBatch[] {
  const sorted = [...batches].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const ordinals = new Set<number>();
  for (const [index, batch] of sorted.entries()) {
    assertNonEmpty(batch.batchId, "canonical batch ID");
    if (
      !Number.isSafeInteger(batch.ordinal) ||
      batch.ordinal < 1 ||
      batch.ordinal !== index + 1 ||
      !Number.isSafeInteger(batch.originalBatchSize) ||
      batch.originalBatchSize < 1 ||
      ordinals.has(batch.ordinal)
    ) {
      throw new TypeError("Recommendation V2 canonical batch is invalid");
    }
    ordinals.add(batch.ordinal);
  }
  return Object.freeze(sorted.slice(0, 2));
}

function validateFinalization(
  finalization: RecommendationPoolV2GenerationFinalization,
  expected?: Readonly<{
    terminalReason: RecommendationDiscoveryStopReason;
    totalSettledCostMicros: number;
  }>,
): void {
  assertNonNegativeInteger(
    finalization.effectiveUniqueCandidateCount,
    "finalized unique candidate count",
  );
  assertNonNegativeInteger(
    finalization.totalSettledCostMicros,
    "finalized settled cost",
  );
  if (
    finalization.effectiveUniqueCandidateCount >
      recommendationDiscoveryHardCandidateLimit ||
    finalization.totalSettledCostMicros >
      recommendationDiscoveryTotalBudgetMicros
  ) {
    throw new TypeError("Recommendation V2 finalization exceeds limits");
  }
  if (
    expected !== undefined &&
    (finalization.discoveryTerminalReason !== expected.terminalReason ||
      finalization.totalSettledCostMicros !== expected.totalSettledCostMicros)
  ) {
    throw new TypeError("Recommendation V2 finalization is inconsistent");
  }
  const discoveryCompletedAt = Date.parse(finalization.discoveryCompletedAt);
  const preparationStartedAt = Date.parse(finalization.preparationStartedAt);
  const preparationDeadlineAt = Date.parse(finalization.preparationDeadlineAt);
  if (
    !Number.isFinite(discoveryCompletedAt) ||
    !Number.isFinite(preparationStartedAt) ||
    !Number.isFinite(preparationDeadlineAt) ||
    preparationStartedAt < discoveryCompletedAt ||
    preparationDeadlineAt - preparationStartedAt !==
      contactPreparationDeadlineMs
  ) {
    throw new TypeError(
      "Recommendation V2 preparation deadline must be exactly 24 hours",
    );
  }
  selectPreparationBatches(finalization.batches);
  const batchCandidateCount = finalization.batches.reduce(
    (total, batch) => total + batch.originalBatchSize,
    0,
  );
  if (
    batchCandidateCount !== finalization.effectiveUniqueCandidateCount ||
    (finalization.effectiveUniqueCandidateCount === 0
      ? finalization.batches.length !== 0
      : finalization.batches.length === 0)
  ) {
    throw new TypeError(
      "Recommendation V2 finalization does not cover the full generation",
    );
  }
}

function isSuperseded(
  input: RecommendationPoolV2WorkflowInput,
  supersession: RecommendationPoolV2Supersession | undefined,
): boolean {
  return (
    supersession !== undefined &&
    supersession.contractVersion === 2 &&
    supersession.organizationId === input.organizationId &&
    supersession.workspaceId === input.workspaceId &&
    supersession.websiteProjectId === input.websiteProjectId &&
    supersession.generationContractId === input.generationContractId &&
    supersession.oldRecommendationContextVersionId ===
      input.recommendationContextVersionId &&
    supersession.authoritativeRecommendationContextVersionId !==
      input.recommendationContextVersionId
  );
}

async function settleSupersession(
  input: RecommendationPoolV2WorkflowInput,
  activities: RecommendationPoolV2WorkflowActivities,
  hooks: RecommendationPoolV2WorkflowHooks,
): Promise<boolean> {
  const supersession = hooks.readSupersession();
  if (!isSuperseded(input, supersession)) return false;
  await activities.completeGenerationSupersession({
    ...input,
    supersession: supersession ?? null,
  });
  return true;
}

async function prepareCanonicalBatches(
  input: RecommendationPoolV2WorkflowInput,
  finalization: RecommendationPoolV2GenerationFinalization,
  activities: RecommendationPoolV2WorkflowActivities,
  hooks: RecommendationPoolV2WorkflowHooks,
): Promise<"available" | "superseded"> {
  const selected = selectPreparationBatches(finalization.batches);
  if (selected.length === 0) return "available";
  const batchIds = Object.freeze(selected.map((batch) => batch.batchId));
  await activities.prepareCanonicalBatches({
    ...input,
    batchIds,
    preparationDeadlineAt: finalization.preparationDeadlineAt,
  });
  let deadlineConverged = false;
  for (;;) {
    if (await settleSupersession(input, activities, hooks)) {
      return "superseded";
    }
    const inspection = await activities.inspectCanonicalBatchPreparation({
      ...input,
      batchIds,
      preparationDeadlineAt: finalization.preparationDeadlineAt,
    });
    if (inspection.state === "SUPERSEDED") {
      await activities.completeGenerationSupersession({
        ...input,
        supersession: null,
      });
      return "superseded";
    }
    if (
      inspection.state === "AVAILABLE" &&
      inspection.totalBatchCount === batchIds.length &&
      inspection.terminalBatchCount === batchIds.length
    ) {
      return "available";
    }
    const databaseNow = Date.parse(inspection.databaseNow);
    const deadlineAt = Date.parse(finalization.preparationDeadlineAt);
    if (!Number.isFinite(databaseNow) || !Number.isFinite(deadlineAt)) {
      throw new TypeError("Recommendation V2 preparation clock is invalid");
    }
    if (databaseNow >= deadlineAt) {
      if (deadlineConverged) {
        throw new Error(
          "RECOMMENDATION_POOL_V2_CONTACT_DEADLINE_DID_NOT_CONVERGE",
        );
      }
      await activities.convergeCanonicalBatchPreparation({
        ...input,
        batchIds,
        preparationDeadlineAt: finalization.preparationDeadlineAt,
        terminalReason: "COMPLETED_PARTIAL",
      });
      deadlineConverged = true;
      continue;
    }
    await hooks.waitForPreparationPoll({
      delayMs: Math.min(contactPreparationPollMs, deadlineAt - databaseNow),
    });
  }
}

async function runRecommendationPoolV2WorkflowCore(
  input: RecommendationPoolV2WorkflowInput,
  activities: RecommendationPoolV2WorkflowActivities,
  hooks: RecommendationPoolV2WorkflowHooks,
): Promise<RecommendationPoolV2WorkflowResult> {
  validateWorkflowInput(input);
  if (await settleSupersession(input, activities, hooks)) {
    return { status: "superseded" };
  }
  const start = await activities.loadGeneration(input);
  if (start.status === "input_required") return start;
  if (start.status === "superseded") {
    await activities.completeGenerationSupersession({
      ...input,
      supersession: null,
    });
    return { status: "superseded" };
  }

  let finalization: RecommendationPoolV2GenerationFinalization;
  let totalSettledCostMicros = 0;
  if (start.status === "already_completed") {
    finalization = start.finalization;
    validateFinalization(finalization);
    totalSettledCostMicros = finalization.totalSettledCostMicros;
  } else {
    const plans = [...input.rounds].sort(
      (left, right) => left.round - right.round,
    );
    const results: RecommendationPoolV2DiscoveryRoundResult[] = [];
    const windows: RecommendationDiscoveryWindow[] = [];
    let terminalReason: RecommendationDiscoveryStopReason | null = null;

    for (const plan of plans) {
      if (plan.round === 2) {
        const round1 = results[0];
        if (round1 === undefined) {
          throw new TypeError("Recommendation V2 round 2 requires round 1");
        }
        if (round1.chargeState === "unknown_charge") {
          terminalReason = "UNKNOWN_CHARGE";
          break;
        }
        if (plan.requestFingerprint === round1.requestFingerprint) {
          terminalReason = "PATHS_EXHAUSTED";
          break;
        }
        if (
          totalSettledCostMicros + plan.maxCostMicros >
          recommendationDiscoveryTotalBudgetMicros
        ) {
          terminalReason = "BUDGET_EXHAUSTED";
          break;
        }
      }
      if (await settleSupersession(input, activities, hooks)) {
        return { status: "superseded" };
      }
      let result: RecommendationPoolV2DiscoveryRoundResult;
      try {
        result = await activities.executeDiscoveryRound({
          ...input,
          ...plan,
        });
      } catch (error) {
        if (await settleSupersession(input, activities, hooks)) {
          return { status: "superseded" };
        }
        throw error;
      }
      validateRoundResult(plan, result);
      const previousTotal = results.at(-1)?.totalUniqueCandidateCount ?? 0;
      if (result.totalUniqueCandidateCount < previousTotal) {
        throw new TypeError(
          "Recommendation V2 unique candidate count cannot decrease",
        );
      }
      if (await settleSupersession(input, activities, hooks)) {
        return { status: "superseded" };
      }
      results.push(result);
      windows.push(...result.completedWindows);
      if (result.costMicros !== null) {
        totalSettledCostMicros += result.costMicros;
      }
      if (totalSettledCostMicros > recommendationDiscoveryTotalBudgetMicros) {
        throw new TypeError("Recommendation V2 settled cost exceeds 2 USD");
      }
      terminalReason = stopAfterRound(result, windows);
      if (terminalReason !== null) break;
      if (plan.round === 2) {
        terminalReason = "BUDGET_EXHAUSTED";
        break;
      }
    }

    terminalReason ??=
      plans.length === 1 ? "PATHS_EXHAUSTED" : "BUDGET_EXHAUSTED";
    if (await settleSupersession(input, activities, hooks)) {
      return { status: "superseded" };
    }
    finalization = await activities.finalizeGeneration({
      ...input,
      terminalReason,
      totalSettledCostMicros,
      hardCandidateLimit: recommendationDiscoveryHardCandidateLimit,
      rounds: Object.freeze(results),
    });
    validateFinalization(finalization, {
      terminalReason,
      totalSettledCostMicros,
    });
  }

  if (await settleSupersession(input, activities, hooks)) {
    return { status: "superseded" };
  }
  if (finalization.effectiveUniqueCandidateCount === 0) {
    if (hooks.terminalSemanticsVersion === 1) {
      const reason = "RECOMMENDATION_POOL_V2_NO_NATIVE_CANDIDATES" as const;
      await activities.completeGenerationWithoutPublication({
        ...input,
        reason,
      });
      return Object.freeze({
        status: "input_required",
        reason,
      });
    }
    if (!isBoundedExhaustion(finalization.discoveryTerminalReason)) {
      throw new Error(
        "RECOMMENDATION_POOL_V2_ZERO_RESULT_NOT_EXHAUSTED",
      );
    }
    const reason = "NO_VALID_CANDIDATES_AFTER_EXHAUSTION" as const;
    await activities.completeGenerationWithoutPublication({
      ...input,
      reason,
    });
    return Object.freeze({
      status: "completed",
      discoveryTerminalReason: reason,
      effectiveUniqueCandidateCount: 0,
      preparedBatchIds: Object.freeze([]),
      totalSettledCostMicros,
    });
  }
  const preparedBatchIds = Object.freeze(
    selectPreparationBatches(finalization.batches).map(
      (batch) => batch.batchId,
    ),
  );
  const preparation = await prepareCanonicalBatches(
    input,
    finalization,
    activities,
    hooks,
  );
  if (preparation === "superseded") return { status: "superseded" };
  const partialExhausted =
    hooks.terminalSemanticsVersion === 2 &&
    finalization.effectiveUniqueCandidateCount <
      recommendationDiscoverySupplyThreshold &&
    isBoundedExhaustion(finalization.discoveryTerminalReason);
  await activities.activateGeneration({
    ...input,
    batchIds: preparedBatchIds,
    ...(hooks.terminalSemanticsVersion === 2
      ? {
          publicationOutcome: partialExhausted
            ? "PARTIAL_EXHAUSTED" as const
            : "READY" as const,
        }
      : {}),
  });
  return Object.freeze({
    status: partialExhausted ? "partial_exhausted" : "completed",
    discoveryTerminalReason: finalization.discoveryTerminalReason,
    effectiveUniqueCandidateCount: finalization.effectiveUniqueCandidateCount,
    preparedBatchIds,
    totalSettledCostMicros,
  });
}

export async function runRecommendationPoolV2Workflow(
  input: RecommendationPoolV2WorkflowInput,
  activities: RecommendationPoolV2WorkflowActivities,
  hooks: RecommendationPoolV2WorkflowHooks,
): Promise<RecommendationPoolV2WorkflowResult> {
  try {
    return await runRecommendationPoolV2WorkflowCore(input, activities, hooks);
  } catch (error) {
    const failureMessage =
      error instanceof Error ? error.message : String(error);
    const retryable = failureRetryability(error);
    await activities.failGeneration({
      ...input,
      failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
      failureMessage,
      ...(hooks.terminalSemanticsVersion === 2
        ? { failureRetryable: retryable }
        : {}),
    });
    if (hooks.terminalSemanticsVersion === 2) {
      return Object.freeze({
        status: "failed",
        failureCode: "RECOMMENDATION_POOL_V2_WORKFLOW_FAILED",
        failureMessage,
        failureRetryable: retryable,
      });
    }
    throw error;
  }
}
