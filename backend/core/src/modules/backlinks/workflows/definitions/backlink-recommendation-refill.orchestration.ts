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
import { commercialSupplyPublishedTarget } from "../../domain/recommendations/commercial-refill-cycle.js";

export type BacklinkRecommendationRefillInput = Readonly<{
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
  | Readonly<{ status: "started"; readyCount: number; jobId: string }>;
type ExecuteRefillInput = BacklinkRecommendationRefillInput &
  Readonly<{
    jobId: string;
    requestedCount: number;
    source: "paid" | "resource" | "existing";
  }>;
type StoreReadyRecommendationsInput = BacklinkRecommendationRefillInput &
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
type RecordFailureInput = BacklinkRecommendationRefillInput &
  Readonly<{
    jobId: string;
    errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED";
    rootCause: RecommendationRefillRootCause;
    recovery: RecommendationRefillRecovery;
    diagnosticId: string;
    message: string;
  }>;
type CompleteSupplyInput = BacklinkRecommendationRefillInput &
  Readonly<{
    jobId: string;
    outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED";
    publishedCount: number;
    addedCount: number;
    evaluatedCount: number;
    excludedCount: number;
    insufficientDataCount: number;
  }>;
export type BacklinkRecommendationRefillActivities = Readonly<{
  reserveRecommendationRefill(
    input: BacklinkRecommendationRefillInput,
  ): Promise<RecommendationRefillStart>;
  executeRecommendationRefill(input: ExecuteRefillInput): Promise<
    Readonly<{
      candidates: readonly RecommendationEvidenceCandidate[];
      provider: RecommendationProviderExecutionSummary;
    }>
  >;
  storeReadyRecommendations(
    input: StoreReadyRecommendationsInput,
  ): Promise<Readonly<{ addedCount: number }>>;
  planRecommendationRefillSupply(
    input: BacklinkRecommendationRefillInput & Readonly<{ jobId: string }>,
  ): Promise<CommercialSupplyOperationStep>;
  completeRecommendationRefillSupply(input: CompleteSupplyInput): Promise<void>;
  waitForRecommendationRefillRetry(
    input: Readonly<{
      retryAfterMs: number;
      reason: "contact_processing" | "budget" | "provider" | "project_context";
    }>,
  ): Promise<void>;
  recordRecommendationRefillFailure(input: RecordFailureInput): Promise<void>;
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
      outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED";
      publishedCount: number;
    }>;

export async function runBacklinkRecommendationRefillWorkflow(
  input: BacklinkRecommendationRefillInput,
  activities: BacklinkRecommendationRefillActivities,
): Promise<BacklinkRecommendationRefillResult> {
  const start = await activities.reserveRecommendationRefill(input);
  if (start.status !== "started") return start;

  try {
    let addedCount = 0;
    let evaluatedCount = 0;
    let excludedCount = 0;
    let insufficientDataCount = 0;
    while (true) {
      const step = await activities.planRecommendationRefillSupply({
        ...input,
        jobId: start.jobId,
      });
      if (step.status === "wait") {
        await activities.waitForRecommendationRefillRetry({
          retryAfterMs: step.retryAfterMs,
          reason: step.reason,
        });
        continue;
      }
      if (step.status === "complete") {
        const completed =
          step.outcome === "TARGET_REACHED" &&
          step.publishedCount >= commercialSupplyPublishedTarget;
        await activities.completeRecommendationRefillSupply({
          ...input,
          jobId: start.jobId,
          outcome: step.outcome,
          publishedCount: step.publishedCount,
          addedCount,
          evaluatedCount,
          excludedCount,
          insufficientDataCount,
        });
        return {
          status: completed ? "completed" : "incomplete",
          readyCount: start.readyCount,
          jobId: start.jobId,
          addedCount,
          evaluatedCount,
          excludedCount,
          insufficientDataCount,
          outcome: step.outcome,
          publishedCount: step.publishedCount,
        };
      }
      const result = await activities.executeRecommendationRefill({
        ...input,
        jobId: start.jobId,
        refillWindowKey: step.refillWindowKey,
        requestedCount: step.requestedCandidateCount,
        source: step.source,
      });
      const prepared = prepareReadyRecommendationRefill({
        candidates: result.candidates,
        requestedCount: step.requestedCandidateCount,
      });
      const stored = await activities.storeReadyRecommendations({
        ...input,
        jobId: start.jobId,
        refillWindowKey: step.refillWindowKey,
        finalizeJob: false,
        recommendations: prepared.ready,
        provider: result.provider,
        evaluationSummary: prepared.counts,
      });
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
    }
  } catch (error) {
    const failure = normalizeRecommendationRefillFailure(error, start.jobId);
    await activities.recordRecommendationRefillFailure({
      ...input,
      jobId: start.jobId,
      errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED",
      ...failure,
    });
    throw error;
  }
}
