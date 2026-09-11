import { describe, expect, it, vi } from "vitest";

import type { BacklinksRuntimeFactoryContext } from "../../src/index.js";
import { recommendationPoolContractNotApplicable } from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-contract-guard.js";
import { runtime } from "../../src/modules/backlinks/runtime/production-runtime.js";
import {
  runBacklinkRecommendationRefillWorkflow,
  type BacklinkRecommendationRefillActivities,
  type BacklinkRecommendationRefillInput,
} from "../../src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.js";

const input: BacklinkRecommendationRefillInput = Object.freeze({
  organizationId: "018f0000-0000-7000-8000-000000000101",
  workspaceId: "018f0000-0000-7000-8000-000000000102",
  websiteProjectId: "018f0000-0000-7000-8000-000000000103",
  recommendationContextVersionId: "018f0000-0000-7000-8000-000000000104",
  visiblePoolGeneration: 1,
  jobId: "018f0000-0000-7000-8000-000000000105",
  workflowId: "backlinks/recommendation-refill/guard-test",
  correlationId: "correlation-guard-test",
  actorId: "worker-guard-test",
  refillWindowKey: "2026-08-30T00:00Z/15m",
  lowWatermark: 9,
  highWatermark: 10,
});

const disabledProviderEnvironment = {
  GOOGLE_OAUTH_ENABLED: "false",
  PLATFORM_SECRET_STORE_ENABLED: "false",
  GMAIL_SEND_ENABLED: "false",
  GMAIL_SYNC_ENABLED: "false",
  DATAFORSEO_ENABLED: "false",
  AI_PROVIDER_ENABLED: "false",
  BROWSER_PROVIDER_ENABLED: "false",
} as const;

