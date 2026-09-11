import { describe, expect, it } from "vitest";

import { createRecommendationSeedCommands } from "../../src/modules/backlinks/application/commands/recommendation-seeds.command.js";
import { prepareRecommendationSeeds } from "../../src/modules/backlinks/application/services/recommendation-seed-preparation.service.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const snapshot = {
  projectContextSnapshotId: "context-1",
  projectContextSnapshotVersion: 7,
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
  keywords: ["Technical SEO"],
  categories: ["Developer tools"],
  products: ["SEO monitoring"],
  targetAudiences: ["Growth teams"],
  seoCompetitors: ["competitor.example"],
} as const;

const resolvedContext = {
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

describe("BACKLINKS-RECOMMENDATION-POOL-V2-PHASE-2-001 seed policy", () => {
  it("preserves user values and merges trace evidence without system overwrite", () => {
    const result = prepareRecommendationSeeds({
      generationContractId: "generation-1",
      snapshot,
      userSeeds: [
        {
          kind: "KEYWORD",
          value: "  Technical   SEO ",
        },
      ],
      systemCandidates: [
        {
          kind: "KEYWORD",
          value: "technical seo",
          source: "SYSTEM_SUPPLEMENT",
          evidenceRefs: [
            {
              evidenceType: "OUTREACH_PROFILE",
              recordId: "outreach-profile-1",
              field: "keywordsAndTopics",
            },
          ],
          confidenceBand: "MEDIUM",
        },
      ],
    });

    expect(result.state).toBe("READY");
    expect(result.seeds).toHaveLength(5);
    expect(result.seeds[0]).toMatchObject({
      kind: "KEYWORD",
      rawValue: "Technical SEO",
      normalizedValue: "technical seo",
      source: "USER_INPUT",
      validationStatus: "VERIFIED",
      confidenceBand: "HIGH",
    });
    expect(result.seeds[0]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceType: "USER_INPUT",
          field: "keywords",
        }),
        expect.objectContaining({
          evidenceType: "OUTREACH_PROFILE",
          field: "keywordsAndTopics",
        }),
      ]),
    );
  });

  it("forms reliable fallback seeds from immutable project facts", () => {
    const result = prepareRecommendationSeeds({
      generationContractId: "generation-1",
      snapshot: {
        ...snapshot,
        keywords: [],
        categories: [],
        seoCompetitors: [],
      },
      userSeeds: [],
      systemCandidates: [],
    });

    expect(result.state).toBe("READY");
    expect(result.seeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "KEYWORD",
          normalizedValue: "seo monitoring",
          source: "SYSTEM_FALLBACK",
          validationStatus: "VERIFIED",
        }),
        expect.objectContaining({
          kind: "CATEGORY",
          normalizedValue: "growth teams",
          source: "SYSTEM_FALLBACK",
          validationStatus: "RETAINED_LOW_CONFIDENCE",
        }),
      ]),
    );
  });

  it("returns INPUT_REQUIRED when no reliable seed evidence exists", () => {
    const result = prepareRecommendationSeeds({
      generationContractId: "generation-1",
      snapshot: {
        ...snapshot,
        keywords: [],
        categories: [],
        products: [],
        targetAudiences: [],
        seoCompetitors: [],
      },
      userSeeds: [],
      systemCandidates: [
        {
          kind: "KEYWORD",
          value: "unverified AI suggestion",
          source: "SYSTEM_SUPPLEMENT",
          evidenceRefs: [
            {
              evidenceType: "FAKE_AI_CANDIDATE",
              recordId: "fake-ai-1",
              field: "suggestion",
            },
          ],
          confidenceBand: "MEDIUM",
        },
      ],
    });

    expect(result.state).toBe("INPUT_REQUIRED");
    expect(result.reasonCodes).toContain("DISCOVERY_SEEDS_REQUIRED");
    expect(result.seeds).toEqual([
      expect.objectContaining({
        normalizedValue: "unverified ai suggestion",
        validationStatus: "PENDING",
      }),
    ]);
    expect(result.blueprintSeedReferences).toEqual([]);
  });

  it("normalizes and deduplicates values within one generation", () => {
    const result = prepareRecommendationSeeds({
      generationContractId: "generation-1",
      snapshot: {
        ...snapshot,
        keywords: [],
        products: [],
        targetAudiences: [],
      },
      userSeeds: [
        { kind: "SEO_COMPETITOR", value: "https://WWW.Competitor.example/a" },
        { kind: "SEO_COMPETITOR", value: "competitor.example" },
      ],
      systemCandidates: [],
    });

    expect(
      result.seeds.filter(({ kind }) => kind === "SEO_COMPETITOR"),
    ).toHaveLength(1);
    expect(result.seeds[0]).toMatchObject({
      rawValue: "https://WWW.Competitor.example/a",
      normalizedValue: "competitor.example",
      source: "USER_INPUT",
    });
    expect(result.seeds[0]?.seedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps explicit user-edit supersession lineage", () => {
    const supersededSeedId = "99000000-0000-4000-8000-000000000011";
    const result = prepareRecommendationSeeds({
      generationContractId: "generation-1",
      snapshot: {
        ...snapshot,
        keywords: [],
        categories: [],
        products: [],
        targetAudiences: [],
        seoCompetitors: [],
      },
      userSeeds: [
        {
          kind: "KEYWORD",
          value: "Updated technical SEO",
          supersedesSeedId: supersededSeedId,
        },
      ],
      systemCandidates: [],
    });

    expect(result.seeds).toEqual([
      expect.objectContaining({
        source: "USER_INPUT",
        normalizedValue: "updated technical seo",
        supersedesSeedId: supersededSeedId,
      }),
    ]);
  });

  it("keeps fake AI candidates pending and outside Blueprint references", () => {
    const result = prepareRecommendationSeeds({
      generationContractId: "generation-1",
      snapshot: {
        ...snapshot,
        categories: [],
        products: [],
        targetAudiences: [],
        seoCompetitors: [],
      },
      userSeeds: [],
      systemCandidates: [
        {
          kind: "KEYWORD",
          value: "AI-only suggestion",
          source: "SYSTEM_SUPPLEMENT",
          evidenceRefs: [
            {
              evidenceType: "FAKE_AI_CANDIDATE",
              recordId: "fake-ai-2",
              field: "suggestion",
            },
          ],
          confidenceBand: "HIGH",
        },
      ],
    });

    const pending = result.seeds.find(
      ({ normalizedValue }) => normalizedValue === "ai-only suggestion",
    );
    expect(result.state).toBe("READY");
    expect(pending).toMatchObject({
      validationStatus: "PENDING",
      confidenceBand: "UNKNOWN",
    });
    expect(result.blueprintSeedReferences).toHaveLength(1);
    expect(result.blueprintSeedReferences).not.toContainEqual(
      expect.objectContaining({ seedFingerprint: pending?.seedFingerprint }),
    );
  });

  it("keeps fingerprints stable within a generation and scoped across generations", () => {
    const input = {
      snapshot: {
        ...snapshot,
        keywords: [],
        categories: [],
        products: [],
        targetAudiences: [],
        seoCompetitors: [],
      },
      userSeeds: [{ kind: "KEYWORD" as const, value: "Technical SEO" }],
      systemCandidates: [],
    };
    const first = prepareRecommendationSeeds({
      ...input,
      generationContractId: "generation-1",
    });
    const replay = prepareRecommendationSeeds({
      ...input,
      generationContractId: "generation-1",
    });
    const nextGeneration = prepareRecommendationSeeds({
      ...input,
      generationContractId: "generation-2",
    });

    expect(first.seeds[0]?.seedFingerprint).toBe(
      replay.seeds[0]?.seedFingerprint,
    );
    expect(first.seeds[0]?.seedFingerprint).not.toBe(
      nextGeneration.seeds[0]?.seedFingerprint,
    );
  });

  it("builds user and pre-task commands with scoped deterministic hashes", async () => {
    const calls: unknown[] = [];
    const commands = createRecommendationSeedCommands({
      prepare: async (input) => {
        calls.push(input);
        return {
          state: "READY",
          replayed: calls.length > 1,
          reasonCodes: [],
          snapshot,
          seeds: [],
          blueprintSeedReferences: [],
        };
      },
      validate: (input) => prepareRecommendationSeeds(input),
    });

    const userResult = await commands.generate({
      context: resolvedContext,
      idempotencyKey: "seed-user-1",
      requestId: "request-user-1",
      userSeeds: [{ kind: "KEYWORD", value: "Technical SEO" }],
      systemCandidates: [],
    });
    const fallbackResult = await commands.prepareBeforeTask({
      context: resolvedContext,
      idempotencyKey: "seed-task-1",
      requestId: "request-task-1",
      userSeeds: [],
      systemCandidates: [],
    });

    expect(userResult.state).toBe("READY");
    expect(fallbackResult.replayed).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        organizationId: "organization-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        trigger: "USER_TRIGGERED",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({
        trigger: "PRE_TASK_FALLBACK",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect((calls[0] as { requestHash: string }).requestHash).not.toBe(
      (calls[1] as { requestHash: string }).requestHash,
    );
  });

  it("denies seed mutation to viewers before repository access", async () => {
    let called = false;
    const commands = createRecommendationSeedCommands({
      prepare: async () => {
        called = true;
        throw new Error("unexpected");
      },
      validate: (input) => prepareRecommendationSeeds(input),
    });

    await expect(
      commands.generate({
        context: {
          ...resolvedContext,
          actor: createActorContext({
            userId: "viewer-1",
            sessionId: "viewer-session-1",
            roles: ["viewer"],
          }),
        },
        idempotencyKey: "seed-viewer-1",
        requestId: "request-viewer-1",
        userSeeds: [],
        systemCandidates: [],
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_ACCESS_DENIED" });
    expect(called).toBe(false);
  });
});
