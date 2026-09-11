import { describe, expect, it, vi } from "vitest";

import {
  assertV1RecommendationPoolReadContract,
  recommendationPoolReadContractQueryMarker,
} from "../../../src/modules/backlinks/domain/recommendations/recommendation-pool-read-contract.js";

const scope = Object.freeze({
  organizationId: "org-phase8",
  workspaceId: "workspace-phase8",
  websiteProjectId: "project-phase8",
});

describe("recommendation pool V1 read contract", () => {
  it.each(["V1_ACTIVE", "MIGRATION_BLOCKED"])(
    "keeps %s projects on the legacy read-only path",
    async (migrationState) => {
      const query = vi.fn(async () => ({
        rows: [
          {
            poolContractVersion: "recommendation-pool.v1",
            migrationState,
          },
        ],
      }));

      await expect(
        assertV1RecommendationPoolReadContract({ query }, scope),
      ).resolves.toBeUndefined();

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(recommendationPoolReadContractQueryMarker),
        [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
      );
      expect(query.mock.calls[0]?.[0]).toContain("FOR SHARE OF contract");
    },
  );

  it.each([
    ["recommendation-pool.v2", "V2_READY"],
    ["recommendation-pool.v2", "V2_ACTIVE"],
    ["recommendation-pool.v2", "V2_MAINTENANCE_READ_ONLY"],
    ["recommendation-pool.v1", "V2_READY"],
    ["recommendation-pool.v1", "MIGRATING"],
  ])(
    "rejects %s / %s before legacy recommendation reads",
    async (poolContractVersion, migrationState) => {
      const query = vi.fn(async () => ({
        rows: [{ poolContractVersion, migrationState }],
      }));

      await expect(
        assertV1RecommendationPoolReadContract({ query }, scope),
      ).rejects.toMatchObject({
        code: "BACKLINK_CONFLICT",
      });
    },
  );

  it("keeps legacy reads available before a project contract is created", async () => {
    await expect(
      assertV1RecommendationPoolReadContract(
        { query: vi.fn(async () => ({ rows: [] })) },
        scope,
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps legacy reads available before the contract relation exists", async () => {
    await expect(
      assertV1RecommendationPoolReadContract(
        {
          query: vi.fn(async () =>
            Promise.reject(
              Object.assign(new Error("undefined table"), { code: "42P01" }),
            ),
          ),
        },
        scope,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the project contract is ambiguous", async () => {
    await expect(
      assertV1RecommendationPoolReadContract(
        {
          query: vi.fn(async () => ({
            rows: [
              {
                poolContractVersion: "recommendation-pool.v1",
                migrationState: "V1_ACTIVE",
              },
              {
                poolContractVersion: "recommendation-pool.v1",
                migrationState: "V1_ACTIVE",
              },
            ],
          })),
        },
        scope,
      ),
    ).rejects.toMatchObject({
      code: "BACKLINK_CONFLICT",
    });
  });

  it("propagates contract query failures without attempting a read", async () => {
    const failure = new Error("contract query failed");
    await expect(
      assertV1RecommendationPoolReadContract(
        { query: vi.fn(async () => Promise.reject(failure)) },
        scope,
      ),
    ).rejects.toBe(failure);
  });
});
