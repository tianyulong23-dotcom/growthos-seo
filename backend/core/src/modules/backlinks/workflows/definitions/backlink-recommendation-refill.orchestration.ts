import {
  prepareReadyRecommendationRefill,
  type RecommendationEvidenceCandidate,
  type ReadyRecommendationDecision,
} from "../../domain/recommendations/evaluation.js";

export type BacklinkRecommendationRefillInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  recommendationContextVersionId: string;
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
type ExecuteRefillInput = BacklinkRecommendationRefillInput & Readonly<{
  jobId: string;
  requestedCount: number;
}>;
type StoreReadyRecommendationsInput =
  BacklinkRecommendationRefillInput & Readonly<{
    jobId: string;
    recommendations: readonly ReadyRecommendationDecision[];
    provider: RecommendationProviderExecutionSummary;
    evaluationSummary: Readonly<{
      evaluated: number;
      ready: number;
      excluded: number;
      insufficientData: number;
    }>;
  }>;
type RecordFailureInput = BacklinkRecommendationRefillInput & Readonly<{
  jobId: string;
  errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED";
}>;
export type BacklinkRecommendationRefillActivities = Readonly<{
  reserveRecommendationRefill(
    input: BacklinkRecommendationRefillInput,
  ): Promise<RecommendationRefillStart>;
  executeRecommendationRefill(
    input: ExecuteRefillInput,
  ): Promise<Readonly<{
    candidates: readonly RecommendationEvidenceCandidate[];
    provider: RecommendationProviderExecutionSummary;
  }>>;
  storeReadyRecommendations(
    input: StoreReadyRecommendationsInput,
  ): Promise<Readonly<{ addedCount: number }>>;
  recordRecommendationRefillFailure(
    input: RecordFailureInput,
  ): Promise<void>;
}>;
export type BacklinkRecommendationRefillResult =
  | RecommendationRefillStart
  | Readonly<{
    status: "completed";
    readyCount: number;
    jobId: string;
    addedCount: number;
    evaluatedCount: number;
    excludedCount: number;
    insufficientDataCount: number;
  }>;

export async function runBacklinkRecommendationRefillWorkflow(
  input: BacklinkRecommendationRefillInput,
  activities: BacklinkRecommendationRefillActivities,
): Promise<BacklinkRecommendationRefillResult> {
  const start = await activities.reserveRecommendationRefill(input);
  if (start.status !== "started") return start;

  try {
    const requestedCount = input.highWatermark - start.readyCount;
    const result = await activities.executeRecommendationRefill({
      ...input,
      jobId: start.jobId,
      requestedCount,
    });
    const prepared = prepareReadyRecommendationRefill({
      candidates: result.candidates,
      requestedCount,
    });
    const stored = await activities.storeReadyRecommendations({
      ...input,
      jobId: start.jobId,
      recommendations: prepared.ready,
      provider: result.provider,
      evaluationSummary: prepared.counts,
    });
    if (
      !Number.isInteger(stored.addedCount) ||
      stored.addedCount < 0 ||
      stored.addedCount > prepared.ready.length
    ) {
      throw new TypeError("Ready recommendation store returned invalid count");
    }
    return {
      status: "completed",
      readyCount: start.readyCount,
      jobId: start.jobId,
      addedCount: stored.addedCount,
      evaluatedCount: prepared.counts.evaluated,
      excludedCount: prepared.counts.excluded,
      insufficientDataCount: prepared.counts.insufficientData,
    };
  } catch (error) {
    await activities.recordRecommendationRefillFailure({
      ...input,
      jobId: start.jobId,
      errorCode: "BACKLINK_RECOMMENDATION_REFILL_FAILED",
    });
    throw error;
  }
}
