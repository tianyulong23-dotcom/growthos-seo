import { describe, expect, it } from "vitest";

import {
  normalizeRecommendationRefillFailure,
} from "../../src/modules/backlinks/domain/recommendations/refill-failure.js";

const operationId = "018f0000-0000-7000-8000-000000000034";

describe("LOCAL-PRODUCT-034 recommendation refill failure contract", () => {
  it.each([
    ["PROVIDER_BUDGET_PAUSED", "BUDGET_PAUSED", "WAIT_PROVIDER"],
    ["DATAFORSEO_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "WAIT_PROVIDER"],
    [
      "PROJECT_CONTEXT_REQUIRED",
      "PROJECT_CONTEXT_REQUIRED",
      "COMPLETE_PROJECT_CONTEXT",
    ],
    [
      "WEBSITE_PROJECT_DISCOVERY_LANGUAGE_INPUT_REQUIRED "
        + "owner=WEBSITE_PROJECT",
      "PROJECT_CONTEXT_REQUIRED",
      "COMPLETE_PROJECT_CONTEXT",
    ],
    [
      "WEBSITE_PROJECT_DISCOVERY_INPUT_REQUIRED owner=WEBSITE_PROJECT",
      "PROJECT_CONTEXT_REQUIRED",
      "COMPLETE_PROJECT_CONTEXT",
    ],
    [
      "COMMERCIAL_REFILL_MANUAL_RESUME_NOT_ALLOWED",
      "RECOVERY_CONFLICT",
      "RESUME_OPERATION",
    ],
    [
      "COMMERCIAL_SUPPLY_OPERATION_NOT_FOUND",
      "RECOVERY_CONFLICT",
      "RESUME_OPERATION",
    ],
    ["LOCAL_PRODUCT_STALE_BUILD", "STALE_BUILD", "RESTART_SERVICE"],
    ["ORPHAN_REFILL_OPERATION", "ORPHAN_OPERATION", "RESTART_SERVICE"],
    [
      "COMMERCIAL_REFILL_SUPPLY_FLOOR_REACHED",
      "SUPPLY_FLOOR_REACHED",
      "RESUME_OPERATION",
    ],
  ] as const)(
    "maps %s to %s",
    (message, rootCause, recovery) => {
      expect(normalizeRecommendationRefillFailure(
        new Error(message),
        operationId,
      )).toMatchObject({ rootCause, recovery });
    },
  );

  it("redacts unknown errors and emits a stable diagnostic ID", () => {
    const first = normalizeRecommendationRefillFailure(
      new Error("database password=do-not-leak"),
      operationId,
    );
    const second = normalizeRecommendationRefillFailure(
      new Error("database password=do-not-leak"),
      operationId,
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      rootCause: "UNKNOWN_INTERNAL",
      recovery: "CONTACT_SUPPORT",
      message: "The recommendation operation failed unexpectedly.",
    });
    expect(first.diagnosticId).toMatch(/^refill-[a-f0-9]+-[a-f0-9]{8}$/);
    expect(JSON.stringify(first)).not.toContain("do-not-leak");
  });

  it("does not broadly classify unrelated input-required failures", () => {
    expect(normalizeRecommendationRefillFailure(
      new Error("UNRELATED_INPUT_REQUIRED"),
      operationId,
    )).toMatchObject({
      rootCause: "UNKNOWN_INTERNAL",
      recovery: "CONTACT_SUPPORT",
    });
  });

  it.each([
    new Error("canceling statement due to lock timeout"),
    Object.assign(new Error("statement cancelled"), { code: "55P03" }),
  ])("maps retry ownership conflicts to resumable recovery", (error) => {
    expect(normalizeRecommendationRefillFailure(error, operationId))
      .toMatchObject({
        rootCause: "RECOVERY_CONFLICT",
        recovery: "RESUME_OPERATION",
      });
  });

  it("classifies a provider failure preserved only in the nested cause", () => {
    const cause = Object.assign(
      new Error("INPUT_REQUIRED: DataForSEO provider configuration is incomplete"),
      { code: "INPUT_REQUIRED" },
    );
    const outer = new Error("Activity task failed", { cause });

    expect(normalizeRecommendationRefillFailure(outer, operationId))
      .toMatchObject({
        rootCause: "PROVIDER_UNAVAILABLE",
        recovery: "WAIT_PROVIDER",
      });
  });
});
