import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProjectContextProjectionCommand,
  type ProjectContextProjectionInput,
} from "../../../src/modules/backlinks/application/commands/project-context-projection.command.js";
import { createRecommendationPoolV2GenerationLaunchRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.js";
import { createRecommendationUserReleaseRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-user-release.repository.js";
import { createRecommendationFeedRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-feed.repository.js";
import { createRecommendationSeedRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-seed.repository.js";
import { createRecommendationSeedCommands } from "../../../src/modules/backlinks/application/commands/recommendation-seeds.command.js";
import { createRecommendationPoolV2GenerationLauncher } from "../../../src/modules/backlinks/application/services/recommendation-pool-v2-generation-launcher.service.js";
import { createLocalProductDataForSeoRuntime, readLocalProductDataForSeoConfiguration } from "../../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";
import { createActorContext, createProjectContext, createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { normalizeRecommendationFeedFilters } from "../../../src/modules/backlinks/application/queries/recommendation-feed.query.js";
import { bindProviderOperationBudgetAuthorization } from "../../../src/modules/backlinks/domain/recommendations/provider-operation-budget.js";
import {
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const uuid = (value: number) =>
  `018f0000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

function projectionInput(seed: number): ProjectContextProjectionInput {
  const organizationId = uuid(seed + 1);
  const workspaceId = uuid(seed + 2);
  const websiteProjectId = uuid(seed + 3);
  const snapshotId = uuid(seed + 4);
  const profileVersionId = uuid(seed + 5);
  const promotionTargetVersionId = uuid(seed + 6);
  const outreachProfileRecordId = uuid(seed + 9);
  const siteProfileEvidenceId = uuid(seed + 10);
  const keywordEvidenceId = uuid(seed + 11);
  return {
    organizationId,
    workspaceId,
    websiteProjectId,
    actorId: `projector-${seed}`,
    actorSessionId: `session-${seed}`,
    actorRoles: ["member"],
    correlationId: `correlation-${seed}`,
    snapshotId,
    snapshotVersion: 4,
    projectStatus: "ACTIVE",
    canonicalDomain: `example-${seed}.com`,
    locale: "en-US",
    countryCode: "US",
    targetMarket: "United States home cinema",
    profileVersionId,
    promotionTargetVersionId,
    products: ["Home cinema projector"],
    keywords: ["home cinema"],
    targetUrls: [`https://example-${seed}.com/`],
    targetAudiences: ["home cinema buyers"],
    partnershipGoals: ["editorial review"],
    inputComplete: true,
    jobId: uuid(seed + 7),
    outboxEventId: uuid(seed + 8),
    outreachProfile: {
      recordId: outreachProfileRecordId,
      immutableFingerprint: `outreach-profile-${seed}`,
      profile: {
        organizationId,
        websiteProjectId,
        profileVersionId,
        promotionTargetVersionId,
        keywordsAndTopics: ["home cinema"],
        productsAndServices: ["Home cinema projector"],
        targetUrls: [`https://example-${seed}.com/`],
        targetAudiences: ["home cinema buyers"],
        partnershipGoals: ["editorial review"],
        market: "United States home cinema",
        location: "US",
        language: "en-US",
        authorizedDiscoverySources: ["KEYWORDS"],
        immutableFingerprint: `outreach-profile-${seed}`,
      },
    },
    sharedSeoEvidence: [
      {
        recordId: siteProfileEvidenceId,
        snapshot: {
          organizationId,
          websiteProjectId,
          evidenceType: "site-profile",
          sourceModule: "site-profile",
          sourceRecordId: profileVersionId,
          sourceVersion: "4",
          provider: "website-project",
          endpoint: "website-project",
          normalizedParameters: {},
          requestFingerprint: `site-profile-${seed}`,
          market: "United States home cinema",
          location: "US",
          language: "en-US",
          fetchedAt: "2026-08-18T00:00:00.000Z",
          expiresAt: "2027-08-18T00:00:00.000Z",
          providerRequestId: `website-project:site-profile:${seed}`,
          providerTaskId: null,
          costMicros: 0,
          artifactRef: `website-project://site-profile/${seed}`,
          status: "ready",
        },
      },
      {
        recordId: keywordEvidenceId,
        snapshot: {
          organizationId,
          websiteProjectId,
          evidenceType: "keywords",
          sourceModule: "keywords",
          sourceRecordId: keywordEvidenceId,
          sourceVersion: "4",
          provider: "website-project",
          endpoint: "website-project",
          normalizedParameters: {},
          requestFingerprint: `keywords-${seed}`,
          market: "United States home cinema",
          location: "US",
          language: "en-US",
          fetchedAt: "2026-08-18T00:00:00.000Z",
          expiresAt: "2027-08-18T00:00:00.000Z",
          providerRequestId: `website-project:keywords:${seed}`,
          providerTaskId: null,
          costMicros: 0,
          artifactRef: `website-project://keywords/${seed}`,
          status: "ready",
        },
      },
    ],
    generationInputPins: {
      recordId: uuid(seed + 12),
      outreachProfileRecordId,
      immutableFingerprint: `generation-pin-${seed}`,
      pins: {
        organizationId,
        websiteProjectId,
        projectContextVersion: 4,
        siteProfileVersionId: profileVersionId,
        outreachProfileVersionId: profileVersionId,
        promotionTargetVersionId,
        keywordEvidenceSnapshotIds: [keywordEvidenceId],
        sharedEvidenceSnapshotIds: [siteProfileEvidenceId, keywordEvidenceId],
        market: "United States home cinema",
        qualificationContractVersion: "recommendation-pool-admission.v2",
      },
    },
  };
}

async function migrateBacklinks(client: RuntimeClient): Promise<void> {
  await installBacklinksManifestAfterFoundation(client, "0092");
}

describe("Website Project recommendation demand projection", () => {
  let harness: BacklinksPostgresHarness;
  let client: RuntimeClient;
  let pool: RuntimePool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
    await migrateBacklinks(client);
    pool = new Pool({
      connectionString: harness.connectionString,
      options: "-c search_path=backlinks,pg_catalog",
    });
  }, 180_000);

  beforeEach(async () => {
    await client.query(`
      TRUNCATE backlinks.backlink_audit_events,
        backlinks.backlink_recommendation_pool_project_contracts,
        backlinks.backlink_lifecycle_events,
        backlinks.backlink_outbox_events,
        backlinks.backlink_jobs,
        backlinks.backlink_generation_input_pins,
        backlinks.backlink_shared_seo_evidence_references,
        backlinks.backlink_outreach_profile_versions,
        backlinks.backlink_commercial_inventory_policies,
        backlinks.backlink_project_context_snapshots,
        backlinks.provider_batch_requests,
        backlinks.backlink_provider_usage_ledger,
        backlinks.backlink_provider_budgets,
        backlinks.backlink_provider_requests,
        backlinks.backlink_recommendation_refills
      CASCADE
    `);
    await client.query(`
      INSERT INTO backlinks.backlink_recommendation_pool_v2_cutover_control (
        control_key, state, frozen_by
      ) VALUES ('GLOBAL', 'V1_WRITES_FROZEN', 'projection-regression')
      ON CONFLICT (control_key) DO NOTHING
    `);
    expect((await client.query(
      "SELECT backlinks.backlink_phase9_v1_writes_are_frozen() AS frozen",
    )).rows).toEqual([{ frozen: true }]);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("initializes native V2 and stages its first generation idempotently without V1 or provider writes", async () => {
    const createdInput = projectionInput(100);
    const restoredInput = projectionInput(200);

    const command = createProjectContextProjectionCommand(pool);
    await expect(command.project(createdInput)).resolves.toMatchObject({
      state: "projected",
      inputRequired: false,
      jobScheduled: false,
      jobId: null,
    });
    await expect(command.project(restoredInput)).resolves.toMatchObject({
      state: "projected",
      inputRequired: false,
      jobScheduled: false,
      jobId: null,
    });
    await expect(command.project(createdInput)).resolves.toMatchObject({
      state: "replayed",
      inputRequired: false,
      jobScheduled: false,
    });
    await expect(
      createRecommendationUserReleaseRepository(pool).getStatus(createdInput),
    ).resolves.toBeNull();
    await expect(createRecommendationFeedRepository(pool).list({
      ...createdInput, filters: normalizeRecommendationFeedFilters({}), cursor: null,
    })).resolves.toMatchObject({
      items: [], totalCount: 0, latestGeneration: null, nextPosition: null,
      releasedPool: { generationCount: 0 },
    });
    await expect(createRecommendationUserReleaseRepository(pool).getMore({
      ...createdInput, idempotencyKey: "not-generated", requestHash: "not-generated",
    })).rejects.toThrow("not active");

    const policies = await client.query(`
      SELECT website_project_id::text AS "websiteProjectId",
             visible_pool_state AS "visiblePoolState",
             refill_state AS "refillState",
             termination_reason AS "terminationReason",
             pause_reason AS "pauseReason",
             next_refill_at AS "nextRefillAt",
             version
        FROM backlinks.backlink_commercial_inventory_policies
       ORDER BY website_project_id
    `);
    expect(policies.rows).toEqual([]);

    const lifecycle = await client.query(`
      SELECT website_project_id::text AS "websiteProjectId",
             after_state->>'policyAction' AS "policyAction",
             (after_state->>'snapshotVersion')::integer AS "snapshotVersion"
        FROM backlinks.backlink_lifecycle_events
       WHERE event_type='recommendation.demand.ready'
       ORDER BY website_project_id
    `);
    expect(lifecycle.rows).toEqual([]);
    const contracts = await client.query(`
      SELECT pool_contract_version, migration_state, generation_contract_id
        FROM backlinks.backlink_recommendation_pool_project_contracts
        ORDER BY website_project_id
    `);
    expect(contracts.rows).toEqual([createdInput, restoredInput].map(() => ({
      pool_contract_version: "recommendation-pool.v2",
      migration_state: "V2_READY",
      generation_contract_id: null,
    })));

    const effects = await client.query(`
      SELECT
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='project-analysis') AS "projectAnalysisJobs",
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events
          WHERE event_type='backlinks.project-analysis.requested.v1')
          AS "projectAnalysisOutboxes",
        (SELECT count(*)::int FROM backlinks.backlink_recommendation_refills)
          AS "recommendationRefills",
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='recommendation_refill') AS "recommendationJobs",
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events
          WHERE event_type='backlinks.recommendation-refill.requested.v1')
          AS "recommendationOutboxes",
        (SELECT count(*)::int FROM backlinks.backlink_provider_requests)
          AS "providerRequests",
        (SELECT count(*)::int FROM backlinks.provider_batch_requests)
          AS "providerBatches",
        (SELECT count(*)::int FROM backlinks.backlink_provider_budgets)
          AS "providerBudgets",
        (SELECT count(*)::int FROM backlinks.backlink_provider_usage_ledger)
          AS "providerLedger"
    `);
    expect(effects.rows).toEqual([
      {
        projectAnalysisJobs: 0,
        projectAnalysisOutboxes: 0,
        recommendationRefills: 0,
        recommendationJobs: 0,
        recommendationOutboxes: 0,
        providerRequests: 0,
        providerBatches: 0,
        providerBudgets: 0,
        providerLedger: 0,
      },
    ]);

    const automaticEffects = await client.query(`
      SELECT
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='project-analysis' AND status='success')
          AS "completedProjectAnalysisJobs",
        (SELECT count(*)::int FROM backlinks.backlink_recommendation_refills)
          AS "recommendationRefills",
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='recommendation_refill') AS "recommendationJobs",
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events
          WHERE event_type='backlinks.recommendation-refill.requested.v1')
          AS "recommendationOutboxes",
        (SELECT count(*)::int FROM backlinks.backlink_provider_requests)
          AS "providerRequests",
        (SELECT count(*)::int FROM backlinks.provider_batch_requests)
          AS "providerBatches",
        (SELECT count(*)::int FROM backlinks.backlink_provider_budgets)
          AS "providerBudgets",
        (SELECT count(*)::int FROM backlinks.backlink_provider_usage_ledger)
          AS "providerLedger"
    `);
    expect(automaticEffects.rows).toEqual([
      {
        completedProjectAnalysisJobs: 0,
        recommendationRefills: 0,
        recommendationJobs: 0,
        recommendationOutboxes: 0,
        providerRequests: 0,
        providerBatches: 0,
        providerBudgets: 0,
        providerLedger: 0,
      },
    ]);

    const audits = await client.query(`
      SELECT count(*)::int AS count
        FROM backlinks.backlink_audit_events
       WHERE action='recommendation.demand.ready'
         AND (after_redacted->>'snapshotVersion')::integer=4
    `);
    expect(audits.rows).toEqual([{ count: 0 }]);

    const repository = createRecommendationPoolV2GenerationLaunchRepository(pool);
    const launchInput = {
      ...createdInput,
      requestId: "native-v2-test",
      idempotencyKey: "native-v2-first-generation",
      providerBudgetAuthorization: bindProviderOperationBudgetAuthorization(
        {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 2,
          maxCostMicros: 100_000,
        },
        { authorizedBy: createdInput.actorId },
      ),
    };
    const first = await repository.stage(launchInput);
    expect(first).toMatchObject({
      visiblePoolGeneration: 1,
      recommendationContextVersionId: createdInput.snapshotId,
      replayed: false,
    });
    await expect(repository.stage(launchInput)).resolves.toEqual({
      ...first, replayed: true,
    });
    const native = await client.query(`
      SELECT generation.pool_contract_version, generation.visible_pool_generation,
        pin.qualification_contract_version,
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='recommendation_pool_v2_generation') AS jobs,
        (SELECT count(*)::int FROM backlinks.backlink_provider_requests) AS requests,
        (SELECT count(*)::int FROM backlinks.backlink_recommendation_refills) AS refills
      FROM backlinks.backlink_recommendation_generation_contracts generation
      JOIN backlinks.backlink_generation_input_pins pin ON pin.id=generation.input_pin_id
    `);
    expect(native.rows).toEqual([{
      pool_contract_version: "recommendation-pool.v2",
      visible_pool_generation: 1,
      qualification_contract_version: "recommendation-pool-admission.v2",
      jobs: 1, requests: 0, refills: 0,
    }]);
  }, 60_000);

  it("previews, confirms and launches the first batch through the production commands", async () => {
    const base = projectionInput(600);
    const project = {
      ...base,
      targetMarket: "US",
      outreachProfile: {
        ...base.outreachProfile!,
        profile: {
          ...base.outreachProfile!.profile,
          market: "US",
          authorizedDiscoverySources: ["WEBSITE_PROJECT", "CURATED_RESOURCE_LIBRARY"] as const,
        },
      },
      generationInputPins: {
        ...base.generationInputPins!,
        pins: { ...base.generationInputPins!.pins, market: "US" },
      },
      sharedSeoEvidence: base.sharedSeoEvidence!.map(evidence => ({
        ...evidence,
        snapshot: {
          ...evidence.snapshot,
          market: "US",
          normalizedParameters: { canonicalDomain: base.canonicalDomain },
        },
      })),
    };
    await createProjectContextProjectionCommand(pool).project(project);
    const seedCommands = createRecommendationSeedCommands(createRecommendationSeedRepository(pool));
    const start = vi.fn(async () => ({ workflowId: "test-first-workflow", status: "started" as const }));
    const commands = createRecommendationPoolV2GenerationLauncher({
      seedCommands,
      repository: createRecommendationPoolV2GenerationLaunchRepository(pool),
      starter: { start },
      timing: { record: vi.fn(async () => undefined) },
    });
    const input = {
      context: {
        actor: createActorContext({ userId: project.actorId, sessionId: project.actorSessionId, roles: ["member"] }),
        tenant: createTenantContext(project),
        project: createProjectContext(project),
      },
      idempotencyKey: "first-batch-confirm",
      requestId: "first-batch-test",
      userSeeds: [],
      systemCandidates: [],
    };
    const preview = await commands.validate(input);
    expect(preview.state).toBe("READY");
    expect(preview.seeds.length).toBeGreaterThan(0);
    expect(await commands.validate(input)).toEqual(preview);
    expect((await client.query(`SELECT count(*)::int count FROM backlinks.backlink_recommendation_generation_contracts`)).rows).toEqual([{ count: 0 }]);
    expect(start).not.toHaveBeenCalled();

    const confirmationInput = {
      ...input,
      userSeeds: preview.seeds.filter(seed => seed.validationStatus !== "REJECTED")
        .map(seed => ({ kind: seed.kind, value: seed.rawValue })),
    };
    const confirmed = await commands.generate(confirmationInput);
    expect(confirmed.state).toBe("READY");
    expect(confirmed.confirmation).not.toBeNull();
    const replayed = await commands.generate(confirmationInput);
    expect(replayed.confirmation).toEqual(confirmed.confirmation);
    expect(start).not.toHaveBeenCalled();
    const launched = await commands.launch({
      ...input, idempotencyKey: "first-batch-launch", ...confirmed.confirmation!,
    });
    expect(launched).toMatchObject({ state: "STARTED", visiblePoolGeneration: 1 });
    expect(start).toHaveBeenCalledTimes(1);
    await expect(createRecommendationFeedRepository(pool).list({
      ...project, filters: normalizeRecommendationFeedFilters({}), cursor: null,
    })).resolves.toMatchObject({
      items: [], totalCount: 0,
      latestGeneration: { visiblePoolGeneration: 1 },
      releasedPool: { generationCount: 0 },
    });
    // Run the worker through real input binding, stopping at the discovery port.
    const runtime = createLocalProductDataForSeoRuntime({
      pool,
      secretStoreRoot: join(tmpdir(), "unused-first-generation-test"),
      configuration: readLocalProductDataForSeoConfiguration({
        DATAFORSEO_CREDENTIAL_SECRET_REF: "secret://growthos/local-product/dataforseo/provider-credential/v7",
        DATAFORSEO_ENDPOINT_ALLOWLIST: '["https://api.dataforseo.com/v3/backlinks/summary/live"]',
        DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "100000",
        DATAFORSEO_MAX_PAID_CALLS: "1",
        DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
        DATAFORSEO_ESTIMATED_COST_MICROS: "50000",
        DATAFORSEO_CANDIDATE_LIMIT: "20",
      }),
    });
    const generation = (await client.query(`
      SELECT id, recommendation_context_version_id, discovery_budget_policy_version
      FROM backlinks.backlink_recommendation_generation_contracts
    `)).rows[0]!;
    await expect(runtime.execute({
      ...project,
      jobId: (await client.query(`SELECT id FROM backlinks.backlink_jobs`)).rows[0]!.id,
      recommendationContextVersionId: generation.recommendation_context_version_id,
      visiblePoolGeneration: 1,
      nativeV2: {
        generationContractId: generation.id,
        discoveryBudgetPolicyVersion: generation.discovery_budget_policy_version,
        round: 1,
        requestPort: {
          get authoritativeBlueprintId() {
            throw new Error("TEST_REACHED_DISCOVERY_PORT");
          },
        },
      },
    } as Parameters<typeof runtime.execute>[0])).rejects.toThrow("TEST_REACHED_DISCOVERY_PORT");
    await client.query(`
      UPDATE backlinks.backlink_jobs
         SET status='running', step='canonical_batch_preparation',
             result_summary=result_summary || '{"terminalReason":"RECOMMENDATION_POOL_V2_WORKFLOW_FAILED"}'::jsonb
    `);
    await expect(createRecommendationFeedRepository(pool).list({
      ...project, filters: normalizeRecommendationFeedFilters({}), cursor: null,
    })).resolves.toMatchObject({
      latestGeneration: {
        visiblePoolGeneration: 1, jobState: "RUNNING",
        terminalReason: null, contactPreparation: "IN_PROGRESS",
      },
      releasedPool: { generationCount: 0 },
    });
    expect((await client.query(`SELECT count(*)::int count FROM backlinks.backlink_recommendation_generation_contracts`)).rows).toEqual([{ count: 1 }]);
    expect((await client.query(`SELECT count(*)::int count FROM backlinks.backlink_provider_usage_ledger`)).rows).toEqual([{ count: 0 }]);
  }, 60_000);

  it("preserves a blocked migration on projection replay and rejects incomplete new projects", async () => {
    const blocked = projectionInput(300);
    const incomplete = { ...projectionInput(400), inputComplete: false };
    const command = createProjectContextProjectionCommand(pool);
    await command.project(blocked);
    await client.query(
      `UPDATE backlinks.backlink_recommendation_pool_project_contracts
          SET migration_state='MIGRATION_BLOCKED',
              state_reason_codes='["V2_CANDIDATE_LINEAGE_INCOMPLETE"]'::jsonb,
              version=version+1
        WHERE website_project_id=$1`,
      [blocked.websiteProjectId],
    );
    await command.project(blocked);
    await command.project(incomplete);
    await expect(
      createRecommendationUserReleaseRepository(pool).getStatus(blocked),
    ).rejects.toThrow("not active");
    await expect(createRecommendationFeedRepository(pool).list({
      ...blocked, filters: normalizeRecommendationFeedFilters({}), cursor: null,
    })).rejects.toThrow("not active");
    const state = await client.query(
      `SELECT website_project_id,migration_state,version
         FROM backlinks.backlink_recommendation_pool_project_contracts`,
    );
    expect(state.rows).toEqual([{
      website_project_id: blocked.websiteProjectId,
      migration_state: "MIGRATION_BLOCKED",
      version: 2,
    }]);
    const repository = createRecommendationPoolV2GenerationLaunchRepository(pool);
    for (const project of [blocked, incomplete]) {
      await expect(createRecommendationSeedRepository(pool).validate({
        ...project, userSeeds: [], systemCandidates: [],
      })).rejects.toThrow("no complete pinned seed snapshot");
      await expect(repository.stage({
        ...project,
        requestId: "ineligible-native-v2",
        idempotencyKey: "ineligible-native-v2",
        providerBudgetAuthorization: bindProviderOperationBudgetAuthorization(
          {
            provider: "dataforseo",
            reasonCode: "user_authorized_bounded_real_refill",
            maxPaidCalls: 2,
            maxCostMicros: 100_000,
          },
          { authorizedBy: project.actorId },
        ),
      })).rejects.toThrow("RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE");
    }
  });

  it("accepts a newer context and paused projects under the V1 freeze", async () => {
    const initial = projectionInput(500);
    const command = createProjectContextProjectionCommand(pool);
    await command.project(initial);
    const updated = {
      ...initial,
      snapshotId: uuid(520),
      snapshotVersion: 5,
      generationInputPins: {
        ...initial.generationInputPins!,
        recordId: uuid(521),
        immutableFingerprint: "updated-generation-pin",
        pins: {
          ...initial.generationInputPins!.pins,
          projectContextVersion: 5,
        },
      },
    };
    await expect(command.project(updated)).resolves.toMatchObject({
      state: "projected", snapshotVersion: 5, jobScheduled: false, jobId: null,
    });
    await expect(command.project(updated)).resolves.toMatchObject({
      state: "replayed", jobScheduled: false,
    });
    await expect(command.project(initial)).rejects.toThrow("stale");
    const preview = await createRecommendationSeedRepository(pool).validate({
      ...updated, userSeeds: [], systemCandidates: [],
    });
    expect(preview.state).toBe("READY");
    expect(preview.seeds.flatMap(seed => seed.evidenceRefs).some(
      evidence => evidence.recordId === updated.snapshotId,
    )).toBe(true);
    await expect(command.project({
      ...projectionInput(600), projectStatus: "PAUSED",
    })).resolves.toMatchObject({ state: "projected", jobScheduled: false });
    await expect(createRecommendationSeedRepository(pool).validate({
      ...projectionInput(600), userSeeds: [], systemCandidates: [],
    })).rejects.toThrow("no complete pinned seed snapshot");
    expect((await client.query(`
      SELECT
        (SELECT count(*)::int FROM backlinks.backlink_jobs) AS jobs,
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events) AS events,
        (SELECT count(*)::int FROM backlinks.backlink_recommendation_pool_project_contracts)
          AS contracts
    `)).rows).toEqual([{ jobs: 0, events: 0, contracts: 1 }]);
  });
});
