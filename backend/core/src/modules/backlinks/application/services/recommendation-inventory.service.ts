export type RecommendationInventoryDecision =
  | Readonly<{ action: "consume_ready"; available: number }>
  | Readonly<{ action: "hold"; reason: "context_changed" | "refill_in_flight" }>
  | Readonly<{ action: "refill"; requested: number; target: number }>
  | Readonly<{ action: "stop"; reason: "high_watermark_reached" }>;

export function decideRecommendationInventory(input: Readonly<{
  readyCount: number;
  lowWatermark: number;
  highWatermark: number;
  averageDailyConsumption: number;
  inactiveDays: number;
  refillInFlight: boolean;
  recommendationContextMatches: boolean;
}>): RecommendationInventoryDecision {
  const values = [
    input.readyCount,
    input.lowWatermark,
    input.highWatermark,
    input.averageDailyConsumption,
    input.inactiveDays,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    input.lowWatermark >= input.highWatermark
  ) {
    throw new TypeError("Recommendation inventory watermarks are invalid");
  }
  if (!input.recommendationContextMatches) {
    return { action: "hold", reason: "context_changed" };
  }
  if (input.readyCount >= input.highWatermark) {
    return { action: "stop", reason: "high_watermark_reached" };
  }
  if (input.readyCount > input.lowWatermark) {
    return { action: "consume_ready", available: input.readyCount };
  }
  if (input.refillInFlight) {
    return { action: "hold", reason: "refill_in_flight" };
  }

  const activityFactor = input.inactiveDays >= 30
    ? 0.25
    : input.inactiveDays >= 7 ? 0.5 : 1;
  const consumptionTarget = Math.ceil(input.averageDailyConsumption * 7);
  const target = Math.max(
    input.lowWatermark + 1,
    Math.min(
      input.highWatermark,
      Math.max(
        Math.ceil(input.highWatermark * activityFactor),
        consumptionTarget,
      ),
    ),
  );
  return {
    action: "refill",
    requested: Math.max(0, target - input.readyCount),
    target,
  };
}

export function decideRecommendationSwap(readyCount: number):
  "consume_ready" | "inventory_empty" {
  if (!Number.isSafeInteger(readyCount) || readyCount < 0) {
    throw new TypeError("Recommendation Ready count is invalid");
  }
  return readyCount > 0 ? "consume_ready" : "inventory_empty";
}
