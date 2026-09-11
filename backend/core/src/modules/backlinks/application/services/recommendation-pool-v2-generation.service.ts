import type {
  RecommendationPoolV2DiscoveryRoundResult,
  RecommendationPoolV2WorkflowActivities,
} from "./recommendation-pool-v2-workflow.service.js";

type ExecuteInput = Parameters<
  RecommendationPoolV2WorkflowActivities["executeDiscoveryRound"]
>[0];

export type RecommendationPoolV2DiscoveryRoundExecutor = Readonly<{
  execute(
    input: ExecuteInput,
  ): Promise<RecommendationPoolV2DiscoveryRoundResult>;
}>;

export function createRecommendationPoolV2GenerationService(
  executor: RecommendationPoolV2DiscoveryRoundExecutor,
): Pick<RecommendationPoolV2WorkflowActivities, "executeDiscoveryRound"> {
  return Object.freeze({
    async executeDiscoveryRound(
      input: ExecuteInput,
    ): Promise<RecommendationPoolV2DiscoveryRoundResult> {
      if (
        !Number.isSafeInteger(input.maxCostMicros)
        || input.maxCostMicros < 0
        || input.maxCostMicros > 1_000_000
      ) {
        throw new TypeError("Recommendation V2 round budget exceeds 1 USD");
      }
      const result = await executor.execute(input);
      if (
        result.round !== input.round
        || result.requestFingerprint !== input.requestFingerprint
      ) {
        throw new TypeError(
          "Recommendation V2 discovery executor changed round identity",
        );
      }
      if (result.chargeState === "unknown_charge") {
        if (result.costMicros !== null) {
          throw new TypeError(
            "Recommendation V2 unknown charge cannot report settled cost",
          );
        }
        return result;
      }
      if (
        result.costMicros === null
        || !Number.isSafeInteger(result.costMicros)
        || result.costMicros < 0
        || result.costMicros > input.maxCostMicros
      ) {
        throw new TypeError(
          "Recommendation V2 discovery executor exceeded round budget",
        );
      }
      return result;
    },
  });
}
