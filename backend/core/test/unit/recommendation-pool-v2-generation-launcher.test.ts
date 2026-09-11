import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { RecommendationSeedCommands } from "../../src/modules/backlinks/application/commands/recommendation-seeds.command.js";
import { createRecommendationPoolV2GenerationLauncher } from "../../src/modules/backlinks/application/services/recommendation-pool-v2-generation-launcher.service.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import { isRecommendationPoolV2ProjectGeneratable } from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-v2-project-generation-eligibility.js";

const context = {
  actor: createActorContext({
    userId: "user-1",
    sessionId: "session-1",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: "organization-1",
    workspaceId: "workspace-1",
  }),
  project: createProjectContext({
    websiteProjectId: "project-1",
    canonicalDomain: "project.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "site-profile-1",
    promotionTargetVersionId: "promotion-1",
  }),
};

const snapshot = {
  projectContextSnapshotId: "context-1",
  projectContextSnapshotVersion: 8,
  canonicalDomain: "project.example",
  locale: "en-US",
  countryCode: "US",
  siteProfileVersionId: "site-profile-1",
  outreachProfileVersionId: "outreach-profile-1",
  outreachProfileFingerprint: "outreach-fingerprint-1",
  promotionTargetVersionId: "promotion-1",
  market: "US",
  location: "United States",
  language: "en",
  keywords: ["technical seo"],
  categories: ["developer tools"],
  products: ["seo monitoring"],
  targetAudiences: ["growth teams"],
  seoCompetitors: ["competitor.example"],
} as const;

const prepared = {
  state: "READY",
  replayed: false,
  confirmation: {
    generationContractId: "generation-3",
    seedSnapshotFingerprint: "a".repeat(64),
  },
  reasonCodes: [],
  snapshot,
  seeds: [
    {
      id: "seed-1",
      kind: "KEYWORD",
      rawValue: "technical seo",
      normalizedValue: "technical seo",
      source: "SYSTEM_FALLBACK",
      validationStatus: "VERIFIED",
      validationReasonCodes: [],
      evidenceRefs: [],
      confidenceBand: "HIGH",
      seedFingerprint: "seed-fingerprint-1",
      supersedesSeedId: null,
    },
  ],
  blueprintSeedReferences: [
    {
      id: "reference-1",
      blueprintId: "blueprint-1",
      seedId: "seed-1",
      seedFingerprint: "seed-fingerprint-1",
      seedOrdinal: 1,
    },
  ],
} as const;

function baseCommands(
  validation: Awaited<ReturnType<RecommendationSeedCommands["validate"]>>,
) {
  return {
    generate: vi.fn(async () => prepared),
    prepareBeforeTask: vi.fn(async () => prepared),
    prepareForGeneration: vi.fn(async () => prepared),
    validate: vi.fn(async () => validation),
  } satisfies RecommendationSeedCommands;
}

const input = {
  context,
  idempotencyKey: "request-key-1",
  requestId: "request-1",
  userSeeds: [],
  systemCandidates: [],
} as const;

