import { describe, expect, it } from "vitest";

import {
  guardV1RecommendationPoolGeneration,
  guardV1RecommendationPoolProjectWrites,
  recommendationPoolContractNotApplicable,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-contract-guard.js";

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  websiteProjectId: "33333333-3333-4333-8333-333333333333",
  recommendationContextVersionId: "44444444-4444-4444-8444-444444444444",
  visiblePoolGeneration: 2,
} as const;

const queryWithRows = (
  rows: readonly Record<string, unknown>[],
  project: Record<string, unknown> = {
    poolContractVersion: "recommendation-pool.v1",
    migrationState: "V1_ACTIVE",
    v1WritesFrozen: false,
  },
) => ({
  async query(sql: string) {
    return {
      rows: sql.includes(":project_writes */") ? [project] : rows,
    };
  },
});

describe("recommendation pool contract guard", () => {
  it("accepts only explicit V1 or the exact legacy V1 generation triple", async () => {
    await expect(guardV1RecommendationPoolGeneration(
      queryWithRows([{
        poolContractVersion: "recommendation-pool.v1",
        qualificationContractVersion: "other",
        visibilityContractVersion: "other",
        scoreModelVersion: "other",
        visiblePoolGeneration: 2,
      }]),
      input,
    )).resolves.toEqual({
      status: "applicable",
      poolContractVersion: "recommendation-pool.v1",
      visiblePoolGeneration: 2,
    });

    await expect(guardV1RecommendationPoolGeneration(
      queryWithRows([{
        poolContractVersion: null,
        qualificationContractVersion: "recommendation-qualification.v1",
        visibilityContractVersion: "recommendation-visibility.v1",
        scoreModelVersion: "recommendation-commercial-fit.v4",
        visiblePoolGeneration: 2,
      }]),
      input,
    )).resolves.toMatchObject({ status: "applicable" });
  });

  it("returns contract_not_applicable for explicit V2", async () => {
    await expect(guardV1RecommendationPoolGeneration(
      queryWithRows([{
        poolContractVersion: "recommendation-pool.v2",
        qualificationContractVersion: "recommendation-qualification.v2",
        visibilityContractVersion: "recommendation-visibility.v2",
        scoreModelVersion: "recommendation-commercial-fit.v5",
        visiblePoolGeneration: 2,
      }]),
      input,
    )).resolves.toBe(recommendationPoolContractNotApplicable);
  });

  it.each([
    ["V2 project", {
      poolContractVersion: "recommendation-pool.v2",
      migrationState: "V2_ACTIVE",
      v1WritesFrozen: false,
    }],
    ["global freeze", {
      poolContractVersion: "recommendation-pool.v1",
      migrationState: "V1_ACTIVE",
      v1WritesFrozen: true,
    }],
  ] as const)("blocks writes for %s before reading generation", async (
    _label,
    project,
  ) => {
    await expect(guardV1RecommendationPoolProjectWrites(
      queryWithRows([], project),
      input,
    )).resolves.toBe(recommendationPoolContractNotApplicable);
  });

  it.each([
    ["missing generation", []],
    ["duplicate generation", [
      {
        poolContractVersion: "recommendation-pool.v1",
        visiblePoolGeneration: 2,
      },
      {
        poolContractVersion: "recommendation-pool.v1",
        visiblePoolGeneration: 2,
      },
    ]],
    ["unknown contract", [{
      poolContractVersion: "recommendation-pool.v3",
      visiblePoolGeneration: 2,
    }]],
    ["incomplete legacy contract", [{
      poolContractVersion: null,
      qualificationContractVersion: "recommendation-qualification.v1",
      visibilityContractVersion: "recommendation-visibility.v2",
      scoreModelVersion: "recommendation-commercial-fit.v4",
      visiblePoolGeneration: 2,
    }]],
  ] as const)("fails closed for %s", async (_label, rows) => {
    await expect(guardV1RecommendationPoolGeneration(
      queryWithRows(rows),
      input,
    )).rejects.toThrow(
      "BACKLINK_RECOMMENDATION_POOL_CONTRACT_UNAVAILABLE",
    );
  });
});
