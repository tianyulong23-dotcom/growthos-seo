export type RecommendationPoolV2ReleaseMetricEvidence = Readonly<{
  value: number | null;
  provider: string;
  endpoint: string;
  market: string;
  location: string;
  language: string;
  observedAt: string;
  requestRef?: string | null;
  artifactRef?: string | null;
}>;

export type RecommendationPoolV2ReleaseMetricSnapshot =
  RecommendationPoolV2ReleaseMetricEvidence;

export type RecommendationPoolV2ReleaseMetricPersistence = Readonly<{
  traffic_snapshot_ref: string;
  rank_snapshot_ref: string;
  spam_snapshot_ref: string;
  traffic_snapshot: RecommendationPoolV2ReleaseMetricSnapshot;
  rank_snapshot: RecommendationPoolV2ReleaseMetricSnapshot;
  spam_snapshot: RecommendationPoolV2ReleaseMetricSnapshot;
  traffic_organic_etv: number | null;
  authority_rank: number | null;
  spam_score: number | null;
}>;

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`Recommendation V2 ${label} is required`);
  }
  return normalized;
}

function buildSnapshot(
  evidence: RecommendationPoolV2ReleaseMetricEvidence,
  label: string,
  maximum: number | null,
): Readonly<{
  snapshot: RecommendationPoolV2ReleaseMetricSnapshot;
  snapshotRef: string;
}> {
  if (
    evidence.value !== null
    && (
      !Number.isFinite(evidence.value)
      || evidence.value < 0
      || (maximum !== null && evidence.value > maximum)
    )
  ) {
    throw new TypeError(`Recommendation V2 ${label} value is invalid`);
  }
  const observedAt = new Date(evidence.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError(`Recommendation V2 ${label} observedAt is invalid`);
  }
  const requestRef = evidence.requestRef?.trim() || null;
  const artifactRef = evidence.artifactRef?.trim() || null;
  const snapshotRef = artifactRef ?? requestRef;
  if (snapshotRef === null) {
    throw new TypeError(
      `Recommendation V2 ${label} requires requestRef or artifactRef`,
    );
  }
  return Object.freeze({
    snapshot: Object.freeze({
      value: evidence.value,
      provider: required(evidence.provider, `${label} provider`),
      endpoint: required(evidence.endpoint, `${label} endpoint`),
      market: required(evidence.market, `${label} market`),
      location: required(evidence.location, `${label} location`),
      language: required(evidence.language, `${label} language`),
      observedAt: observedAt.toISOString(),
      ...(requestRef === null ? {} : { requestRef }),
      ...(artifactRef === null ? {} : { artifactRef }),
    }),
    snapshotRef,
  });
}

export function buildRecommendationPoolV2ReleaseMetricPersistence(
  input: Readonly<{
    traffic: RecommendationPoolV2ReleaseMetricEvidence;
    rank: RecommendationPoolV2ReleaseMetricEvidence;
    spam: RecommendationPoolV2ReleaseMetricEvidence;
  }>,
): RecommendationPoolV2ReleaseMetricPersistence {
  const traffic = buildSnapshot(input.traffic, "traffic snapshot", null);
  const rank = buildSnapshot(input.rank, "rank snapshot", null);
  const spam = buildSnapshot(input.spam, "spam snapshot", 100);
  return Object.freeze({
    traffic_snapshot_ref: traffic.snapshotRef,
    rank_snapshot_ref: rank.snapshotRef,
    spam_snapshot_ref: spam.snapshotRef,
    traffic_snapshot: traffic.snapshot,
    rank_snapshot: rank.snapshot,
    spam_snapshot: spam.snapshot,
    traffic_organic_etv: traffic.snapshot.value,
    authority_rank: rank.snapshot.value,
    spam_score: spam.snapshot.value,
  });
}
