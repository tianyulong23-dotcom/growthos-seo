import { describe, expect, it } from "vitest";

import {
  applyProviderBudgetAutomaticOverage,
  replenishProviderBudgetLimit,
  resolveProviderOperationBudgetWindow,
  type ProviderOperationBudgetAuthorization,
} from "../../src/modules/backlinks/domain/recommendations/provider-operation-budget.js";

const persistentAuthorization: ProviderOperationBudgetAuthorization =
  Object.freeze({
    provider: "dataforseo",
    reasonCode: "user_authorized_persistent_discovery",
    maxPaidCalls: 3,
    maxCostMicros: 3_000,
    authorizedBy: "provider-budget-test",
  });

describe("provider operation budget windows", () => {
  it("does not silently enlarge an approved provider ceiling", () => {
    expect(applyProviderBudgetAutomaticOverage(25)).toBe(25);
    expect(replenishProviderBudgetLimit(25, 26, 1_000)).toBe(25);
  });

  it("keeps persistent authorization exact before semantic discovery", () => {
    expect(resolveProviderOperationBudgetWindow({
      authorization: persistentAuthorization,
      paidCallCount: 2,
      exposureMicros: 2_000,
      requiredPaidCalls: 4,
      requiredCostMicros: 4_000,
    })).toEqual({
      maxPaidCalls: 3,
      maxCostMicros: 3_000,
      replenished: false,
    });
  });

  it("does not expand a persistent operation after its ceiling is reached", () => {
    expect(resolveProviderOperationBudgetWindow({
      authorization: persistentAuthorization,
      paidCallCount: 6,
      exposureMicros: 6_000,
      requiredPaidCalls: 3,
      requiredCostMicros: 3_000,
    })).toEqual({
      maxPaidCalls: 3,
      maxCostMicros: 3_000,
      replenished: false,
    });
  });

  it("keeps bounded authorization exact when stage headroom is insufficient", () => {
    const boundedAuthorization: ProviderOperationBudgetAuthorization =
      Object.freeze({
        ...persistentAuthorization,
        reasonCode: "user_authorized_bounded_real_refill",
      });

    expect(resolveProviderOperationBudgetWindow({
      authorization: boundedAuthorization,
      paidCallCount: 2,
      exposureMicros: 2_000,
      requiredPaidCalls: 4,
      requiredCostMicros: 4_000,
    })).toEqual({
      maxPaidCalls: 3,
      maxCostMicros: 3_000,
      replenished: false,
    });
  });

  it("treats the authorization values as the finite hard limits", () => {
    expect(resolveProviderOperationBudgetWindow({
      authorization: persistentAuthorization,
      paidCallCount: 3,
      exposureMicros: 3_000,
      requiredPaidCalls: 1,
      requiredCostMicros: 1,
    })).toEqual({
      maxPaidCalls: 3,
      maxCostMicros: 3_000,
      replenished: false,
    });
  });
});
