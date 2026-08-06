import {
  createRecommendationDomainKey,
} from "./domain-key.js";

export const commercialGoldLabels = Object.freeze([
  "suitable",
  "unsuitable",
  "uncertain",
] as const);

export type CommercialGoldLabel =
  (typeof commercialGoldLabels)[number];

export type CommercialGoldLabelItem = Readonly<{
  canonicalDomain: string;
  marketCode: string;
  label: CommercialGoldLabel;
}>;

export type CommercialGoldPrediction = Readonly<{
  canonicalDomain: string;
  score: number | null;
  decision: "ready" | "excluded" | "insufficient_data" | "manual_review";
  hitGates: readonly string[];
}>;

export type CommercialGoldMetrics = Readonly<{
  precisionAt20: number | null;
  duplicateRate: number;
  gateFalsePositiveRate: number | null;
  topKStability: number | null;
  costPerReadyMicros: number | null;
  labeledCount: number;
  readyCount: number;
  calibrationReady: boolean;
  productionPrecisionClaimAllowed: boolean;
  marketLabelCounts: Readonly<Record<
    string,
    Readonly<Record<CommercialGoldLabel, number>>
  >>;
}>;

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function normalizedDomain(value: string): string {
  return createRecommendationDomainKey(value).hostnameAscii;
}

function uniquePredictions(
  predictions: readonly CommercialGoldPrediction[],
): readonly CommercialGoldPrediction[] {
  const byDomain = new Map<string, CommercialGoldPrediction>();
  for (const prediction of predictions) {
    const domain = normalizedDomain(prediction.canonicalDomain);
    const existing = byDomain.get(domain);
    if (
      existing === undefined
      || (prediction.score ?? -1) > (existing.score ?? -1)
    ) {
      byDomain.set(domain, { ...prediction, canonicalDomain: domain });
    }
  }
  return [...byDomain.values()];
}

function topDomains(
  predictions: readonly CommercialGoldPrediction[],
  limit: number,
): readonly string[] {
  return uniquePredictions(predictions)
    .filter(({ decision }) => decision === "ready")
    .sort((left, right) =>
      (right.score ?? -1) - (left.score ?? -1)
      || left.canonicalDomain.localeCompare(right.canonicalDomain, "en")
    )
    .slice(0, limit)
    .map(({ canonicalDomain }) => canonicalDomain);
}

export function calculateCommercialGoldMetrics(input: Readonly<{
  labels: readonly CommercialGoldLabelItem[];
  predictions: readonly CommercialGoldPrediction[];
  previousPredictions?: readonly CommercialGoldPrediction[];
  totalCostMicros: number;
  topK?: number;
}>): CommercialGoldMetrics {
  if (!Number.isSafeInteger(input.totalCostMicros) || input.totalCostMicros < 0) {
    throw new TypeError("Gold Set cost must be a non-negative integer");
  }
  const topK = input.topK ?? 20;
  if (!Number.isInteger(topK) || topK < 1) {
    throw new TypeError("Gold Set topK must be a positive integer");
  }
  const labelByDomain = new Map<string, CommercialGoldLabelItem>();
  const marketCounts: Record<
    string,
    Record<CommercialGoldLabel, number>
  > = {};
  for (const item of input.labels) {
    const canonicalDomain = normalizedDomain(item.canonicalDomain);
    const marketCode = item.marketCode.trim().toUpperCase();
    if (marketCode.length < 2 || marketCode.length > 12) {
      throw new TypeError("Gold Set marketCode is invalid");
    }
    labelByDomain.set(canonicalDomain, {
      ...item,
      canonicalDomain,
      marketCode,
    });
    const counts = marketCounts[marketCode] ?? {
      suitable: 0,
      unsuitable: 0,
      uncertain: 0,
    };
    counts[item.label] += 1;
    marketCounts[marketCode] = counts;
  }

  const predictionDomains = input.predictions.map(({ canonicalDomain }) =>
    normalizedDomain(canonicalDomain)
  );
  const duplicateRate = predictionDomains.length === 0
    ? 0
    : rounded(
      (predictionDomains.length - new Set(predictionDomains).size)
      / predictionDomains.length,
    );
  const currentTop = topDomains(input.predictions, topK);
  const binaryTopLabels = currentTop
    .map((domain) => labelByDomain.get(domain)?.label)
    .filter(
      (label): label is "suitable" | "unsuitable" =>
        label === "suitable" || label === "unsuitable",
    );
  const suitableTopCount = binaryTopLabels.filter(
    (label) => label === "suitable",
  ).length;
  const precisionAt20 = binaryTopLabels.length === 0
    ? null
    : rounded(suitableTopCount / binaryTopLabels.length);

  let suitableCount = 0;
  let gateFalsePositiveCount = 0;
  const uniqueCurrentPredictions = uniquePredictions(input.predictions);
  for (const prediction of uniqueCurrentPredictions) {
    const label = labelByDomain.get(
      normalizedDomain(prediction.canonicalDomain),
    )?.label;
    if (label !== "suitable") continue;
    suitableCount += 1;
    if (prediction.decision === "excluded" && prediction.hitGates.length > 0) {
      gateFalsePositiveCount += 1;
    }
  }
  const gateFalsePositiveRate = suitableCount === 0
    ? null
    : rounded(gateFalsePositiveCount / suitableCount);

  const previousTop = input.previousPredictions === undefined
    ? null
    : topDomains(input.previousPredictions, topK);
  const topKStability = previousTop === null
    ? null
    : (() => {
        const current = new Set(currentTop);
        const previous = new Set(previousTop);
        const union = new Set([...current, ...previous]);
        if (union.size === 0) return 1;
        const intersection = [...current].filter((domain) =>
          previous.has(domain)
        ).length;
        return rounded(intersection / union.size);
      })();
  const readyCount = uniqueCurrentPredictions.filter(
    ({ decision }) => decision === "ready",
  ).length;
  const calibrationReady =
    labelByDomain.size >= 500
    && Object.keys(marketCounts).length > 0
    && Object.values(marketCounts).every((counts) =>
      commercialGoldLabels.every((label) => counts[label] >= 100)
    );

  return Object.freeze({
    precisionAt20,
    duplicateRate,
    gateFalsePositiveRate,
    topKStability,
    costPerReadyMicros: readyCount === 0
      ? null
      : Math.round(input.totalCostMicros / readyCount),
    labeledCount: labelByDomain.size,
    readyCount,
    calibrationReady,
    productionPrecisionClaimAllowed: calibrationReady,
    marketLabelCounts: Object.freeze(marketCounts),
  });
}
