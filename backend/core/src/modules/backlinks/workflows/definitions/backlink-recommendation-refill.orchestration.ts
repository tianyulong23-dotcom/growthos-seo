import {
  prepareReadyRecommendationRefill,
  type RecommendationEvidenceCandidate,
  type ReadyRecommendationDecision,
} from "../../domain/recommendations/evaluation.js";
import {
  normalizeRecommendationRefillFailure,
  type RecommendationRefillRecovery,
  type RecommendationRefillRootCause,
} from "../../domain/recommendations/refill-failure.js";
import type { CommercialSupplyOperationStep } from "../../application/services/commercial-supply-operation.service.js";
import { resolveCommercialRefillRetryDelay } from "../../domain/recommendations/commercial-refill-cycle.js";
import type { ProviderOperationBudgetAuthorization } from "../../domain/recommendations/provider-operation-budget.js";
import type { RecommendationPoolContractNotApplicable } from "../../domain/recommendations/recommendation-pool-contract-guard.js";

export type BacklinkRecommendationRefillRequest = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  jobId: string;
  workflowId: string;
  correlationId: string;
  actorId: string;
  refillWindowKey: string;
  lowWatermark: number;
  highWatermark: number;
  providerOperationId?: string;
  providerBudgetAuthorization?: ProviderOperationBudgetAuthorization;
  supplyMode?: "existing_evidence";
}>;
export type RecommendationRefillContextIdentity = Readonly<{
  contextVersionId: string;
  snapshotVersion: number;
  profileVersionId: string;
  promotionTargetVersionId: string;
  generationInputFingerprint: string;
}>;
export type RecommendationRefillSupersessionSignal = Readonly<{
  contractVersion: 1;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  jobId: string;
  workflowId: string;
  oldContext: RecommendationRefillContextIdentity;
  authoritativeContext: RecommendationRefillContextIdentity;
  actorId: string;
  correlationId: string;
  requestId: string;
  idempotencyKey: string;
  lifecycleEventId: string;
  auditEventId: string;
}>;
export type BacklinkRecommendationRefillContinuation = Readonly<{
  jobId: string;
  readyCount: number;
  addedCount: number;
  evaluatedCount: number;
  excludedCount: number;
  insufficientDataCount: number;
  lastExecutedRefillWindowKey?: string;
  executedRefillWindowKeys?: readonly string[];
  supersession?: RecommendationRefillSupersessionSignal;
}>;
export type BacklinkRecommendationRefillInput =
  BacklinkRecommendationRefillRequest &
    Readonly<{
      continuation?: BacklinkRecommendationRefillContinuation;
    }>;
export type RecommendationProviderExecutionSummary = Readonly<{
  source: "cache" | "stale-cache" | "single-flight" | "provider";
  acquiredAt: string;
  costMicros: number;
  requestFingerprint: string;
}>;
export type RecommendationRefillStart =
  | Readonly<{ status: "inventory_sufficient"; readyCount: number }>
  | Readonly<{
      status: "already_started";
      readyCount: number;
      jobId: string;
    }>
  | Readonly<{ status: "started"; readyCount: number; jobId: string }>
  | RecommendationPoolContractNotApplicable;
type ExecuteRefillInput = BacklinkRecommendationRefillRequest &
  Readonly<{
    jobId: string;
    requestedCount: number;
    source: "paid" | "resource" | "existing";
  }>;
type StoreReadyRecommendationsInput = BacklinkRecommendationRefillRequest &
  Readonly<{
    jobId: string;
    finalizeJob?: boolean;
    recommendations: readonly ReadyRecommendationDecision[];
    provider: RecommendationProviderExecutionSummary;
    evaluationSummary: Readonly<{
      evaluated: number;
      ready: number;
      excluded: number;
      insufficientData: number;
    }>;
  }>;
type RecordFailureInput = BacklinkRecommendationRefillRequest &
  Readonly<{
    jobId: string;
    errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED";
    rootCause: RecommendationRefillRootCause;
    recovery: RecommendationRefillRecovery;
    diagnosticId: string;
    message: string;
  }>;
type RecordFailureResult =
  | Readonly<{ status: "failed" }>
  | Readonly<{
      status: "superseded";
      supersession: RecommendationRefillSupersessionSignal;
    }>
  | Readonly<{
      status: "awaiting_provider_reconciliation";
      supersession: RecommendationRefillSupersessionSignal;
    }>;
