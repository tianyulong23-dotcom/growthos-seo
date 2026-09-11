import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { RecommendationSeedPersisted } from "../../src/modules/backlinks/application/commands/recommendation-seeds.command.js";
import type { GenerationInputBinding } from "../../src/modules/backlinks/ports/shared-seo-evidence.port.js";
import {
  executeRecommendationSeedReadinessGate,
  prepareRecommendationSeedsBeforeProjectReadiness,
} from "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const websiteProjectId = "33333333-3333-4333-8333-333333333333";
const contextId = "44444444-4444-4444-8444-444444444444";
const profileVersionId = "55555555-5555-4555-8555-555555555555";
const promotionTargetVersionId = "66666666-6666-4666-8666-666666666666";
const seedId = "77777777-7777-4777-8777-777777777777";
const blueprintId = "88888888-8888-4888-8888-888888888888";
const blueprintSeedId = "99999999-9999-4999-8999-999999999999";
const seedFingerprint = "a".repeat(64);

const rawProjectContext = Object.freeze({
  snapshotVersion: 4,
  profileVersionId,
  promotionTargetVersionId,
  projectSettingsVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectSettingsVersion: 2,
  projectStatus: "ACTIVE",
  canonicalDomain: "elephtv.com",
  locale: "en-US",
  countryCode: "US",
  products: ["SEO monitoring"],
  keywords: [],
  targetUrls: [],
  targetAudiences: ["Growth teams"],
  partnershipGoals: ["Editorial review"],
  explicitCompetitorDomains: [],
});

const preparedSeeds = Object.freeze({
  state: "READY",
  replayed: false,
  reasonCodes: Object.freeze([]),
  snapshot: Object.freeze({
    projectContextSnapshotId: contextId,
    projectContextSnapshotVersion: 4,
    canonicalDomain: "elephtv.com",
    locale: "en-US",
    countryCode: "US",
    siteProfileVersionId: profileVersionId,
    outreachProfileVersionId: profileVersionId,
    outreachProfileFingerprint: "profile-fingerprint",
    promotionTargetVersionId,
    market: "US",
    location: "US",
    language: "en-US",
    keywords: Object.freeze([]),
    categories: Object.freeze([]),
    products: Object.freeze(["SEO monitoring"]),
    targetAudiences: Object.freeze(["Growth teams"]),
    seoCompetitors: Object.freeze([]),
  }),
  seeds: Object.freeze([
    Object.freeze({
      id: seedId,
      kind: "KEYWORD" as const,
      rawValue: "SEO monitoring",
      normalizedValue: "seo monitoring",
      source: "SYSTEM_FALLBACK" as const,
      validationStatus: "VERIFIED" as const,
      validationReasonCodes: Object.freeze(["PROJECT_PRODUCT_FALLBACK"]),
      evidenceRefs: Object.freeze([
        Object.freeze({
          evidenceType: "PROJECT_CONTEXT" as const,
          recordId: contextId,
          field: "products",
        }),
      ]),
      confidenceBand: "MEDIUM" as const,
      seedFingerprint,
      supersedesSeedId: null,
    }),
  ]),
  blueprintSeedReferences: Object.freeze([
    Object.freeze({
      id: blueprintSeedId,
      blueprintId,
      seedId,
      seedFingerprint,
      seedOrdinal: 1,
    }),
  ]),
}) satisfies RecommendationSeedPersisted;

function binding(): GenerationInputBinding {
  const evidenceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  return Object.freeze({
    inputPinId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    outreachProfileRecordId: profileVersionId,
    immutableFingerprint: "binding-fingerprint",
    pins: Object.freeze({
      organizationId,
      websiteProjectId,
      projectContextVersion: 4,
      siteProfileVersionId: profileVersionId,
      outreachProfileVersionId: profileVersionId,
      promotionTargetVersionId,
      keywordEvidenceSnapshotIds: Object.freeze([]),
      sharedEvidenceSnapshotIds: Object.freeze([evidenceId]),
      market: "US",
      qualificationContractVersion: "recommendation-qualification.v1",
    }),
    outreachProfile: Object.freeze({
      organizationId,
      websiteProjectId,
      profileVersionId,
      promotionTargetVersionId,
      keywordsAndTopics: Object.freeze([]),
      productsAndServices: Object.freeze(["SEO monitoring"]),
      targetUrls: Object.freeze([]),
      targetAudiences: Object.freeze(["Growth teams"]),
      partnershipGoals: Object.freeze(["Editorial review"]),
      market: "US",
      location: "US",
      language: "en-US",
      authorizedDiscoverySources: Object.freeze([
        "WEBSITE_PROJECT",
        "CURATED_RESOURCE_LIBRARY",
      ]),
      immutableFingerprint: "profile-fingerprint",
    }),
    sharedEvidence: Object.freeze([
      Object.freeze({
        recordId: evidenceId,
        snapshot: Object.freeze({
          organizationId,
          websiteProjectId,
          evidenceType: "website-project.site-profile",
          sourceModule: "site-profile" as const,
          sourceRecordId: evidenceId,
          sourceVersion: "site-profile.v1",
          provider: "growthos-platform",
          endpoint: "website-project/site-profile",
          normalizedParameters: Object.freeze({
            canonicalDomain: "elephtv.com",
          }),
          requestFingerprint: "site-profile-fingerprint",
          market: "US",
          location: "US",
          language: "en-US",
          fetchedAt: "2026-08-28T00:00:00.000Z",
          expiresAt: "2026-09-28T00:00:00.000Z",
          providerRequestId: "site-profile-request",
          providerTaskId: null,
          costMicros: 0,
          artifactRef: "platform://website-project/site-profile",
          status: "ready" as const,
        }),
      }),
    ]),
  });
}

