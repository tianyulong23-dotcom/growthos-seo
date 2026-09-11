import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRecommendationPoolV2DiscoveryFinalizer,
  type RecommendationPoolV2ProposedRound2Path,
} from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-discovery-finalizer.service.js";
import { createProviderBudgetRepository } from "../../../src/modules/backlinks/db/repositories/provider-budget.repository.js";
import {
  createRecommendationPoolV2DiscoveryLedgerRepository,
  type RecommendationDiscoveryGenerationLineage,
  type RecommendationDiscoveryRequestIntentInput,
} from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-discovery-ledger.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor } from "../../../src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = {
  rows: Record<string, unknown>[];
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type Pool = BacklinkTenantPool & Readonly<{ end(): Promise<void> }>;
type DeploymentManifest = Readonly<{
  heads: Readonly<{ backlinks: string }>;
  steps: readonly Readonly<{
    migrationId: string;
  }>[];
}>;

type GenerationFixture = RecommendationDiscoveryGenerationLineage &
  Readonly<{
    seedId: string;
    seedFingerprint: string;
  }>;

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => Pool;
};
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);

const organizationId = "98000000-0000-4000-8000-000000000001";
const workspaceId = "98000000-0000-4000-8000-000000000002";
const websiteProjectId = "98000000-0000-4000-8000-000000000003";
const otherProjectId = "98000000-0000-4000-8000-000000000004";
const outreachProfileId = "98000000-0000-4000-8000-000000000005";
const inputPinId = "98000000-0000-4000-8000-000000000006";
const inputFingerprint = createHash("sha256")
  .update("phase3-b4-input-pin")
  .digest("hex");
const policyVersion = "recommendation-discovery-budget.v1";
const startedAt = "2026-08-29T00:00:00.000Z";
const finishedAt = "2026-08-29T00:01:00.000Z";
const completedAt = "2026-08-29T00:02:00.000Z";
const createdBy = "phase3-b4-repository-test";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuid = (group: number, ordinal: number) =>
  `98000000-0000-4000-${group.toString().padStart(4, "0")}-${ordinal
    .toString()
    .padStart(12, "0")}`;