export type RecommendationRefillTerminalReason =
  "EXISTING_EVIDENCE_WINDOW_COMPLETED" | "EXISTING_EVIDENCE_NO_PROGRESS";
type CompleteSupplyInput = BacklinkRecommendationRefillRequest &
  Readonly<{
    jobId: string;
    outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED" | "PAUSED_BUDGET";
    terminalReason?: RecommendationRefillTerminalReason;
    publishedCount: number;
    addedCount: number;
    evaluatedCount: number;
    excludedCount: number;
    insufficientDataCount: number;
  }>;
type CompleteSupersessionInput = BacklinkRecommendationRefillRequest &
  Readonly<{
    jobId: string;
    supersession: RecommendationRefillSupersessionSignal;
  }>;
export type BacklinkRecommendationRefillActivities = Readonly<{
  reserveRecommendationRefill(
    input: BacklinkRecommendationRefillRequest,
  ): Promise<RecommendationRefillStart>;
  executeRecommendationRefill(input: ExecuteRefillInput): Promise<
    | Readonly<{
        candidates: readonly RecommendationEvidenceCandidate[];
        provider: RecommendationProviderExecutionSummary;
      }>
    | RecommendationPoolContractNotApplicable
  >;
  storeReadyRecommendations(
    input: StoreReadyRecommendationsInput,
  ): Promise<
    Readonly<{ addedCount: number }> | RecommendationPoolContractNotApplicable
  >;
  planRecommendationRefillSupply(
    input: BacklinkRecommendationRefillRequest & Readonly<{ jobId: string }>,
  ): Promise<
    CommercialSupplyOperationStep | RecommendationPoolContractNotApplicable
  >;
  completeRecommendationRefillSupply(
    input: CompleteSupplyInput,
  ): Promise<RecommendationPoolContractNotApplicable | undefined>;
  completeRecommendationRefillSupersession(
    input: CompleteSupersessionInput,
  ): Promise<
    | Readonly<{
        status: "cancelled" | "awaiting_provider_reconciliation" | "no_change";
        replayed: boolean;
      }>
    | RecommendationPoolContractNotApplicable
  >;
  waitForRecommendationRefillRetry(
    input: Readonly<{
      retryAfterMs: number;
      reason: "budget" | "provider" | "project_context";
    }>,
  ): Promise<void>;
  recordRecommendationRefillFailure(
    input: RecordFailureInput,
  ): Promise<
    RecordFailureResult | RecommendationPoolContractNotApplicable | undefined
  >;
}>;
export type BacklinkRecommendationRefillResult =
  | RecommendationRefillStart
  | Readonly<{
      status: "completed" | "incomplete";
      readyCount: number;
      jobId: string;
      addedCount: number;
      evaluatedCount: number;
      excludedCount: number;
      insufficientDataCount: number;
      outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED" | "PAUSED_BUDGET";
      terminalReason?: RecommendationRefillTerminalReason;
      publishedCount: number;
    }>
  | Readonly<{
      status: "cancelled";
      reason: "superseded_project_context";
      jobId: string;
      supersession: RecommendationRefillSupersessionSignal;
    }>;
export type BacklinkRecommendationRefillSliceResult =
  | BacklinkRecommendationRefillResult
  | Readonly<{
      status: "continue_as_new";
      reason: "wait" | "step_limit";
      input: BacklinkRecommendationRefillInput;
    }>;

export const backlinkRecommendationRefillMaxStepsPerRun = 8;

