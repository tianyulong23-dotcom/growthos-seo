import type {
  DataForSeoRequestCoordinator,
} from "../../application/services/dataforseo-request.service.js";
import {
  createProviderBudgetRepository,
  type ProviderBudgetReservationInput,
} from "./provider-budget.repository.js";
import {
  createProviderCostControlCoordinator,
} from "./provider-cost-control.repository.js";
import type {
  ProviderArtifactQueryClient,
} from "./provider-artifact.repository.js";

export function createProviderAnalysisRepository(
  client: ProviderArtifactQueryClient,
  now: () => Date,
): DataForSeoRequestCoordinator & Readonly<{
  reserveBudget(
    input: ProviderBudgetReservationInput,
  ): Promise<"allow" | "deny">;
}> {
  const budgets = createProviderBudgetRepository(client, now);
  return {
    ...createProviderCostControlCoordinator(client, { now }),
    reserveBudget: budgets.reserveBudget,
  };
}
