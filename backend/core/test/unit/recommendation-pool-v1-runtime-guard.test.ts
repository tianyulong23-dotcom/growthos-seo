import { describe, expect, it, vi } from "vitest";

import {
  guardV1RecommendationPoolProjectWrites,
  recommendationPoolContractVersions,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-contract-guard.js";

const scope = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  websiteProjectId: "00000000-0000-4000-8000-000000000003",
});

type SideEffectCounters = {
  ensure: number;
  refillCommand: number;
  job: number;
  outbox: number;
  reservation: number;
  providerLedger: number;
  providerCall: number;
};

const emptySideEffectCounters = (): SideEffectCounters => ({
  ensure: 0,
  refillCommand: 0,
  job: 0,
  outbox: 0,
  reservation: 0,
  providerLedger: 0,
  providerCall: 0,
});

async function runGuardedV1Entry(
  row: Record<string, unknown>,
  sideEffects: SideEffectCounters,
): Promise<string> {
  const contract = await guardV1RecommendationPoolProjectWrites(
    {
      query: vi.fn(async () => ({ rows: [row] })),
    },
    scope,
  );
  if (contract.status === "contract_not_applicable") return contract.status;

  sideEffects.ensure += 1;
  sideEffects.refillCommand += 1;
  sideEffects.job += 1;
  sideEffects.outbox += 1;
  sideEffects.reservation += 1;
  sideEffects.providerLedger += 1;
  sideEffects.providerCall += 1;
  return contract.status;
}

describe("recommendation pool V1 runtime guards", () => {

  it.each([
    {
      name: "V2",
      row: {
        poolContractVersion: recommendationPoolContractVersions.v2,
        migrationState: "V2_ACTIVE",
        v1WritesFrozen: false,
      },
    },
    {
      name: "V1 writes frozen",
      row: {
        poolContractVersion: recommendationPoolContractVersions.v1,
        migrationState: "V1_ACTIVE",
        v1WritesFrozen: true,
      },
    },
    {
      name: "non V1-active",
      row: {
        poolContractVersion: recommendationPoolContractVersions.v1,
        migrationState: "MIGRATING",
        v1WritesFrozen: false,
      },
    },
  ])(
    "$name leaves the guard-model post-guard counters unchanged",
    async ({ row }) => {
      for (const entrypoint of ["periodic", "project-analysis"]) {
        const sideEffects = emptySideEffectCounters();
        await expect(runGuardedV1Entry(row, sideEffects)).resolves.toBe(
          "contract_not_applicable",
        );
        expect(sideEffects).toEqual(emptySideEffectCounters());
        expect(entrypoint).toBeTruthy();
      }
    },
  );

  it("allows one V1 write sequence in the guard model", async () => {
    const row = {
      poolContractVersion: recommendationPoolContractVersions.v1,
      migrationState: "V1_ACTIVE",
      v1WritesFrozen: false,
    };

    for (const entrypoint of ["periodic", "project-analysis"]) {
      const sideEffects = emptySideEffectCounters();
      await expect(runGuardedV1Entry(row, sideEffects)).resolves.toBe(
        "applicable",
      );
      expect(sideEffects).toEqual({
        ensure: 1,
        refillCommand: 1,
        job: 1,
        outbox: 1,
        reservation: 1,
        providerLedger: 1,
        providerCall: 1,
      });
      expect(entrypoint).toBeTruthy();
    }
  });

  it("fails closed without V1 writes when the contract query fails", async () => {
    const sideEffects = emptySideEffectCounters();
    const client = {
      query: vi.fn(async () => {
        throw new Error("contract query unavailable");
      }),
    };

    await expect(
      guardV1RecommendationPoolProjectWrites(client, scope),
    ).rejects.toThrow("contract query unavailable");
    expect(sideEffects).toEqual(emptySideEffectCounters());
  });
});