function runtimeContext(
  projectContract: Readonly<{
    poolContractVersion: "recommendation-pool.v1" | "recommendation-pool.v2";
    migrationState: string;
    v1WritesFrozen: boolean;
  }>,
  options: Readonly<{
    failContractQuery?: boolean;
    process?: "api" | "worker";
  }> = {},
): Readonly<{
  context: BacklinksRuntimeFactoryContext;
  domainWriteSql: readonly string[];
}> {
  const domainWriteSql: string[] = [];
  const query = async (text: string) => {
    if (text.includes("recommendation_pool_contract_guard:project_writes")) {
      if (options.failContractQuery === true) {
        throw new Error("CONTRACT_QUERY_FAILED");
      }
      return { rows: [projectContract], rowCount: 1 };
    }
    if (/\b(?:INSERT\s+INTO|UPDATE\s+backlink_|DELETE\s+FROM)\b/i.test(text)) {
      domainWriteSql.push(text);
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({
      query,
      release() {},
    }),
    async end() {},
  };
  return {
    context: {
      process: options.process ?? "worker",
      pool,
      temporal: {} as BacklinksRuntimeFactoryContext["temporal"],
      buildIdentity: {
        schemaVersion: "growthos.local-product-build.v1",
        buildId: "recommendation-pool-v1-activity-guard-test",
        sourceFingerprint: "a".repeat(64),
        artifactFingerprint: "b".repeat(64),
        builtAt: "2026-08-29T00:00:00.000Z",
      },
    },
    domainWriteSql,
  };
}

function activities(): {
  readonly value: BacklinkRecommendationRefillActivities;
  readonly reserve: ReturnType<typeof vi.fn>;
  readonly plan: ReturnType<typeof vi.fn>;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly store: ReturnType<typeof vi.fn>;
  readonly complete: ReturnType<typeof vi.fn>;
  readonly recordFailure: ReturnType<typeof vi.fn>;
} {
  const reserve = vi.fn(async () =>
    Object.freeze({
      status: "started" as const,
      readyCount: 0,
      jobId: input.jobId,
    }),
  );
  const plan = vi.fn(async () =>
    Object.freeze({
      status: "execute" as const,
      source: "paid" as const,
      refillWindowKey: input.refillWindowKey,
      refillTier: "exact_product_target_market" as const,
      refillRound: 1,
      refillWindow: 1,
      requestedCandidateCount: 10,
    }),
  );
  const execute = vi.fn(async () => recommendationPoolContractNotApplicable);
  const store = vi.fn(async () => Object.freeze({ addedCount: 0 }));
  const complete = vi.fn(async () => undefined);
  const recordFailure = vi.fn(async () =>
    Object.freeze({
      status: "failed" as const,
    }),
  );
  const value: BacklinkRecommendationRefillActivities = {
    reserveRecommendationRefill: reserve,
    planRecommendationRefillSupply: plan,
    executeRecommendationRefill: execute,
    storeReadyRecommendations: store,
    completeRecommendationRefillSupply: complete,
    completeRecommendationRefillSupersession: vi.fn(async () =>
      Object.freeze({
        status: "no_change" as const,
        replayed: false,
      }),
    ),
    waitForRecommendationRefillRetry: vi.fn(async () => undefined),
    recordRecommendationRefillFailure: recordFailure,
  };
  return {
    value,
    reserve,
    plan,
    execute,
    store,
    complete,
    recordFailure,
  };
}

describe("V1 recommendation refill activity contract guards", () => {
  it.each([
    { poolContractVersion: "recommendation-pool.v2" as const, migrationState: "V2_ACTIVE", v1WritesFrozen: false },
    { poolContractVersion: "recommendation-pool.v1" as const, migrationState: "V1_ACTIVE", v1WritesFrozen: true },
    { poolContractVersion: "recommendation-pool.v1" as const, migrationState: "V1_ACTIVE", v1WritesFrozen: false },
    { poolContractVersion: "recommendation-pool.v1" as const, migrationState: "MIGRATION_BLOCKED", v1WritesFrozen: false },
  ])("does not register V1 commands or activities for $migrationState with freeze=$v1WritesFrozen", async (contract) => {
    Object.assign(process.env, disabledProviderEnvironment);
    const apiFixture = runtimeContext(contract, { process: "api" });
    const api = await runtime.createApiDependencies?.(apiFixture.context);
    expect(api).not.toHaveProperty("recommendationCommands");
    const workerFixture = runtimeContext(contract, { failContractQuery: true });
    const worker = await runtime.createWorkerRegistrations?.(workerFixture.context);
    expect(worker).toBeDefined();
    for (const name of [
      "backlinksReserveRecommendationRefillV1",
      "backlinksExecuteRecommendationRefillV1",
      "backlinksStoreReadyRecommendationsV1",
      "backlinksPlanRecommendationRefillSupplyV1",
      "backlinksCompleteRecommendationRefillSupplyV1",
      "backlinksCompleteRecommendationRefillSupersessionV1",
      "backlinksRecordRecommendationRefillFailureV1",
    ]) expect(worker?.activities).not.toHaveProperty(name);
    expect(worker?.activities.backlinksExecuteRecommendationPoolV2DiscoveryRound).toBeTypeOf("function");
    expect(apiFixture.domainWriteSql).toEqual([]);
    expect(workerFixture.domainWriteSql).toEqual([]);
  });

  it("returns contract_not_applicable from reservation without workflow writes", async () => {
    const fake = activities();
    fake.reserve.mockResolvedValue(recommendationPoolContractNotApplicable);

    await expect(
      runBacklinkRecommendationRefillWorkflow(input, fake.value),
    ).resolves.toEqual(recommendationPoolContractNotApplicable);

    expect(fake.plan).not.toHaveBeenCalled();
    expect(fake.execute).not.toHaveBeenCalled();
    expect(fake.store).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
    expect(fake.recordFailure).not.toHaveBeenCalled();
  });

  it("returns contract_not_applicable from execution without store or failure facts", async () => {
    const fake = activities();

    await expect(
      runBacklinkRecommendationRefillWorkflow(input, fake.value),
    ).resolves.toEqual(recommendationPoolContractNotApplicable);

    expect(fake.reserve).toHaveBeenCalledOnce();
    expect(fake.plan).toHaveBeenCalledOnce();
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(fake.store).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
    expect(fake.recordFailure).not.toHaveBeenCalled();
  });
});