describe("recommendation pool V2 discovery ledger repository", () => {
  let harness: BacklinksPostgresHarness;
  let admin: Client;
  let pool: Pool;
  let repository: ReturnType<
    typeof createRecommendationPoolV2DiscoveryLedgerRepository
  >;
  let finalizer: ReturnType<
    typeof createRecommendationPoolV2DiscoveryFinalizer
  >;
  const generations = new Map<number, GenerationFixture>();
  let providerOrdinal = 0;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();

    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    const migrationSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-") &&
        migrationId !== "backlinks-0001",
    );
    const manifestHeadStep = migrationSteps.at(-1);
    expect(manifestHeadStep).toBeDefined();
    expect(manifest.heads.backlinks).toBe(
      manifestHeadStep?.migrationId.replace(/^backlinks-/, ""),
    );
    await installBacklinksManifestAfterFoundation(admin, "0097");

    await insertProjectInputs();
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      const sharedContextVersionId =
        ordinal === 19
          ? generations.get(18)?.recommendationContextVersionId
          : undefined;
      generations.set(
        ordinal,
        await insertGeneration(ordinal, sharedContextVersionId),
      );
    }
    pool = new PgPool({
      connectionString: harness.connectionString,
      max: 8,
    });
    repository = createRecommendationPoolV2DiscoveryLedgerRepository(pool);
    finalizer = createRecommendationPoolV2DiscoveryFinalizer(repository);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
    await harness?.stop();
  });

  async function insertProjectInputs(): Promise<void> {
    await admin.query(
      `INSERT INTO backlinks.backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, 'profile-v1', 'target-v1',
         '["topic"]'::jsonb, '["product"]'::jsonb, '[]'::jsonb,
         '["audience"]'::jsonb, '["editorial review"]'::jsonb,
         'US', 'United States', 'en', '["dataforseo"]'::jsonb,
         'phase3-b4-profile-v1', $5
       )`,
      [
        outreachProfileId,
        organizationId,
        workspaceId,
        websiteProjectId,
        createdBy,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_generation_input_pins (
         id, organization_id, workspace_id, website_project_id,
         project_context_version, site_profile_version_id,
         outreach_profile_version_id, promotion_target_version_id,
         keyword_evidence_snapshot_ids, shared_evidence_snapshot_ids,
         market, qualification_contract_version, immutable_fingerprint,
         created_by
       ) VALUES (
         $1, $2, $3, $4, 9, 'site-profile-v1', $5, 'target-v1',
         '[]'::jsonb, '[]'::jsonb, 'US',
          'recommendation-pool-admission.v2', $6, $7
       )`,
      [
        inputPinId,
        organizationId,
        workspaceId,
        websiteProjectId,
        outreachProfileId,
        inputFingerprint,
        createdBy,
      ],
    );
  }

  async function insertGeneration(
    ordinal: number,
    recommendationContextVersionId = uuid(4200, ordinal),
    locale = "en",
  ): Promise<GenerationFixture> {
    const fixture = Object.freeze({
      organizationId,
      workspaceId,
      websiteProjectId,
      generationContractId: uuid(4100, ordinal),
      recommendationContextVersionId,
      visiblePoolGeneration: ordinal,
      inputPinId,
      seedId: uuid(4300, ordinal),
      seedFingerprint: `phase3-b4-seed-${ordinal}`,
      discoveryBudgetPolicyVersion: policyVersion,
    });
    await admin.query(
      `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, qualification_contract_version,
         visibility_contract_version, score_model_version, metric_scope,
         market, location, language, traffic_location_code,
         traffic_language_code, request_fingerprints,
         creator_worker_contract_version, created_by,
         pool_contract_version, seed_contract_version,
         release_contract_version, recommendation_marker_version,
         discovery_budget_policy_version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
          'recommendation-pool-admission.v2',
          'recommendation-pool-release-visibility.v2',
          'recommendation-pool-materialization.v2', 'TARGET_MARKET',
         'US', 'United States', $10, 2840, 'en', '{}'::jsonb,
          'recommendation-pool-worker.v2', $8,
         'recommendation-pool.v2', 'recommendation-seed.v2',
         'recommendation-release.v2', 'recommendation-marker.v2', $9
       )`,
      [
        fixture.generationContractId,
        fixture.organizationId,
        fixture.workspaceId,
        fixture.websiteProjectId,
        fixture.recommendationContextVersionId,
        fixture.visiblePoolGeneration,
        fixture.inputPinId,
        createdBy,
        fixture.discoveryBudgetPolicyVersion,
        locale,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_seeds (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, seed_kind, raw_value,
         normalized_value, source, validation_status, confidence_band,
         seed_fingerprint, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'KEYWORD', $9, $10,
         'USER_INPUT', 'VERIFIED', 'HIGH', $11, $12
       )`,
      [
        fixture.seedId,
        fixture.organizationId,
        fixture.workspaceId,
        fixture.websiteProjectId,
        fixture.generationContractId,
        fixture.recommendationContextVersionId,
        fixture.visiblePoolGeneration,
        fixture.inputPinId,
        `Technical SEO ${ordinal}`,
        `technical seo ${ordinal}`,
        fixture.seedFingerprint,
        createdBy,
      ],
    );
    return fixture;
  }

  function generation(ordinal: number): GenerationFixture {
    const fixture = generations.get(ordinal);
    if (fixture === undefined) {
      throw new Error(`Missing generation fixture ${ordinal}.`);
    }
    return fixture;
  }

  function requestIntent(
    fixture: GenerationFixture,
    ordinal: number,
    overrides: Partial<RecommendationDiscoveryRequestIntentInput> = {},
  ): RecommendationDiscoveryRequestIntentInput {
    return {
      ...fixture,
      id: uuid(5000, ordinal),
      seedId: fixture.seedId,
      seedFingerprint: fixture.seedFingerprint,
      seedKind: "KEYWORD",
      seedSource: "USER_INPUT",
      roundNumber: 1,
      discoveryWindowOrdinal: 1,
      discoverySource: "dataforseo",
      requestType: "SERP_BACKLINKS",
      pageType: "RESULT_PAGE",
      pageOrdinal: 0,
      canonicalRequestFingerprint: hash(`request-${ordinal}`),
      canonicalPathFingerprint: hash(`path-${ordinal}`),
      countryCode: "US",
      languageCode: "en",
      businessDirectionFingerprint: inputFingerprint,
      authorizedCostMicros: 0,
      idempotencyKey: `phase3-b4-${ordinal}`,
      idempotencyHash: hash(`idempotency-${ordinal}`),
      startedAt,
      createdBy,
      ...overrides,
    };
  }

  async function insertProviderLineage(input: {
    intent: Readonly<{
      id: string;
      idempotencyKey: string;
      canonicalRequestFingerprint: string;
      languageCode: string;
    }>;
    chargeState: "SETTLED" | "UNKNOWN_CHARGE";
    actualCostMicros: number | null;
    authorizedCostMicros: number;
  }): Promise<{
    providerRequestId: string;
    providerBatchRequestId: string;
    providerUsageLedgerId: string;
    providerTaskId: string;
  }> {
    providerOrdinal += 1;
    const ordinal = providerOrdinal;
    const providerRequestId = uuid(6100, ordinal);
    const providerBatchRequestId = providerRequestId;
    const providerUsageLedgerId = uuid(6300, ordinal);
    const budgetId = uuid(6400, ordinal);
    const providerTaskId = `phase3-b4-task-${ordinal}`;
    const unknown = input.chargeState === "UNKNOWN_CHARGE";
    const periodStart = `2026-08-${ordinal
      .toString()
      .padStart(2, "0")}T00:00:00Z`;
    const periodEnd = `2026-08-${(ordinal + 1)
      .toString()
      .padStart(2, "0")}T00:00:00Z`;

    await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      async (transaction) => {
        await transaction.query(
          `INSERT INTO backlinks.provider_batch_requests (
         id, organization_id, workspace_id, website_project_id,
         provider, endpoint, request_intent, refresh_mode, location_code,
         language_code, request_schema_version, response_schema_version,
         normalized_request_hash, request_count, succeeded_count,
         estimated_cost_micros, actual_cost_micros, provider_task_id,
         result_summary, status, failure_code, started_at, finished_at,
         request_id, budget_reservation_id, created_by
       ) VALUES (
         $1, $2, $3, $4, 'dataforseo', 'fixture/discovery', 'DISCOVERY',
         'FORCE_LIVE', '2840', 'en', 1, 'fixture.v1', $5, 1, $6, $7,
         $8, $9, '[]'::jsonb, $10, $11, $12, $13, $14, $15, $16
       )`,
          [
            providerBatchRequestId,
            organizationId,
            workspaceId,
            websiteProjectId,
            input.intent.canonicalRequestFingerprint,
            unknown ? 0 : 1,
            input.authorizedCostMicros,
            input.actualCostMicros,
            providerTaskId,
            unknown ? "unknown_charge" : "succeeded",
            unknown ? "UNKNOWN_CHARGE" : null,
            startedAt,
            finishedAt,
            input.intent.id,
            input.intent.id,
            input.intent.id,
          ],
        );
        await transaction.query(
          `INSERT INTO backlinks.backlink_provider_requests (
         id, organization_id, workspace_id, website_project_id,
         provider, endpoint, request_fingerprint, active_request_bucket,
         request_schema_version, request_payload, status, started_at,
         finished_at, created_by
       ) VALUES (
         $1, $2, $3, $4, 'dataforseo', 'fixture/discovery', $5,
         $1::uuid::text, 1, '{"requestIntent":"DISCOVERY"}'::jsonb,
         $6, $7, $8, $9
       )`,
          [
            providerRequestId,
            organizationId,
            workspaceId,
            websiteProjectId,
            input.intent.canonicalRequestFingerprint,
            unknown ? "unknown_charge" : "succeeded",
            startedAt,
            finishedAt,
            input.intent.id,
          ],
        );
        await transaction.query(
          `INSERT INTO backlinks.backlink_provider_budgets (
         id, organization_id, workspace_id, provider, period_start, period_end,
         limit_micros, spent_micros, reserved_micros, created_by
       ) VALUES (
         $1, $2, $3, 'dataforseo', $4, $5, 2000000, 0, $6, $7
       )`,
          [
            budgetId,
            organizationId,
            workspaceId,
            periodStart,
            periodEnd,
            unknown ? input.authorizedCostMicros : 0,
            createdBy,
          ],
        );
        await transaction.query(
          `INSERT INTO backlinks.backlink_provider_usage_ledger (
         id, organization_id, workspace_id, website_project_id, budget_id,
         provider_request_id, provider, reservation_key,
         estimated_cost_micros, actual_cost_micros, status, settled_at,
         created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'dataforseo', $7, $8, $9, $10, $11, $12
       )`,
          [
            providerUsageLedgerId,
            organizationId,
            workspaceId,
            websiteProjectId,
            budgetId,
            providerRequestId,
            input.intent.id,
            input.authorizedCostMicros,
            input.actualCostMicros,
            unknown ? "reserved" : "settled",
            unknown ? null : finishedAt,
            createdBy,
          ],
        );
      },
    );

    return {
      providerRequestId,
      providerBatchRequestId,
      providerUsageLedgerId,
      providerTaskId,
    };
  }

  async function completeRequest(input: {
    fixture: GenerationFixture;
    ordinal: number;
    roundNumber?: 1 | 2;
    windowOrdinal?: number;
    authorizedCostMicros?: number;
    actualCostMicros?: number | null;
    cumulativeCostMicros?: number | null;
    rawCount: number;
    effectiveCount: number;
    newCount: number;
    duplicateCount: number;
    chargeState?: "SETTLED" | "UNKNOWN_CHARGE";
    changedPath?: boolean;
    intentOverrides?: Partial<RecommendationDiscoveryRequestIntentInput>;
  }) {
    const chargeState = input.chargeState ?? "SETTLED";
    const authorizedCostMicros = input.authorizedCostMicros ?? 0;
    const actualCostMicros =
      input.actualCostMicros ?? (chargeState === "SETTLED" ? 0 : null);
    const intent = await repository.recordRequestIntent(
      requestIntent(input.fixture, input.ordinal, {
        roundNumber: input.roundNumber ?? 1,
        discoveryWindowOrdinal: input.windowOrdinal ?? 1,
        authorizedCostMicros,
        canonicalPathFingerprint: hash(
          `${input.changedPath ? "changed" : "path"}-${input.ordinal}`,
        ),
        ...input.intentOverrides,
      }),
    );
    const provider = await insertProviderLineage({
      intent,
      chargeState,
      actualCostMicros,
      authorizedCostMicros,
    });
    const outcome = await repository.recordRequestOutcome({
      ...input.fixture,
      id: uuid(5100, input.ordinal),
      requestIntentId: intent.id,
      ...provider,
      rawCandidateCount: input.rawCount,
      effectiveCandidateCount: input.effectiveCount,
      newUniqueCount: input.newCount,
      duplicateCount: input.duplicateCount,
      actualCostMicros,
      cumulativeCostMicros:
        input.cumulativeCostMicros ??
        (chargeState === "SETTLED" ? actualCostMicros : null),
      status: chargeState === "SETTLED" ? "SUCCEEDED" : "UNKNOWN_CHARGE",
      chargeState,
      failureCode: chargeState === "SETTLED" ? null : "UNKNOWN_CHARGE",
      finishedAt,
      createdBy,
    });
    return { intent, outcome };
  }

  async function recordWindow(input: {
    fixture: GenerationFixture;
    ordinal: number;
    roundNumber: 1 | 2;
    completedRequestCount?: number;
    rawCount: number;
    effectiveCount: number;
    newCount: number;
    duplicateCount: number;
    authorizedCostMicros?: number;
    settledCostMicros?: number | null;
    chargeState?: "SETTLED" | "UNKNOWN_CHARGE";
  }) {
    return repository.recordWindowFact({
      ...input.fixture,
      id: uuid(5200, input.fixture.visiblePoolGeneration * 100 + input.ordinal),
      roundNumber: input.roundNumber,
      windowOrdinal: input.ordinal,
      completedRequestCount: input.completedRequestCount ?? 1,
      rawCandidateCount: input.rawCount,
      effectiveCandidateCount: input.effectiveCount,
      newUniqueCount: input.newCount,
      duplicateCount: input.duplicateCount,
      newUniqueRateNumerator: input.newCount,
      newUniqueRateDenominator: input.effectiveCount,
      windowAuthorizedCostMicros: input.authorizedCostMicros ?? 0,
      windowSettledCostMicros:
        input.settledCostMicros ??
        ((input.chargeState ?? "SETTLED") === "SETTLED" ? 0 : null),
      chargeState: input.chargeState ?? "SETTLED",
      canonicalRequestSetFingerprint: hash(
        `window-request-set-${input.fixture.visiblePoolGeneration}-${input.ordinal}`,
      ),
      completedAt,
      createdBy,
    });
  }

  it("replays a completed round from PostgreSQL facts without Provider calls or writes", async () => {
    const fixture = generation(20);
    await completeRequest({
      fixture,
      ordinal: 2000,
      rawCount: 0,
      effectiveCount: 0,
      newCount: 0,
      duplicateCount: 0,
    });
    await recordWindow({
      fixture,
      ordinal: 1,
      roundNumber: 1,
      rawCount: 0,
      effectiveCount: 0,
      newCount: 0,
      duplicateCount: 0,
    });
    await repository.recordRoundFact({
      ...fixture,
      id: uuid(5300, 2000),
      roundNumber: 1,
      completedWindowCount: 1,
      completedRequestCount: 1,
      rawCandidateCount: 0,
      effectiveCandidateCount: 0,
      newUniqueCount: 0,
      duplicateCount: 0,
      newUniqueRateNumerator: 0,
      newUniqueRateDenominator: 0,
      roundAuthorizedCostMicros: 0,
      roundSettledCostMicros: 0,
      cumulativeSettledCostMicros: 0,
      chargeState: "SETTLED",
      pathsExhausted: false,
      changedDimensions: [],
      canonicalRequestSetFingerprint: hash("round-set-2000"),
      policyDecision: "START_ROUND_2",
      terminalReason: null,
      completedAt,
      createdBy,
    });

    const counts = async () =>
      (
        await admin.query(
          `SELECT
             (
               SELECT count(*)::integer
                 FROM backlinks
                        .backlink_recommendation_discovery_request_intents
                WHERE generation_contract_id=$1
             ) AS "requestIntents",
             (
               SELECT count(*)::integer
                 FROM backlinks
                        .backlink_recommendation_discovery_request_outcomes
                WHERE generation_contract_id=$1
             ) AS "requestOutcomes",
             (
               SELECT count(*)::integer
                 FROM backlinks
                        .backlink_recommendation_discovery_window_facts
                WHERE generation_contract_id=$1
             ) AS "windowFacts",
             (
               SELECT count(*)::integer
                 FROM backlinks
                        .backlink_recommendation_discovery_round_facts
                WHERE generation_contract_id=$1
             ) AS "roundFacts"`,
          [fixture.generationContractId],
        )
      ).rows[0];
    const before = await counts();
    const executor = createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor(
      {
        pool,
        runtime: null,
      },
    );

    await expect(
      executor.execute({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        websiteProjectId: fixture.websiteProjectId,
        generationContractId: fixture.generationContractId,
        recommendationContextVersionId: fixture.recommendationContextVersionId,
        visiblePoolGeneration: fixture.visiblePoolGeneration,
        inputPinId: fixture.inputPinId,
        jobId: uuid(5500, 2000),
        workflowId: "recommendation-pool-v2-postgresql-replay-2000",
        actorId: uuid(5600, 2000),
        round: 1,
        requestFingerprint: "round-1-postgresql-replay-2000",
        idempotencyKey: "generation-20:round:1",
        maxCostMicros: 1_000_000,
      }),
    ).resolves.toMatchObject({
      round: 1,
      requestFingerprint: "round-1-postgresql-replay-2000",
      chargeState: "settled",
      costMicros: 0,
      totalUniqueCandidateCount: 0,
      pathsExhausted: false,
      completedWindows: [
        {
          completed: true,
          rawCandidateCount: 0,
          canonicalCandidateCount: 0,
          newUniqueCount: 0,
          admittedCount: 0,
          hardExcludedCount: 0,
        },
      ],
    });
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("maps complete request facts and makes exact or concurrent replay idempotent", async () => {
    const fixture = generation(1);
    const input = requestIntent(fixture, 1, {
      authorizedCostMicros: 400_000,
    });
    const first = await repository.recordRequestIntent(input);
    expect(first).toMatchObject({
      id: input.id,
      generationContractId: fixture.generationContractId,
      seedId: fixture.seedId,
      canonicalRequestFingerprint: input.canonicalRequestFingerprint,
      authorizedCostMicros: 400_000,
      startedAt,
    });

    const replay = await repository.recordRequestIntent({
      ...input,
      id: uuid(5000, 101),
    });
    expect(replay).toEqual(first);
    await expect(
      repository.recordRequestIntent({
        ...input,
        id: uuid(5000, 102),
        authorizedCostMicros: 399_999,
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });

    const concurrentInput = requestIntent(fixture, 2, {
      authorizedCostMicros: 100_000,
    });
    const concurrent = await Promise.all([
      repository.recordRequestIntent(concurrentInput),
      repository.recordRequestIntent({
        ...concurrentInput,
        id: uuid(5000, 103),
      }),
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect(
      (
        await admin.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_recommendation_discovery_request_intents
            WHERE generation_contract_id=$1 AND idempotency_key=$2`,
          [fixture.generationContractId, concurrentInput.idempotencyKey],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    await expect(
      repository.recordRequestIntent({
        ...requestIntent(fixture, 3),
        websiteProjectId: otherProjectId,
      }),
    ).rejects.toThrow(/lineage|generation|scope|not found/i);
    await expect(
      repository.recordRequestIntent({
        ...requestIntent(fixture, 4),
        canonicalRequestFingerprint: first.canonicalRequestFingerprint,
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await expect(
      repository.recordRequestIntent({
        ...requestIntent(fixture, 5),
        canonicalPathFingerprint: first.canonicalPathFingerprint,
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  }, 30_000);

  it.each([
    [21, "pt-BR", "pt"],
    [22, "en-US", "en"],
  ] as const)("normalizes pinned locale %s without admitting a different provider language", async (ordinal, locale, languageCode) => {
    const fixture = await insertGeneration(ordinal, undefined, locale);
    const input = requestIntent(fixture, ordinal * 100, { languageCode });
    await expect(repository.recordRequestIntent({
      ...input, languageCode: "fr",
    })).rejects.toThrow("differs from its pinned generation facts");
    const intent = await repository.recordRequestIntent(input);
    expect(intent.languageCode).toBe(languageCode);
    const result = await withBacklinkTenantTransaction(pool, fixture, (client) =>
      client.query(
        `SELECT backlinks.backlink_phase9_provider_batch_is_allowed($1::jsonb) AS allowed`,
        [JSON.stringify({
          organization_id: organizationId, workspace_id: workspaceId,
          website_project_id: websiteProjectId, provider: "dataforseo",
          request_intent: "DISCOVERY",
          normalized_request_hash: intent.canonicalRequestFingerprint,
          language_code: languageCode, estimated_cost_micros: 0,
          request_id: intent.id, budget_reservation_id: intent.id, created_by: intent.id,
        })],
      ),
    );
    expect(result.rows).toEqual([{ allowed: true }]);
  });

  it("reserves a bounded native V2 provider request by its exact persisted intent identity", async () => {
    const fixture = generation(17);
    const observedAt = new Date(startedAt);
    const estimatedCostMicros = 27_600;
    const intent = await repository.recordRequestIntent(
      requestIntent(fixture, 170, {
        authorizedCostMicros: estimatedCostMicros,
      }),
    );
    const providerBatchRequestId = uuid(6200, 170);
    await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      async (transaction) => {
        await transaction.query(
          "SET LOCAL search_path = backlinks, pg_catalog",
        );
        const classification = await transaction.query(
          `SELECT
         backlink_phase9_provider_batch_is_allowed(
           jsonb_build_object(
             'organization_id', $1::text,
             'workspace_id', $2::text,
             'website_project_id', $3::text,
             'provider', 'dataforseo',
             'request_intent', 'DISCOVERY',
             'normalized_request_hash', $4::text,
             'language_code', 'en',
             'estimated_cost_micros', $5::bigint,
             'request_id', $6::text,
             'budget_reservation_id', $6::text,
             'created_by', $6::text
           )
         ) AS "allowed",
         EXISTS (
           SELECT 1
             FROM backlink_recommendation_discovery_request_intents candidate
            WHERE candidate.organization_id=$1::uuid
              AND candidate.workspace_id=$2::uuid
              AND candidate.website_project_id=$3::uuid
              AND candidate.pool_contract_version='recommendation-pool.v2'
              AND candidate.canonical_request_fingerprint=$4
              AND candidate.language_code='en'
              AND $5::bigint <= candidate.authorized_cost_micros
              AND $6::text IN (candidate.id::text, candidate.idempotency_key)
         ) AS "intentMatches"`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            intent.canonicalRequestFingerprint,
            estimatedCostMicros,
            intent.id,
          ],
        );
        expect(classification.rows).toEqual([
          { allowed: true, intentMatches: true },
        ]);
        await transaction.query(
          `INSERT INTO backlinks.provider_batch_requests (
         id, organization_id, workspace_id, website_project_id,
         provider, endpoint, request_intent, refresh_mode, location_code,
         language_code, request_schema_version, response_schema_version,
         normalized_request_hash, request_count, estimated_cost_micros,
         status, started_at, request_id, budget_reservation_id, created_by
       ) VALUES (
         $1, $2, $3, $4, 'dataforseo', 'fixture/native-v2-discovery',
         'DISCOVERY', 'FORCE_LIVE', '2840', 'en', 1, 'fixture.v1',
         $5, 1, $6, 'running', $7, $8, $8, $8
       )`,
          [
            providerBatchRequestId,
            organizationId,
            workspaceId,
            websiteProjectId,
            intent.canonicalRequestFingerprint,
            estimatedCostMicros,
            observedAt,
            intent.id,
          ],
        );

        const providerBudget = createProviderBudgetRepository(
          transaction,
          () => observedAt,
        );
        const reservation = {
          context: {
            organizationId,
            workspaceId,
            websiteProjectId,
            requestId: intent.id,
            idempotencyKey: intent.idempotencyKey,
            budgetReservationId: intent.id,
          },
          provider: "dataforseo" as const,
          requestFingerprint: intent.canonicalRequestFingerprint,
          reservationKey: intent.id,
          estimatedCostMicros,
        };
        await providerBudget.recordRequest({
          batchRequestId: providerBatchRequestId,
          context: reservation.context,
          endpoint: "fixture/native-v2-discovery",
          requestFingerprint: intent.canonicalRequestFingerprint,
          requestSchemaVersion: 1,
          requestPayload: { requestIntent: "DISCOVERY" },
          startedAt: observedAt,
        });

        const reserve = () =>
          providerBudget.reserveBudgetWithinOperationCeiling(
            reservation,
            `commercial-refill-operation:${uuid(7000, 170)}`,
            1,
            1_000_000,
            1_000_000,
            {
              requiredRemainingPaidCalls: 0,
              requiredRemainingCostMicros: 0,
              authorization: {
                provider: "dataforseo",
                reasonCode: "user_authorized_bounded_real_refill",
                maxPaidCalls: 1,
                maxCostMicros: 1_000_000,
                authorizedBy: createdBy,
              },
            },
          );

        await expect(reserve()).resolves.toBe("allow");
        await expect(reserve()).resolves.toBe("allow");
        expect(
          (
            await transaction.query(
              `SELECT count(*)::integer AS count,
                      min(reservation_key) AS "reservationKey",
                      min(estimated_cost_micros)::integer AS "estimatedCostMicros"
                 FROM backlinks.backlink_provider_usage_ledger
                WHERE organization_id=$1
                  AND workspace_id=$2
                  AND website_project_id=$3
                  AND provider_request_id=$4`,
              [
                organizationId,
                workspaceId,
                websiteProjectId,
                providerBatchRequestId,
              ],
            )
          ).rows,
        ).toEqual([
          {
            count: 1,
            reservationKey: intent.id,
            estimatedCostMicros,
          },
        ]);
      },
    );
  }, 30_000);

  it("uses persisted generation locking so concurrent intents cannot exceed one-dollar round budget", async () => {
    const fixture = generation(2);
    const results = await Promise.allSettled([
      repository.recordRequestIntent(
        requestIntent(fixture, 20, { authorizedCostMicros: 600_000 }),
      ),
      repository.recordRequestIntent(
        requestIntent(fixture, 21, { authorizedCostMicros: 600_000 }),
      ),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      (
        await admin.query(
          `SELECT count(*)::integer AS count,
                  sum(authorized_cost_micros)::integer AS cost
             FROM backlinks.backlink_recommendation_discovery_request_intents
            WHERE generation_contract_id=$1`,
          [fixture.generationContractId],
        )
      ).rows,
    ).toEqual([{ count: 1, cost: 600_000 }]);
  }, 30_000);

  it("persists Provider lineage and rejects conflicting outcome replay", async () => {
    const fixture = generation(3);
    const request = await repository.recordRequestIntent(
      requestIntent(fixture, 30, { authorizedCostMicros: 500_000 }),
    );
    const provider = await insertProviderLineage({
      intent: request,
      chargeState: "SETTLED",
      actualCostMicros: 500_000,
      authorizedCostMicros: 500_000,
    });
    const unrelatedRequest = await repository.recordRequestIntent(
      requestIntent(fixture, 31, { authorizedCostMicros: 500_000 }),
    );
    const unrelatedProvider = await insertProviderLineage({
      intent: unrelatedRequest,
      chargeState: "SETTLED",
      actualCostMicros: 500_000,
      authorizedCostMicros: 500_000,
    });
    const input = {
      ...fixture,
      id: uuid(5100, 30),
      requestIntentId: request.id,
      ...provider,
      rawCandidateCount: 12,
      effectiveCandidateCount: 10,
      newUniqueCount: 8,
      duplicateCount: 2,
      actualCostMicros: 500_000,
      cumulativeCostMicros: 500_000,
      status: "SUCCEEDED" as const,
      chargeState: "SETTLED" as const,
      failureCode: null,
      finishedAt,
      createdBy,
    };
    await expect(
      repository.recordRequestOutcome({
        ...input,
        providerUsageLedgerId: unrelatedProvider.providerUsageLedgerId,
      }),
    ).rejects.toThrow(/lineage|Provider request/i);
    const first = await repository.recordRequestOutcome(input);
    expect(first).toMatchObject({
      requestIntentId: request.id,
      providerRequestId: provider.providerRequestId,
      providerBatchRequestId: provider.providerBatchRequestId,
      providerUsageLedgerId: provider.providerUsageLedgerId,
      providerTaskId: provider.providerTaskId,
      newUniqueCount: 8,
      actualCostMicros: 500_000,
    });
    expect(
      await repository.recordRequestOutcome({
        ...input,
        id: uuid(5100, 31),
      }),
    ).toEqual(first);
    await expect(
      repository.recordRequestOutcome({
        ...input,
        id: uuid(5100, 32),
        newUniqueCount: 7,
        duplicateCount: 3,
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  });

  it("replays settled Provider evidence into a new V2 generation at zero cost", async () => {
    const sourceFixture = generation(18);
    const targetFixture = generation(19);
    const requestFingerprint = hash("reusable-provider-evidence");
    const source = await completeRequest({
      fixture: sourceFixture,
      ordinal: 180,
      authorizedCostMicros: 27_600,
      actualCostMicros: 600,
      cumulativeCostMicros: 600,
      rawCount: 9,
      effectiveCount: 4,
      newCount: 4,
      duplicateCount: 0,
      intentOverrides: {
        canonicalRequestFingerprint: requestFingerprint,
      },
    });
    const intent = await repository.recordRequestIntent(
      requestIntent(targetFixture, 190, {
        canonicalRequestFingerprint: requestFingerprint,
        authorizedCostMicros: 0,
      }),
    );
    const replay = await repository.recordRequestOutcome({
      ...targetFixture,
      id: uuid(5100, 190),
      requestIntentId: intent.id,
      acquisitionMode: "EVIDENCE_REPLAY",
      sourceRequestOutcomeId: source.outcome.id,
      providerRequestId: null,
      providerBatchRequestId: null,
      providerUsageLedgerId: null,
      providerTaskId: null,
      rawCandidateCount: 9,
      effectiveCandidateCount: 4,
      newUniqueCount: 4,
      duplicateCount: 0,
      actualCostMicros: 0,
      cumulativeCostMicros: 0,
      status: "SUCCEEDED",
      chargeState: "SETTLED",
      failureCode: null,
      finishedAt,
      createdBy,
    });

    expect(replay).toMatchObject({
      acquisitionMode: "EVIDENCE_REPLAY",
      sourceRequestOutcomeId: source.outcome.id,
      providerRequestId: null,
      providerBatchRequestId: null,
      providerUsageLedgerId: null,
      providerTaskId: null,
      actualCostMicros: 0,
      cumulativeCostMicros: 0,
    });
  });

  it("enforces settled Round 1 lineage before a distinct Round 2 and terminal path exhaustion", async () => {
    const fixture = generation(4);
    await completeRequest({
      fixture,
      ordinal: 40,
      authorizedCostMicros: 1_000_000,
      actualCostMicros: 1_000_000,
      cumulativeCostMicros: 1_000_000,
      rawCount: 80,
      effectiveCount: 70,
      newCount: 60,
      duplicateCount: 10,
    });
    const round1WindowInput = {
      fixture,
      ordinal: 1,
      roundNumber: 1,
      rawCount: 80,
      effectiveCount: 70,
      newCount: 60,
      duplicateCount: 10,
      authorizedCostMicros: 1_000_000,
      settledCostMicros: 1_000_000,
    } as const;
    const round1Window = await recordWindow(round1WindowInput);
    expect(await recordWindow(round1WindowInput)).toEqual(round1Window);
    const round1FactInput = {
      ...fixture,
      id: uuid(5300, 40),
      roundNumber: 1,
      completedWindowCount: 1,
      completedRequestCount: 1,
      rawCandidateCount: 80,
      effectiveCandidateCount: 70,
      newUniqueCount: 60,
      duplicateCount: 10,
      newUniqueRateNumerator: 60,
      newUniqueRateDenominator: 70,
      roundAuthorizedCostMicros: 1_000_000,
      roundSettledCostMicros: 1_000_000,
      cumulativeSettledCostMicros: 1_000_000,
      chargeState: "SETTLED",
      pathsExhausted: false,
      changedDimensions: [],
      canonicalRequestSetFingerprint: hash("round-set-40"),
      policyDecision: "START_ROUND_2",
      terminalReason: null,
      completedAt,
      createdBy,
    } as const;
    const round1Fact = await repository.recordRoundFact(round1FactInput);
    expect(
      await repository.recordRoundFact({
        ...round1FactInput,
        id: uuid(5300, 400),
      }),
    ).toEqual(round1Fact);

    await expect(
      repository.recordRequestIntent(
        requestIntent(fixture, 43, {
          roundNumber: 2,
          discoveryWindowOrdinal: 2,
          authorizedCostMicros: 1_000_001,
          canonicalPathFingerprint: hash("changed-over-budget-43"),
        }),
      ),
    ).rejects.toThrow(/budget|authorization|check constraint/i);
    await expect(
      repository.recordRequestIntent(
        requestIntent(fixture, 44, {
          roundNumber: 2,
          discoveryWindowOrdinal: 2,
          canonicalPathFingerprint: hash("path-40"),
        }),
      ),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });

    const round2 = await completeRequest({
      fixture,
      ordinal: 41,
      roundNumber: 2,
      windowOrdinal: 2,
      authorizedCostMicros: 1_000_000,
      actualCostMicros: 1_000_000,
      cumulativeCostMicros: 2_000_000,
      rawCount: 25,
      effectiveCount: 20,
      newCount: 10,
      duplicateCount: 10,
      changedPath: true,
    });
    expect(round2.intent.roundNumber).toBe(2);
    await expect(
      repository.recordRequestIntent(
        requestIntent(fixture, 42, {
          roundNumber: 2,
          discoveryWindowOrdinal: 2,
          canonicalRequestFingerprint:
            round2.intent.canonicalRequestFingerprint,
          canonicalPathFingerprint: hash("another-path-42"),
        }),
      ),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await recordWindow({
      fixture,
      ordinal: 2,
      roundNumber: 2,
      rawCount: 25,
      effectiveCount: 20,
      newCount: 10,
      duplicateCount: 10,
      authorizedCostMicros: 1_000_000,
      settledCostMicros: 1_000_000,
    });
    const finalRound = await repository.recordRoundFact({
      ...fixture,
      id: uuid(5300, 41),
      roundNumber: 2,
      completedWindowCount: 1,
      completedRequestCount: 1,
      rawCandidateCount: 25,
      effectiveCandidateCount: 20,
      newUniqueCount: 10,
      duplicateCount: 10,
      newUniqueRateNumerator: 10,
      newUniqueRateDenominator: 20,
      roundAuthorizedCostMicros: 1_000_000,
      roundSettledCostMicros: 1_000_000,
      cumulativeSettledCostMicros: 2_000_000,
      chargeState: "SETTLED",
      pathsExhausted: true,
      changedDimensions: ["SOURCE"],
      canonicalRequestSetFingerprint: hash("round-set-41"),
      policyDecision: "STOP",
      terminalReason: "PATHS_EXHAUSTED",
      completedAt,
      createdBy,
    });
    expect(finalRound.terminalReason).toBe("PATHS_EXHAUSTED");
    const terminalInput = {
      ...fixture,
      id: uuid(5400, 40),
      effectiveUniqueCandidateCount: 70,
      terminalReason: "PATHS_EXHAUSTED" as const,
      totalSettledCostMicros: 2_000_000,
      chargeState: "SETTLED" as const,
      completedRoundCount: 2,
      completedWindowCount: 2,
      canonicalRequestSetFingerprint: hash("generation-set-40"),
      completedAt,
      createdBy,
    };
    const terminal = await repository.recordTerminalFact(terminalInput);
    expect(
      await repository.recordTerminalFact({
        ...terminalInput,
        id: uuid(5400, 41),
      }),
    ).toEqual(terminal);
    await expect(
      repository.recordTerminalFact({
        ...terminalInput,
        id: uuid(5400, 42),
        effectiveUniqueCandidateCount: 69,
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await expect(
      admin.query(
        `UPDATE
           backlinks.backlink_recommendation_discovery_generation_terminal_facts
            SET completed_at=completed_at
          WHERE id=$1`,
        [terminal.id],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      admin.query(
        `DELETE FROM
           backlinks.backlink_recommendation_discovery_generation_terminal_facts
          WHERE id=$1`,
        [terminal.id],
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("fails Round 2 closed for unknown charge and records the matching terminal fact", async () => {
    const fixture = generation(5);
    await completeRequest({
      fixture,
      ordinal: 50,
      chargeState: "UNKNOWN_CHARGE",
      authorizedCostMicros: 500_000,
      actualCostMicros: null,
      cumulativeCostMicros: null,
      rawCount: 0,
      effectiveCount: 0,
      newCount: 0,
      duplicateCount: 0,
    });
    await recordWindow({
      fixture,
      ordinal: 1,
      roundNumber: 1,
      rawCount: 0,
      effectiveCount: 0,
      newCount: 0,
      duplicateCount: 0,
      authorizedCostMicros: 500_000,
      settledCostMicros: null,
      chargeState: "UNKNOWN_CHARGE",
    });
    await repository.recordRoundFact({
      ...fixture,
      id: uuid(5300, 50),
      roundNumber: 1,
      completedWindowCount: 1,
      completedRequestCount: 1,
      rawCandidateCount: 0,
      effectiveCandidateCount: 0,
      newUniqueCount: 0,
      duplicateCount: 0,
      newUniqueRateNumerator: 0,
      newUniqueRateDenominator: 0,
      roundAuthorizedCostMicros: 500_000,
      roundSettledCostMicros: null,
      cumulativeSettledCostMicros: null,
      chargeState: "UNKNOWN_CHARGE",
      pathsExhausted: false,
      changedDimensions: [],
      canonicalRequestSetFingerprint: hash("round-set-50"),
      policyDecision: "STOP",
      terminalReason: "UNKNOWN_CHARGE",
      completedAt,
      createdBy,
    });
    await expect(
      repository.recordRequestIntent(
        requestIntent(fixture, 51, {
          roundNumber: 2,
          discoveryWindowOrdinal: 2,
        }),
      ),
    ).rejects.toThrow(/settled Round 1|Round 2/i);
    const terminal = await repository.recordTerminalFact({
      ...fixture,
      id: uuid(5400, 50),
      effectiveUniqueCandidateCount: 0,
      terminalReason: "UNKNOWN_CHARGE",
      totalSettledCostMicros: null,
      chargeState: "UNKNOWN_CHARGE",
      completedRoundCount: 1,
      completedWindowCount: 1,
      canonicalRequestSetFingerprint: hash("generation-set-50"),
      completedAt,
      createdBy,
    });
    expect(terminal.totalSettledCostMicros).toBeNull();
  });

  it.each([
    {
      fixtureOrdinal: 6,
      baseOrdinal: 60,
      windows: [
        { raw: 100, effective: 100, fresh: 4 },
        { raw: 100, effective: 100, fresh: 3 },
      ],
      terminalReason: "LOW_YIELD" as const,
      effectiveUniqueCandidateCount: 7,
    },
    {
      fixtureOrdinal: 7,
      baseOrdinal: 70,
      windows: [{ raw: 100, effective: 100, fresh: 100 }],
      terminalReason: "SAFE_SUPPLY_REACHED" as const,
      effectiveUniqueCandidateCount: 100,
    },
    {
      fixtureOrdinal: 8,
      baseOrdinal: 80,
      windows: [{ raw: 1000, effective: 1000, fresh: 1000 }],
      terminalReason: "CANDIDATE_LIMIT_REACHED" as const,
      effectiveUniqueCandidateCount: 1000,
    },
  ])(
    "records $terminalReason only from matching append-only window and round facts",
    async ({
      fixtureOrdinal,
      baseOrdinal,
      windows,
      terminalReason,
      effectiveUniqueCandidateCount,
    }) => {
      const fixture = generation(fixtureOrdinal);
      for (const [index, window] of windows.entries()) {
        const ordinal = baseOrdinal + index;
        await completeRequest({
          fixture,
          ordinal,
          windowOrdinal: index + 1,
          rawCount: window.raw,
          effectiveCount: window.effective,
          newCount: window.fresh,
          duplicateCount: window.effective - window.fresh,
        });
        await recordWindow({
          fixture,
          ordinal: index + 1,
          roundNumber: 1,
          rawCount: window.raw,
          effectiveCount: window.effective,
          newCount: window.fresh,
          duplicateCount: window.effective - window.fresh,
        });
      }
      const rawCount = windows.reduce((total, item) => total + item.raw, 0);
      const effectiveCount = windows.reduce(
        (total, item) => total + item.effective,
        0,
      );
      const newCount = windows.reduce((total, item) => total + item.fresh, 0);
      const round = await repository.recordRoundFact({
        ...fixture,
        id: uuid(5300, baseOrdinal),
        roundNumber: 1,
        completedWindowCount: windows.length,
        completedRequestCount: windows.length,
        rawCandidateCount: rawCount,
        effectiveCandidateCount: effectiveCount,
        newUniqueCount: newCount,
        duplicateCount: effectiveCount - newCount,
        newUniqueRateNumerator: newCount,
        newUniqueRateDenominator: effectiveCount,
        roundAuthorizedCostMicros: 0,
        roundSettledCostMicros: 0,
        cumulativeSettledCostMicros: 0,
        chargeState: "SETTLED",
        pathsExhausted: false,
        changedDimensions: [],
        canonicalRequestSetFingerprint: hash(`round-set-${baseOrdinal}`),
        policyDecision: "STOP",
        terminalReason,
        completedAt,
        createdBy,
      });
      expect(round.terminalReason).toBe(terminalReason);
      const terminal = await repository.recordTerminalFact({
        ...fixture,
        id: uuid(5400, baseOrdinal),
        effectiveUniqueCandidateCount,
        terminalReason,
        totalSettledCostMicros: 0,
        chargeState: "SETTLED",
        completedRoundCount: 1,
        completedWindowCount: windows.length,
        canonicalRequestSetFingerprint: hash(`generation-set-${baseOrdinal}`),
        completedAt,
        createdBy,
      });
      expect(terminal.effectiveUniqueCandidateCount).toBe(
        effectiveUniqueCandidateCount,
      );
    },
  );

  function proposedRound2Path(
    fixture: GenerationFixture,
    ordinal: number,
    overrides: Partial<RecommendationPoolV2ProposedRound2Path> = {},
  ): RecommendationPoolV2ProposedRound2Path {
    return {
      canonicalRequestFingerprint: hash(`b5-round-2-request-${ordinal}`),
      canonicalPathFingerprint: hash(`b5-round-2-path-${ordinal}`),
      keywordFingerprint: fixture.seedFingerprint,
      competitorFingerprint: fixture.seedFingerprint,
      sourceType: "competitor_backlinks",
      pageType: "RESULT_PAGE",
      strategyVersion: "SERP_BACKLINKS_V2",
      countryCode: "US",
      languageCode: "en",
      businessDirectionFingerprint: inputFingerprint,
      authorizedCostMicros: 1_000_000,
      ...overrides,
    };
  }

  async function prepareFinalizerRound(input: {
    fixture: GenerationFixture;
    baseOrdinal: number;
    windows: readonly Readonly<{
      raw: number;
      effective: number;
      fresh: number;
      authorizedCostMicros?: number;
      settledCostMicros?: number | null;
      chargeState?: "SETTLED" | "UNKNOWN_CHARGE";
      roundNumber?: 1 | 2;
      intentOverrides?: Partial<RecommendationDiscoveryRequestIntentInput>;
    }>[];
  }): Promise<void> {
    for (const [index, window] of input.windows.entries()) {
      const ordinal = input.baseOrdinal + index;
      const roundNumber = window.roundNumber ?? 1;
      await completeRequest({
        fixture: input.fixture,
        ordinal,
        roundNumber,
        windowOrdinal: index + 1,
        rawCount: window.raw,
        effectiveCount: window.effective,
        newCount: window.fresh,
        duplicateCount: window.effective - window.fresh,
        authorizedCostMicros: window.authorizedCostMicros,
        actualCostMicros: window.settledCostMicros,
        cumulativeCostMicros: window.settledCostMicros,
        chargeState: window.chargeState,
        intentOverrides: window.intentOverrides,
      });
      await recordWindow({
        fixture: input.fixture,
        ordinal: index + 1,
        roundNumber,
        rawCount: window.raw,
        effectiveCount: window.effective,
        newCount: window.fresh,
        duplicateCount: window.effective - window.fresh,
        authorizedCostMicros: window.authorizedCostMicros,
        settledCostMicros: window.settledCostMicros,
        chargeState: window.chargeState,
      });
    }
  }

  it("atomically finalizes Round 1 and makes concurrent START_ROUND_2 replay exact", async () => {
    const fixture = generation(9);
    await prepareFinalizerRound({
      fixture,
      baseOrdinal: 90,
      windows: [
        {
          raw: 50,
          effective: 40,
          fresh: 30,
          authorizedCostMicros: 500_000,
          settledCostMicros: 500_000,
        },
      ],
    });
    const proposal = proposedRound2Path(fixture, 90);
    const [first, replay] = await Promise.all([
      finalizer.finalize({
        lineage: fixture,
        proposedRound2Path: proposal,
      }),
      finalizer.finalize({
        lineage: fixture,
        proposedRound2Path: proposal,
      }),
    ]);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      kind: "START_ROUND_2",
      round: 2,
      canonicalRequestFingerprint: proposal.canonicalRequestFingerprint,
    });
    const facts = await admin.query(
      `SELECT
         (SELECT count(*)::integer
            FROM backlinks.backlink_recommendation_discovery_round_facts
           WHERE generation_contract_id=$1) AS round_count,
         (SELECT count(*)::integer
            FROM backlinks.backlink_recommendation_discovery_generation_terminal_facts
           WHERE generation_contract_id=$1) AS terminal_count,
         (SELECT count(*)::integer
            FROM backlinks.backlink_recommendation_release_batches)
           AS release_batch_count`,
      [fixture.generationContractId],
    );
    expect(facts.rows[0]).toMatchObject({
      round_count: 1,
      terminal_count: 0,
      release_batch_count: 0,
    });
    await expect(
      finalizer.finalize({
        lineage: fixture,
        proposedRound2Path: {
          ...proposal,
          canonicalRequestFingerprint: hash("conflicting-b5-request-90"),
          canonicalPathFingerprint: hash("conflicting-b5-path-90"),
          sourceType: "different_source",
        },
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  });

  it("persists UNKNOWN_CHARGE and creates no Round 2 intent", async () => {
    const fixture = generation(10);
    await prepareFinalizerRound({
      fixture,
      baseOrdinal: 100,
      windows: [
        {
          raw: 0,
          effective: 0,
          fresh: 0,
          authorizedCostMicros: 500_000,
          settledCostMicros: null,
          chargeState: "UNKNOWN_CHARGE",
        },
      ],
    });

    const result = await finalizer.finalize({
      lineage: fixture,
      proposedRound2Path: proposedRound2Path(fixture, 100),
    });
    expect(result).toMatchObject({
      kind: "TERMINAL",
      reason: "UNKNOWN_CHARGE",
      terminalFact: {
        chargeState: "UNKNOWN_CHARGE",
        totalSettledCostMicros: null,
      },
    });
    const persisted = await admin.query(
      `SELECT count(*)::integer AS count
         FROM backlinks.backlink_recommendation_discovery_request_intents
        WHERE generation_contract_id=$1 AND round_number=2`,
      [fixture.generationContractId],
    );
    expect(persisted.rows[0]?.count).toBe(0);
  });

  it.each([
    {
      fixtureOrdinal: 11,
      baseOrdinal: 110,
      windows: [{ raw: 100, effective: 100, fresh: 100 }],
      reason: "SAFE_SUPPLY_REACHED",
    },
    {
      fixtureOrdinal: 12,
      baseOrdinal: 120,
      windows: [{ raw: 1_000, effective: 1_000, fresh: 1_000 }],
      reason: "CANDIDATE_LIMIT_REACHED",
    },
    {
      fixtureOrdinal: 13,
      baseOrdinal: 130,
      windows: [
        { raw: 100, effective: 100, fresh: 4 },
        { raw: 100, effective: 100, fresh: 3 },
      ],
      reason: "LOW_YIELD",
    },
  ] as const)(
    "persists $reason only from matching request, window, and round facts",
    async ({ fixtureOrdinal, baseOrdinal, windows, reason }) => {
      const fixture = generation(fixtureOrdinal);
      await prepareFinalizerRound({ fixture, baseOrdinal, windows });
      const result = await finalizer.finalize({
        lineage: fixture,
        proposedRound2Path: proposedRound2Path(fixture, baseOrdinal),
      });
      expect(result).toMatchObject({
        kind: "TERMINAL",
        reason,
        terminalFact: { terminalReason: reason },
      });
    },
  );

  it("finalizes Round 2 at the cumulative budget using persisted facts", async () => {
    const fixture = generation(14);
    await prepareFinalizerRound({
      fixture,
      baseOrdinal: 140,
      windows: [
        {
          raw: 80,
          effective: 70,
          fresh: 60,
          authorizedCostMicros: 1_000_000,
          settledCostMicros: 1_000_000,
        },
      ],
    });
    const proposal = proposedRound2Path(fixture, 140);
    await finalizer.finalize({
      lineage: fixture,
      proposedRound2Path: proposal,
    });
    await completeRequest({
      fixture,
      ordinal: 141,
      roundNumber: 2,
      windowOrdinal: 2,
      rawCount: 25,
      effectiveCount: 20,
      newCount: 10,
      duplicateCount: 10,
      authorizedCostMicros: proposal.authorizedCostMicros,
      actualCostMicros: 1_000_000,
      cumulativeCostMicros: 2_000_000,
      intentOverrides: {
        canonicalRequestFingerprint: proposal.canonicalRequestFingerprint,
        canonicalPathFingerprint: proposal.canonicalPathFingerprint,
        discoverySource: proposal.sourceType,
        requestType: proposal.strategyVersion,
        pageType: proposal.pageType,
      },
    });
    await recordWindow({
      fixture,
      ordinal: 2,
      roundNumber: 2,
      rawCount: 25,
      effectiveCount: 20,
      newCount: 10,
      duplicateCount: 10,
      authorizedCostMicros: 1_000_000,
      settledCostMicros: 1_000_000,
    });

    const result = await finalizer.finalize({
      lineage: fixture,
      proposedRound2Path: null,
    });
    expect(result).toMatchObject({
      kind: "TERMINAL",
      reason: "BUDGET_EXHAUSTED",
      roundFact: {
        roundNumber: 2,
        cumulativeSettledCostMicros: 2_000_000,
        changedDimensions: ["SOURCE", "STRATEGY"],
      },
      terminalFact: {
        completedRoundCount: 2,
        effectiveUniqueCandidateCount: 70,
        totalSettledCostMicros: 2_000_000,
      },
    });
  });

  it("persists PATHS_EXHAUSTED when no feasible proposal remains", async () => {
    const fixture = generation(15);
    await prepareFinalizerRound({
      fixture,
      baseOrdinal: 150,
      windows: [{ raw: 20, effective: 10, fresh: 8 }],
    });
    await expect(
      Promise.all([
        finalizer.finalize({
          lineage: fixture,
          proposedRound2Path: null,
        }),
        finalizer.finalize({
          lineage: fixture,
          proposedRound2Path: null,
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "TERMINAL",
        reason: "PATHS_EXHAUSTED",
      }),
      expect.objectContaining({
        kind: "TERMINAL",
        reason: "PATHS_EXHAUSTED",
      }),
    ]);
  });

  it("rejects a generation lineage from another project scope", async () => {
    const fixture = generation(16);
    await prepareFinalizerRound({
      fixture,
      baseOrdinal: 160,
      windows: [{ raw: 20, effective: 10, fresh: 8 }],
    });
    await expect(
      finalizer.finalize({
        lineage: {
          ...fixture,
          websiteProjectId: otherProjectId,
        },
        proposedRound2Path: proposedRound2Path(fixture, 160),
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
  });
});