function nonNegativeContinuationCount(
  value: number,
  field:
    | "readyCount"
    | "addedCount"
    | "evaluatedCount"
    | "excludedCount"
    | "insufficientDataCount",
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid recommendation refill continuation ${field}`);
  }
  return value;
}

function resumeState(
  continuation: BacklinkRecommendationRefillContinuation,
): BacklinkRecommendationRefillContinuation {
  if (continuation.jobId.trim() === "") {
    throw new TypeError("Invalid recommendation refill continuation jobId");
  }
  const lastExecutedRefillWindowKey =
    continuation.lastExecutedRefillWindowKey?.trim();
  if (
    continuation.lastExecutedRefillWindowKey !== undefined &&
    lastExecutedRefillWindowKey === ""
  ) {
    throw new TypeError(
      "Invalid recommendation refill continuation lastExecutedRefillWindowKey",
    );
  }
  const executedRefillWindowKeys = continuation.executedRefillWindowKeys?.map(
    (value) => value.trim(),
  );
  if (
    executedRefillWindowKeys?.some((value) => value === "") ||
    (executedRefillWindowKeys !== undefined &&
      new Set(executedRefillWindowKeys).size !==
        executedRefillWindowKeys.length) ||
    (lastExecutedRefillWindowKey !== undefined &&
      executedRefillWindowKeys !== undefined &&
      !executedRefillWindowKeys.includes(lastExecutedRefillWindowKey))
  ) {
    throw new TypeError(
      "Invalid recommendation refill continuation executedRefillWindowKeys",
    );
  }
  return Object.freeze({
    jobId: continuation.jobId,
    readyCount: nonNegativeContinuationCount(
      continuation.readyCount,
      "readyCount",
    ),
    addedCount: nonNegativeContinuationCount(
      continuation.addedCount,
      "addedCount",
    ),
    evaluatedCount: nonNegativeContinuationCount(
      continuation.evaluatedCount,
      "evaluatedCount",
    ),
    excludedCount: nonNegativeContinuationCount(
      continuation.excludedCount,
      "excludedCount",
    ),
    insufficientDataCount: nonNegativeContinuationCount(
      continuation.insufficientDataCount,
      "insufficientDataCount",
    ),
    ...(lastExecutedRefillWindowKey === undefined
      ? {}
      : { lastExecutedRefillWindowKey }),
    ...(executedRefillWindowKeys === undefined
      ? {}
      : {
          executedRefillWindowKeys: Object.freeze([
            ...executedRefillWindowKeys,
          ]),
        }),
    ...(continuation.supersession === undefined
      ? {}
      : { supersession: continuation.supersession }),
  });
}

function continuationResult(
  input: BacklinkRecommendationRefillRequest,
  state: BacklinkRecommendationRefillContinuation,
  reason: "wait" | "step_limit",
  supersession?: RecommendationRefillSupersessionSignal,
): BacklinkRecommendationRefillSliceResult {
  return Object.freeze({
    status: "continue_as_new",
    reason,
    input: Object.freeze({
      ...input,
      jobId: state.jobId,
      continuation: Object.freeze({
        ...state,
        ...(supersession === undefined ? {} : { supersession }),
      }),
    }),
  });
}

function validSupersession(
  request: BacklinkRecommendationRefillRequest,
  signal: RecommendationRefillSupersessionSignal | undefined,
): signal is RecommendationRefillSupersessionSignal {
  return (
    signal !== undefined &&
    signal.contractVersion === 1 &&
    signal.organizationId === request.organizationId &&
    signal.workspaceId === request.workspaceId &&
    signal.websiteProjectId === request.websiteProjectId &&
    signal.jobId === request.jobId &&
    signal.workflowId === request.workflowId &&
    signal.oldContext.contextVersionId ===
      request.recommendationContextVersionId &&
    signal.authoritativeContext.snapshotVersion >
      signal.oldContext.snapshotVersion
  );
}

export async function runBacklinkRecommendationRefillWorkflow(
  input: BacklinkRecommendationRefillInput,
  activities: BacklinkRecommendationRefillActivities,
  options: Readonly<{
    maxSteps?: number;
    enableNoProgressGuard?: boolean;
    enableRefillCycleHistoryGuard?: boolean;
    enableBudgetTerminal?: boolean;
    allowExistingEvidenceWindowReplay?: boolean;
    enforceExistingEvidenceWindowOnce?: boolean;
    completeExistingEvidenceWindow?: () => boolean;
    readSupersession?: () => RecommendationRefillSupersessionSignal | undefined;
  }> = {},
): Promise<BacklinkRecommendationRefillSliceResult> {
  const { continuation, ...request } = input;
  const maxSteps =
    options.maxSteps ?? backlinkRecommendationRefillMaxStepsPerRun;
  const enableNoProgressGuard = options.enableNoProgressGuard ?? true;
  const enableRefillCycleHistoryGuard =
    options.enableRefillCycleHistoryGuard ?? true;
  const enableBudgetTerminal = options.enableBudgetTerminal ?? true;
  const allowExistingEvidenceWindowReplay =
    options.allowExistingEvidenceWindowReplay ?? true;
  const enforceExistingEvidenceWindowOnce =
    options.enforceExistingEvidenceWindowOnce ?? true;
  const completeExistingEvidenceWindow =
    options.completeExistingEvidenceWindow ?? (() => true);
  const readSupersession =
    options.readSupersession ?? (() => continuation?.supersession);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError("Recommendation refill maxSteps must be positive");
  }
  const settleSupersession = async (
    state: BacklinkRecommendationRefillContinuation,
  ): Promise<BacklinkRecommendationRefillSliceResult | null> => {
    const supersession = readSupersession();
    if (!validSupersession(request, supersession)) return null;
    const completed = await activities.completeRecommendationRefillSupersession(
      {
        ...request,
        jobId: state.jobId,
        supersession,
      },
    );
    if (completed.status === "contract_not_applicable") return completed;
    if (completed.status === "no_change") return null;
    if (completed.status === "cancelled") {
      return Object.freeze({
        status: "cancelled",
        reason: "superseded_project_context",
        jobId: state.jobId,
        supersession,
      });
    }
    await activities.waitForRecommendationRefillRetry({
      retryAfterMs: 30_000,
      reason: "project_context",
    });
    return continuationResult(request, state, "wait", supersession);
  };

  const initialSupersession = await settleSupersession(
    Object.freeze({
      jobId: continuation?.jobId ?? request.jobId,
      readyCount: continuation?.readyCount ?? 0,
      addedCount: continuation?.addedCount ?? 0,
      evaluatedCount: continuation?.evaluatedCount ?? 0,
      excludedCount: continuation?.excludedCount ?? 0,
      insufficientDataCount: continuation?.insufficientDataCount ?? 0,
      ...(continuation?.lastExecutedRefillWindowKey === undefined
        ? {}
        : {
            lastExecutedRefillWindowKey:
              continuation.lastExecutedRefillWindowKey,
          }),
      ...(continuation?.executedRefillWindowKeys === undefined
        ? {}
        : {
            executedRefillWindowKeys: continuation.executedRefillWindowKeys,
          }),
    }),
  );
  if (initialSupersession !== null) return initialSupersession;

  const initialState =
    continuation === undefined
      ? await activities.reserveRecommendationRefill(request)
      : resumeState(continuation);
  if ("status" in initialState && initialState.status !== "started") {
    return initialState;
  }
  const state: BacklinkRecommendationRefillContinuation =
    "status" in initialState
      ? Object.freeze({
          jobId: initialState.jobId,
          readyCount: initialState.readyCount,
          addedCount: 0,
          evaluatedCount: 0,
          excludedCount: 0,
          insufficientDataCount: 0,
        })
      : initialState;

  try {
    let addedCount = state.addedCount;
    let evaluatedCount = state.evaluatedCount;
    let excludedCount = state.excludedCount;
    let insufficientDataCount = state.insufficientDataCount;
    let lastExecutedRefillWindowKey = state.lastExecutedRefillWindowKey;
    const executedRefillWindowKeys = new Set(
      state.executedRefillWindowKeys ??
        (state.lastExecutedRefillWindowKey === undefined
          ? []
          : [state.lastExecutedRefillWindowKey]),
    );
    const executionHistory = () =>
      enableRefillCycleHistoryGuard && executedRefillWindowKeys.size > 0
        ? {
            executedRefillWindowKeys: Object.freeze([
              ...executedRefillWindowKeys,
            ]),
          }
        : {};
    const completeExistingEvidence = async (
      terminalReason: RecommendationRefillTerminalReason,
    ): Promise<BacklinkRecommendationRefillResult> => {
      const publishedCount = state.readyCount + addedCount;
      const outcome =
        publishedCount >= request.highWatermark
          ? "TARGET_REACHED"
          : "SUPPLY_FLOOR_REACHED";
      const completion = await activities.completeRecommendationRefillSupply({
        ...request,
        jobId: state.jobId,
        outcome,
        terminalReason,
        publishedCount,
        addedCount,
        evaluatedCount,
        excludedCount,
        insufficientDataCount,
      });
      if (completion?.status === "contract_not_applicable") return completion;
      return Object.freeze({
        status: outcome === "TARGET_REACHED" ? "completed" : "incomplete",
        readyCount: state.readyCount,
        jobId: state.jobId,
        addedCount,
        evaluatedCount,
        excludedCount,
        insufficientDataCount,
        outcome,
        terminalReason,
        publishedCount,
      });
    };
    for (
      let completedSteps = 0;
      completedSteps < maxSteps;
      completedSteps += 1
    ) {
      const beforePlan = await settleSupersession({
        ...state,
        addedCount,
        evaluatedCount,
        excludedCount,
        insufficientDataCount,
        ...(lastExecutedRefillWindowKey === undefined
          ? {}
          : { lastExecutedRefillWindowKey }),
        ...executionHistory(),
      });
      if (beforePlan !== null) return beforePlan;
      const step = await activities.planRecommendationRefillSupply({
        ...request,
        jobId: state.jobId,
      });
      if (step.status === "contract_not_applicable") return step;
      if (step.status === "wait") {
        if (enableBudgetTerminal && step.reason === "budget") {
          const completion =
            await activities.completeRecommendationRefillSupply({
              ...request,
              jobId: state.jobId,
              outcome: "PAUSED_BUDGET",
              publishedCount: step.publishedCount,
              addedCount,
              evaluatedCount,
              excludedCount,
              insufficientDataCount,
            });
          if (completion?.status === "contract_not_applicable") {
            return completion;
          }
          return {
            status: "incomplete",
            readyCount: state.readyCount,
            jobId: state.jobId,
            addedCount,
            evaluatedCount,
            excludedCount,
            insufficientDataCount,
            outcome: "PAUSED_BUDGET",
            publishedCount: step.publishedCount,
          };
        }
        await activities.waitForRecommendationRefillRetry({
          retryAfterMs: step.retryAfterMs,
          reason: step.reason,
        });
        const afterWait = await settleSupersession({
          ...state,
          addedCount,
          evaluatedCount,
          excludedCount,
          insufficientDataCount,
          ...(lastExecutedRefillWindowKey === undefined
            ? {}
            : { lastExecutedRefillWindowKey }),
          ...executionHistory(),
        });
        if (afterWait !== null) return afterWait;
        return continuationResult(
          request,
          {
            jobId: state.jobId,
            readyCount: state.readyCount,
            addedCount,
            evaluatedCount,
            excludedCount,
            insufficientDataCount,
            ...(lastExecutedRefillWindowKey === undefined
              ? {}
              : { lastExecutedRefillWindowKey }),
            ...executionHistory(),
          },
          "wait",
        );
      }
      if (step.status === "complete") {
        const completed =
          step.outcome === "TARGET_REACHED" &&
          step.publishedCount >= request.highWatermark;
        const completion = await activities.completeRecommendationRefillSupply({
          ...request,
          jobId: state.jobId,
          outcome: step.outcome,
          publishedCount: step.publishedCount,
          addedCount,
          evaluatedCount,
          excludedCount,
          insufficientDataCount,
        });
        if (completion?.status === "contract_not_applicable") return completion;
        return {
          status: completed ? "completed" : "incomplete",
          readyCount: state.readyCount,
          jobId: state.jobId,
          addedCount,
          evaluatedCount,
          excludedCount,
          insufficientDataCount,
          outcome: step.outcome,
          publishedCount: step.publishedCount,
        };
      }
      if (
        enableNoProgressGuard &&
        enforceExistingEvidenceWindowOnce &&
        step.source === "existing" &&
        (enableRefillCycleHistoryGuard
          ? executedRefillWindowKeys.has(step.refillWindowKey)
          : step.refillWindowKey === lastExecutedRefillWindowKey)
      ) {
        return completeExistingEvidence("EXISTING_EVIDENCE_NO_PROGRESS");
      }
      if (
        enableNoProgressGuard &&
        !(
          allowExistingEvidenceWindowReplay &&
          !enforceExistingEvidenceWindowOnce &&
          step.source === "existing"
        ) &&
        (enableRefillCycleHistoryGuard
          ? executedRefillWindowKeys.has(step.refillWindowKey)
          : step.refillWindowKey === lastExecutedRefillWindowKey)
      ) {
        const retryReason =
          step.source === "paid" ? "provider" : "project_context";
        await activities.waitForRecommendationRefillRetry({
          retryAfterMs: resolveCommercialRefillRetryDelay({
            reason: retryReason,
            stableKey: [state.jobId, step.refillWindowKey, retryReason].join(
              ":",
            ),
          }),
          reason: retryReason,
        });
        const afterWait = await settleSupersession({
          ...state,
          addedCount,
          evaluatedCount,
          excludedCount,
          insufficientDataCount,
          ...(lastExecutedRefillWindowKey === undefined
            ? {}
            : { lastExecutedRefillWindowKey }),
          ...executionHistory(),
        });
        if (afterWait !== null) return afterWait;
        return continuationResult(
          request,
          {
            jobId: state.jobId,
            readyCount: state.readyCount,
            addedCount,
            evaluatedCount,
            excludedCount,
            insufficientDataCount,
            ...(lastExecutedRefillWindowKey === undefined
              ? {}
              : { lastExecutedRefillWindowKey }),
            ...executionHistory(),
          },
          "wait",
        );
      }
      const beforeProvider = await settleSupersession({
        ...state,
        addedCount,
        evaluatedCount,
        excludedCount,
        insufficientDataCount,
        ...(lastExecutedRefillWindowKey === undefined
          ? {}
          : { lastExecutedRefillWindowKey }),
        ...executionHistory(),
      });
      if (beforeProvider !== null) return beforeProvider;
      const result = await activities.executeRecommendationRefill({
        ...request,
        jobId: state.jobId,
        refillWindowKey: step.refillWindowKey,
        requestedCount: step.requestedCandidateCount,
        source: step.source,
      });
      if (!("candidates" in result)) return result;
      const afterProvider = await settleSupersession({
        ...state,
        addedCount,
        evaluatedCount,
        excludedCount,
        insufficientDataCount,
        ...(lastExecutedRefillWindowKey === undefined
          ? {}
          : { lastExecutedRefillWindowKey }),
        ...executionHistory(),
      });
      if (afterProvider !== null) return afterProvider;
      const prepared = prepareReadyRecommendationRefill({
        candidates: result.candidates,
        requestedCount: step.requestedCandidateCount,
      });
      const stored = await activities.storeReadyRecommendations({
        ...request,
        jobId: state.jobId,
        refillWindowKey: step.refillWindowKey,
        finalizeJob: false,
        recommendations: prepared.ready,
        provider: result.provider,
        evaluationSummary: prepared.counts,
      });
      if ("status" in stored) return stored;
      if (
        !Number.isInteger(stored.addedCount) ||
        stored.addedCount < 0 ||
        stored.addedCount > prepared.ready.length
      ) {
        throw new TypeError(
          "Ready recommendation store returned invalid count",
        );
      }
      addedCount += stored.addedCount;
      evaluatedCount += prepared.counts.evaluated;
      excludedCount += prepared.counts.excluded;
      insufficientDataCount += prepared.counts.insufficientData;
      lastExecutedRefillWindowKey = step.refillWindowKey;
      if (enableRefillCycleHistoryGuard) {
        executedRefillWindowKeys.add(step.refillWindowKey);
      }
      if (step.source === "existing" && completeExistingEvidenceWindow()) {
        return completeExistingEvidence(
          stored.addedCount === 0
            ? "EXISTING_EVIDENCE_NO_PROGRESS"
            : "EXISTING_EVIDENCE_WINDOW_COMPLETED",
        );
      }
    }
    const beforeContinueAsNew = await settleSupersession({
      ...state,
      addedCount,
      evaluatedCount,
      excludedCount,
      insufficientDataCount,
      ...(lastExecutedRefillWindowKey === undefined
        ? {}
        : { lastExecutedRefillWindowKey }),
      ...executionHistory(),
    });
    if (beforeContinueAsNew !== null) return beforeContinueAsNew;
    return continuationResult(
      request,
      {
        jobId: state.jobId,
        readyCount: state.readyCount,
        addedCount,
        evaluatedCount,
        excludedCount,
        insufficientDataCount,
        ...(lastExecutedRefillWindowKey === undefined
          ? {}
          : { lastExecutedRefillWindowKey }),
        ...executionHistory(),
      },
      "step_limit",
    );
  } catch (error) {
    const failure = normalizeRecommendationRefillFailure(error, state.jobId);
    const terminal = await activities.recordRecommendationRefillFailure({
      ...request,
      jobId: state.jobId,
      errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED",
      ...failure,
    });
    if (terminal?.status === "contract_not_applicable") return terminal;
    if (terminal?.status === "superseded") {
      return Object.freeze({
        status: "cancelled",
        reason: "superseded_project_context",
        jobId: state.jobId,
        supersession: terminal.supersession,
      });
    }
    if (terminal?.status === "awaiting_provider_reconciliation") {
      await activities.waitForRecommendationRefillRetry({
        retryAfterMs: 30_000,
        reason: "project_context",
      });
      return continuationResult(request, state, "wait", terminal.supersession);
    }
    throw error;
  }
}
