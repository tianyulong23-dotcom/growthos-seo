import {
  isRecommendationContactTerminal,
  resolveRecommendationContactTerminalReason,
  type RecommendationContactStatus,
} from "../../domain/recommendations/recommendation-pool-v2-policy.js";

export type RecommendationBatchContactItem = Readonly<{
  itemId: string;
  status: RecommendationContactStatus;
  terminalReasonCode: string | null;
}>;

export function evaluateRecommendationBatchPreparation(
  input: Readonly<{
    items: readonly RecommendationBatchContactItem[];
    preparationDeadline: Date;
    databaseNow: Date;
  }>,
): Readonly<{
  available: boolean;
  itemOutcomes: readonly Readonly<{
    itemId: string;
    terminal: boolean;
    terminalReasonCode: string | null;
  }>[];
}> {
  if (input.items.length === 0) {
    throw new TypeError(
      "Recommendation V2 batch must contain at least one item",
    );
  }
  const deadlineReached =
    input.databaseNow.getTime() >= input.preparationDeadline.getTime();
  const itemOutcomes = input.items.map((item) => {
    const terminalReasonCode = resolveRecommendationContactTerminalReason({
      status: item.status,
      terminalReasonCode: item.terminalReasonCode,
      deadlineReached,
    });
    return Object.freeze({
      itemId: item.itemId,
      terminal:
        isRecommendationContactTerminal(item.status) ||
        terminalReasonCode === "COMPLETED_PARTIAL",
      terminalReasonCode,
    });
  });
  return Object.freeze({
    available: itemOutcomes.every((item) => item.terminal),
    itemOutcomes: Object.freeze(itemOutcomes),
  });
}