describe("recommendation pool V2 generation launcher", () => {
  it("only permits the exact frozen candidate-lineage recovery state", () => {
    const v2Project = {
      poolContractVersion: "recommendation-pool.v2",
      migrationState: "MIGRATION_BLOCKED",
      stateReasonCodes: ["V2_CANDIDATE_LINEAGE_INCOMPLETE"],
      v1WritesFrozen: true,
    };

    expect(isRecommendationPoolV2ProjectGeneratable(v2Project)).toBe(true);
    expect(
      isRecommendationPoolV2ProjectGeneratable({
        ...v2Project,
        migrationState: "V2_READY",
        stateReasonCodes: [],
        v1WritesFrozen: false,
      }),
    ).toBe(true);
    expect(
      isRecommendationPoolV2ProjectGeneratable({
        ...v2Project,
        stateReasonCodes: [
          "V2_CANDIDATE_LINEAGE_INCOMPLETE",
          "PROJECT_INPUT_REQUIRED",
        ],
      }),
    ).toBe(false);
    expect(
      isRecommendationPoolV2ProjectGeneratable({
        ...v2Project,
        v1WritesFrozen: false,
      }),
    ).toBe(false);
    expect(
      isRecommendationPoolV2ProjectGeneratable({
        ...v2Project,
        poolContractVersion: "recommendation-pool.v1",
      }),
    ).toBe(false);
  });

  it("uses the same eligibility guard at all five production boundaries", () => {
    const launchRepository = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const seedRepository = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-seed.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const poolRepository = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(
      launchRepository.match(/isRecommendationPoolV2ProjectGeneratable\(/g),
    ).toHaveLength(1);
    expect(
      poolRepository.match(/isRecommendationPoolV2ProjectGeneratable\(/g),
    ).toHaveLength(3);
    expect(
      seedRepository.match(/isRecommendationPoolV2ProjectGeneratable\(/g),
    ).toHaveLength(1);
  });

  it("stages one native generation and waits for explicit seed confirmation", async () => {
    const commands = baseCommands({
      state: "READY",
      seeds: [],
      blueprintSeedReferences: [],
      reasonCodes: [],
    });
    const stage = vi.fn(async () => ({
      generationContractId: "generation-3",
      recommendationContextVersionId: "context-1",
      visiblePoolGeneration: 3,
      inputPinId: "input-pin-1",
      jobId: "job-1",
      workflowId: "workflow-1",
      replayed: false,
    }));
    const confirmLaunch = vi.fn();
    const start = vi.fn(async () => ({
      workflowId: "workflow-1",
      status: "started" as const,
    }));
    const record = vi.fn(async () => undefined);
    const launcher = createRecommendationPoolV2GenerationLauncher({
      seedCommands: commands,
      repository: { stage, confirmLaunch },
      starter: { start },
      timing: { record },
    });

    await expect(launcher.generate(input)).resolves.toBe(prepared);

    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "organization-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        providerBudgetAuthorization: expect.objectContaining({
          provider: "dataforseo",
          maxPaidCalls: 25,
          maxCostMicros: 2_000_000,
        }),
      }),
    );
    expect(commands.prepareForGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        targetGenerationContractId: "generation-3",
      }),
    );
    expect(start).not.toHaveBeenCalled();
    expect(confirmLaunch).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "WORKFLOW_SCHEDULED",
      }),
    );
  });

  it("launches the exact confirmed seed snapshot with idempotent workflow rounds", async () => {
    const commands = baseCommands({
      state: "READY",
      seeds: [],
      blueprintSeedReferences: [],
      reasonCodes: [],
    });
    const stage = vi.fn();
    const confirmLaunch = vi.fn(async () => ({
      generationContractId: "generation-3",
      recommendationContextVersionId: "context-1",
      visiblePoolGeneration: 3,
      inputPinId: "input-pin-1",
      jobId: "job-1",
      workflowId: "workflow-1",
      replayed: false,
      seedFingerprints: ["seed-fingerprint-1"],
    }));
    const start = vi.fn(async () => ({
      workflowId: "workflow-1",
      status: "started" as const,
    }));
    const record = vi.fn(async () => undefined);
    const launcher = createRecommendationPoolV2GenerationLauncher({
      seedCommands: commands,
      repository: { stage, confirmLaunch },
      starter: { start },
      timing: { record },
    });

    await expect(
      launcher.launch({
        context,
        idempotencyKey: "launch-key-1",
        requestId: "request-2",
        generationContractId: "generation-3",
        seedSnapshotFingerprint: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      generationContractId: "generation-3",
      state: "STARTED",
      replayed: false,
    });

    expect(stage).not.toHaveBeenCalled();
    expect(confirmLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        generationContractId: "generation-3",
        seedSnapshotFingerprint: "a".repeat(64),
        idempotencyKey: "launch-key-1",
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        generationContractId: "generation-3",
        jobId: "job-1",
        rounds: [
          expect.objectContaining({ round: 1, maxCostMicros: 1_000_000 }),
          expect.objectContaining({ round: 2, maxCostMicros: 1_000_000 }),
        ],
      }),
    );
    const launchInput = start.mock.calls[0]?.[0];
    expect(launchInput?.rounds[0]?.requestFingerprint).not.toBe(
      launchInput?.rounds[1]?.requestFingerprint,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        generationContractId: "generation-3",
        jobId: "job-1",
        eventType: "WORKFLOW_SCHEDULED",
        idempotencyKey: "workflow-scheduled:workflow-1",
        observedState: "STARTED",
      }),
    );
  });

  it("does not stage or start when reliable discovery seeds are unavailable", async () => {
    const commands = baseCommands({
      state: "INPUT_REQUIRED",
      seeds: [],
      blueprintSeedReferences: [],
      reasonCodes: ["DISCOVERY_SEEDS_REQUIRED"],
    });
    const stage = vi.fn();
    const confirmLaunch = vi.fn();
    const start = vi.fn();
    const launcher = createRecommendationPoolV2GenerationLauncher({
      seedCommands: commands,
      repository: { stage, confirmLaunch },
      starter: { start },
      timing: { record: vi.fn(async () => undefined) },
    });

    await launcher.generate(input);

    expect(commands.generate).toHaveBeenCalledWith(input);
    expect(stage).not.toHaveBeenCalled();
    expect(confirmLaunch).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps active generations resumable with multiple windows per round", () => {
    const source = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("intent.discovery_window_ordinal<>");
    expect(source).not.toContain("window_fact.window_ordinal<>");
    expect(source).toContain(
      "intent.discovery_window_ordinal<\n                             intent.round_number",
    );
    expect(source).toContain(
      "window_fact.window_ordinal<\n                             window_fact.round_number",
    );
    expect(source).toContain("step='non_resumable_discovery_lineage'");
    expect(source).toContain(
      "'RECOMMENDATION_POOL_V2_DISCOVERY_LINEAGE_INCOMPATIBLE'",
    );
  });

  it("uses exact V2 generation and input-pin contract versions", () => {
    const launchRepository = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const projection = readFileSync(
      new URL(
        "../../src/modules/backlinks/application/commands/project-context-projection.command.ts",
        import.meta.url,
      ),
      "utf8",
    );

    for (const contractVersion of [
      "recommendation-pool-admission.v2",
      "recommendation-pool-release-visibility.v2",
      "recommendation-pool-materialization.v2",
      "recommendation-pool-worker.v2",
    ]) {
      expect(launchRepository).toContain(contractVersion);
    }
    expect(launchRepository).not.toContain(
      "current.qualificationContractVersion",
    );
    expect(launchRepository).not.toContain("current.scoreModelVersion");
    expect(projection).toContain("recommendation-pool.v2");
    expect(projection).toContain("recommendation-pool-admission.v2");
  });

  it("rotates through a fresh higher generation instead of repairing a completed failure in place", () => {
    const launchRepository = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-pool-v2-generation-launch.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const poolRepository = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/repositories/recommendation-pool-v2.repository.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(poolRepository).not.toContain("candidate_job.status='failed'");
    expect(poolRepository).not.toContain("candidate_job.status='success'");
    expect(launchRepository).toContain(
      "Number(current.maximumVisiblePoolGeneration ?? 0) + 1",
    );
    expect(poolRepository).toContain(
      "currentGeneration >= input.visiblePoolGeneration",
    );
    expect(poolRepository).toContain("generation_contract_id=$4");
  });
});