function preTaskInput(
  commands: Parameters<
    typeof prepareRecommendationSeedsBeforeProjectReadiness
  >[0]["commands"],
) {
  return {
    commands,
    poolContractVersion: "recommendation-pool.v2",
    migrationState: "V2_ACTIVE",
    contractRecommendationContextVersionId: contextId,
    expectedRecommendationContextVersionId: contextId,
    organizationId,
    workspaceId,
    websiteProjectId,
    actorId: "seed-worker",
    jobId: "seed-job",
    workflowId: "seed-workflow",
    correlationId: "seed-correlation",
    projectContext: rawProjectContext,
  } as const;
}

describe("Phase 2 seed preparation product wiring", () => {
  it("executes seed preparation before readiness and the downstream edge", async () => {
    const events: string[] = [];
    const calls: unknown[] = [];
    const downstream = {
      provider: 0,
      discovery: 0,
      store: 0,
    };
    const resolved = await executeRecommendationSeedReadinessGate({
      ...preTaskInput({
        async prepareBeforeTask(input) {
          events.push("seed-preparation");
          calls.push(input);
          return preparedSeeds;
        },
      }),
      async loadInputBinding() {
        events.push("readiness");
        return binding();
      },
      onReady(input) {
        events.push("downstream-edge");
        downstream.provider += 1;
        downstream.discovery += 1;
        downstream.store += 1;
        return input;
      },
      now: new Date("2026-08-29T00:00:00.000Z"),
    });

    expect(events).toEqual([
      "seed-preparation",
      "readiness",
      "downstream-edge",
    ]);
    expect(downstream).toEqual({
      provider: 1,
      discovery: 1,
      store: 1,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        idempotencyKey: "recommendation-seeds:pre-task:seed-job",
        requestId: "seed-correlation",
        userSeeds: [],
        systemCandidates: [],
      }),
    ]);
    expect(resolved.context.keywords).toEqual(["seo monitoring"]);
    expect(resolved.preparedSeeds?.blueprintSeedReferences).toEqual([
      expect.objectContaining({
        blueprintId,
        seedId,
        seedFingerprint,
        seedOrdinal: 1,
      }),
    ]);
  });

  it("uses a confirmed native V2 seed snapshot without reopening seed writes", async () => {
    const events: string[] = [];
    const commands = {
      async prepareBeforeTask() {
        events.push("seed-preparation");
        return preparedSeeds;
      },
      async prepareForGeneration() {
        events.push("generation-seed-preparation");
        return preparedSeeds;
      },
    };

    await expect(
      executeRecommendationSeedReadinessGate({
        ...preTaskInput(commands),
        migrationState: "MIGRATION_BLOCKED",
        seedPreparationMode: "confirmed_native_v2",
        projectContext: {
          ...rawProjectContext,
          keywords: ["seo monitoring"],
        },
        async loadInputBinding() {
          events.push("readiness");
          const pinned = binding();
          return Object.freeze({
            ...pinned,
            pins: Object.freeze({
              ...pinned.pins,
              qualificationContractVersion: "recommendation-pool-admission.v2",
            }),
            outreachProfile: Object.freeze({
              ...pinned.outreachProfile,
              keywordsAndTopics: Object.freeze(["seo monitoring"]),
            }),
          });
        },
        onReady(input) {
          events.push("downstream-edge");
          return input;
        },
        now: new Date("2026-09-04T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      preparedSeeds: null,
      context: {
        canonicalDomain: "elephtv.com",
      },
    });
    expect(events).toEqual(["readiness", "downstream-edge"]);

    await expect(
      executeRecommendationSeedReadinessGate({
        ...preTaskInput(commands),
        migrationState: "MIGRATION_BLOCKED",
        async loadInputBinding() {
          events.push("unexpected-readiness");
          return binding();
        },
        onReady(input) {
          events.push("unexpected-downstream-edge");
          return input;
        },
        now: new Date("2026-09-04T00:00:00.000Z"),
      }),
    ).rejects.toThrow(
      "owner=WEBSITE_PROJECT recovery=complete_recommendation_pool_v2_migration reason=recommendation_seed_contract_not_writable",
    );
    expect(events).toEqual(["readiness", "downstream-edge"]);
  });

  it("blocks INPUT_REQUIRED before readiness or provider work", async () => {
    const events: string[] = [];
    const downstream = {
      provider: 0,
      discovery: 0,
      store: 0,
    };
    const inputRequired = {
      ...preparedSeeds,
      state: "INPUT_REQUIRED" as const,
      reasonCodes: Object.freeze(["DISCOVERY_SEEDS_REQUIRED"]),
      seeds: Object.freeze([]),
      blueprintSeedReferences: Object.freeze([]),
    };

    await expect(
      executeRecommendationSeedReadinessGate({
        ...preTaskInput({
          async prepareBeforeTask() {
            events.push("seed-preparation");
            return inputRequired;
          },
        }),
        async loadInputBinding() {
          events.push("readiness");
          return binding();
        },
        onReady(input) {
          events.push("downstream-edge");
          downstream.provider += 1;
          downstream.discovery += 1;
          downstream.store += 1;
          return input;
        },
        now: new Date("2026-08-29T00:00:00.000Z"),
      }),
    ).rejects.toThrow(
      "owner=WEBSITE_PROJECT recovery=add_or_verify_recommendation_seeds reason=recommendation_seeds_input_required",
    );
    expect(events).toEqual(["seed-preparation"]);
    expect(downstream).toEqual({
      provider: 0,
      discovery: 0,
      store: 0,
    });
  });

  it("fails closed when READY seeds have no persisted Blueprint references", async () => {
    let readinessCalls = 0;
    let downstreamCalls = 0;

    await expect(
      executeRecommendationSeedReadinessGate({
        ...preTaskInput({
          async prepareBeforeTask() {
            return {
              ...preparedSeeds,
              blueprintSeedReferences: Object.freeze([]),
            };
          },
        }),
        async loadInputBinding() {
          readinessCalls += 1;
          return binding();
        },
        onReady(input) {
          downstreamCalls += 1;
          return input;
        },
        now: new Date("2026-08-29T00:00:00.000Z"),
      }),
    ).rejects.toThrow(
      "owner=WEBSITE_PROJECT recovery=regenerate_recommendation_seeds reason=recommendation_seed_blueprint_lineage_invalid",
    );
    expect(readinessCalls).toBe(0);
    expect(downstreamCalls).toBe(0);
  });

  it.each([
    [
      "seed ID",
      {
        ...preparedSeeds.blueprintSeedReferences[0],
        seedId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    ],
    [
      "fingerprint",
      {
        ...preparedSeeds.blueprintSeedReferences[0],
        seedFingerprint: "b".repeat(64),
      },
    ],
    [
      "ordinal",
      {
        ...preparedSeeds.blueprintSeedReferences[0],
        seedOrdinal: 2,
      },
    ],
  ])(
    "rejects a Blueprint reference with a mismatched %s",
    async (_, reference) => {
      await expect(
        prepareRecommendationSeedsBeforeProjectReadiness(
          preTaskInput({
            async prepareBeforeTask() {
              return {
                ...preparedSeeds,
                blueprintSeedReferences: Object.freeze([
                  Object.freeze(reference),
                ]),
              };
            },
          }),
        ),
      ).rejects.toThrow(
        "owner=WEBSITE_PROJECT recovery=regenerate_recommendation_seeds reason=recommendation_seed_blueprint_lineage_invalid",
      );
    },
  );

  it("keeps V1 contract behavior seed-write free", async () => {
    let called = false;
    const prepared = await prepareRecommendationSeedsBeforeProjectReadiness({
      ...preTaskInput({
        async prepareBeforeTask() {
          called = true;
          return preparedSeeds;
        },
      }),
      poolContractVersion: "recommendation-pool.v1",
      migrationState: "V1_ACTIVE",
      contractRecommendationContextVersionId: null,
    });

    expect(prepared).toBeNull();
    expect(called).toBe(false);
  });

  it("registers the seed route and composes the same commands into API and readiness runtime", async () => {
    const [privateServer, productionRuntime, discoveryRuntime] =
      await Promise.all([
        readFile(
          new URL(
            "../../src/modules/backlinks/api/private-server.ts",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../../src/modules/backlinks/runtime/production-runtime.ts",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
            import.meta.url,
          ),
          "utf8",
        ),
      ]);

    expect(privateServer).toContain(
      "registerBacklinksRecommendationSeedRoutes(app",
    );
    expect(productionRuntime).toContain(
      "createRecommendationSeedCommands(\n    createRecommendationSeedRepository(pool)",
    );
    expect(productionRuntime).toContain("recommendationSeedCommands,");
    expect(productionRuntime).toContain(
      "createLocalProductDataForSeoRuntime({",
    );
    expect(discoveryRuntime).toContain(
      "await executeRecommendationSeedReadinessGate({",
    );
  });
});
