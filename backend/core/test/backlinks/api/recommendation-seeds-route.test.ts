import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createRecommendationSeedCommands } from "../../../src/modules/backlinks/application/commands/recommendation-seeds.command.js";
import { prepareRecommendationSeeds } from "../../../src/modules/backlinks/application/services/recommendation-seed-preparation.service.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { registerBacklinksRecommendationSeedRoutes } from "../../../src/modules/backlinks/api/recommendation-seeds.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";

const contextId = "99000000-0000-4000-8000-000000000001";
const profileId = "99000000-0000-4000-8000-000000000002";
const seedId = "99000000-0000-4000-8000-000000000003";
const blueprintId = "99000000-0000-4000-8000-000000000004";
const blueprintSeedId = "99000000-0000-4000-8000-000000000005";
const member = createActorContext({
  userId: "seed-member",
  sessionId: "seed-session",
  roles: ["member"],
});
const snapshot = {
  projectContextSnapshotId: contextId,
  projectContextSnapshotVersion: 3,
  canonicalDomain: "project.example",
  locale: "en-US",
  countryCode: "US",
  siteProfileVersionId: "site-profile-v3",
  outreachProfileVersionId: profileId,
  outreachProfileFingerprint: "outreach-fingerprint-v3",
  promotionTargetVersionId: "promotion-v3",
  market: "US",
  location: "United States",
  language: "en",
  keywords: [],
  categories: [],
  products: ["SEO monitoring"],
  targetAudiences: [],
  seoCompetitors: [],
} as const;
const baseContext = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "seed-organization",
    workspaceId: "seed-workspace",
  }),
  project: createProjectContext({
    websiteProjectId: "seed-project",
    canonicalDomain: "project.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "site-profile-v3",
    promotionTargetVersionId: "promotion-v3",
  }),
};

describe("Phase 2 recommendation seed routes", () => {
  const calls: unknown[] = [];
  const commands = createRecommendationSeedCommands({
    prepare: async (input) => {
      calls.push(input);
      const prepared = prepareRecommendationSeeds({
        generationContractId: "seed-generation-v2",
        snapshot,
        userSeeds: input.userSeeds,
        systemCandidates: input.systemCandidates,
      });
      const seeds = prepared.seeds.map((seed, index) => ({
        ...seed,
        id:
          index === 0
            ? seedId
            : `99000000-0000-4000-8000-${String(index + 3).padStart(12, "0")}`,
      }));
      return {
        ...prepared,
        replayed: false,
        confirmation:
          prepared.state === "READY"
            ? {
                generationContractId: "99000000-0000-4000-8000-000000000006",
                seedSnapshotFingerprint: "a".repeat(64),
              }
            : null,
        snapshot,
        seeds,
        blueprintSeedReferences: seeds
          .filter(
            ({ validationStatus }) =>
              validationStatus === "VERIFIED" ||
              validationStatus === "RETAINED_LOW_CONFIDENCE",
          )
          .map((seed, index) => ({
            id:
              index === 0
                ? blueprintSeedId
                : `99000000-0000-4000-9000-${String(index + 5).padStart(12, "0")}`,
            blueprintId,
            seedId: seed.id,
            seedFingerprint: seed.seedFingerprint,
            seedOrdinal: index + 1,
          })),
      };
    },
    validate: async (input) => {
      calls.push(input);
      return prepareRecommendationSeeds({
        generationContractId: "seed-generation-v2",
        snapshot,
        userSeeds: input.userSeeds,
        systemCandidates: input.systemCandidates,
      });
    },
  });
  const lifecycleCommands = Object.freeze({
    ...commands,
    launch: async () => ({
      generationContractId: "99000000-0000-4000-8000-000000000006",
      visiblePoolGeneration: 4,
      jobId: "99000000-0000-4000-8000-000000000007",
      workflowId: "recommendation-pool-v2:seed-project:generation-4",
      state: "STARTED" as const,
      replayed: false,
    }),
  });
  const app = Fastify({
    logger: false,
    genReqId: () => "seed-route-request",
  });

  afterAll(() => app.close());

  it("exposes isolated generate and validate endpoints without provider input", async () => {
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor =
        request.headers["x-role"] === "viewer"
          ? createActorContext({
              userId: "seed-viewer",
              sessionId: "seed-viewer-session",
              roles: ["viewer"],
            })
          : member;
    });
    registerBacklinksRecommendationSeedRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor }) => ({ ...baseContext, actor }),
        },
        queries: {},
      }),
      commands: lifecycleCommands,
    });
    await app.ready();

    const generated = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-seeds/generate",
      headers: { "idempotency-key": "seed-route-generate" },
      payload: {
        seeds: [{ kind: "KEYWORD", value: "Technical SEO" }],
      },
    });
    expect(generated.statusCode).toBe(200);
    const generatedBody = generated.json();
    expect(generatedBody).toMatchObject({
      state: "READY",
      replayed: false,
      confirmation: {
        generationContractId: "99000000-0000-4000-8000-000000000006",
        seedSnapshotFingerprint: "a".repeat(64),
      },
      snapshot: {
        projectContextSnapshotId: contextId,
        outreachProfileVersionId: profileId,
      },
      meta: {
        organizationId: "seed-organization",
        workspaceId: "seed-workspace",
        websiteProjectId: "seed-project",
        requestId: "seed-route-request",
        schemaVersion: "backlinks.recommendation-seeds.v2",
      },
    });
    expect(generatedBody.seeds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: seedId,
          source: "USER_INPUT",
          normalizedValue: "technical seo",
        }),
        expect.objectContaining({
          source: "SYSTEM_FALLBACK",
          normalizedValue: "seo monitoring",
        }),
      ]),
    );
    expect(generatedBody.blueprintSeedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: blueprintSeedId,
          blueprintId,
          seedId,
          seedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          seedOrdinal: 1,
        }),
      ]),
    );
    expect(calls[0]).toMatchObject({
      organizationId: "seed-organization",
      workspaceId: "seed-workspace",
      websiteProjectId: "seed-project",
      actorId: "seed-member",
      trigger: "USER_TRIGGERED",
      idempotencyKey: "seed-route-generate",
      systemCandidates: [],
    });

    const validated = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-seeds/validate",
      payload: { seeds: [] },
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({
      state: "READY",
      seeds: [
        {
          source: "SYSTEM_FALLBACK",
          normalizedValue: "seo monitoring",
        },
      ],
      blueprintSeedReferences: [
        {
          seedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          seedOrdinal: 1,
        },
      ],
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-seeds/generate",
      headers: {
        "idempotency-key": "seed-route-viewer",
        "x-role": "viewer",
      },
      payload: { seeds: [] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: "BACKLINK_ACCESS_DENIED",
    });
    expect(calls).toHaveLength(2);

    const launched = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-seeds/launch",
      headers: { "idempotency-key": "seed-route-launch" },
      payload: {
        generationContractId: "99000000-0000-4000-8000-000000000006",
        seedSnapshotFingerprint: "a".repeat(64),
      },
    });
    expect(launched.statusCode).toBe(200);
    expect(launched.json()).toMatchObject({
      state: "STARTED",
      visiblePoolGeneration: 4,
      meta: {
        schemaVersion: "backlinks.recommendation-seeds.v2",
      },
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects/project-key/backlinks/recommendation-seeds/generate",
          payload: { seeds: [] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("returns INPUT_REQUIRED without fabricating empty-project seeds", async () => {
    const emptyApp = Fastify({
      logger: false,
      genReqId: () => "seed-empty-route-request",
    });
    const emptySnapshot = {
      ...snapshot,
      keywords: [],
      categories: [],
      products: [],
      targetAudiences: [],
      seoCompetitors: [],
    };
    const emptyCommands = createRecommendationSeedCommands({
      prepare: async (input) => {
        const prepared = prepareRecommendationSeeds({
          generationContractId: "seed-empty-generation-v2",
          snapshot: emptySnapshot,
          userSeeds: input.userSeeds,
          systemCandidates: input.systemCandidates,
        });
        return {
          ...prepared,
          replayed: false,
          confirmation: null,
          snapshot: emptySnapshot,
          seeds: [],
          blueprintSeedReferences: [],
        };
      },
      validate: (input) =>
        Promise.resolve(
          prepareRecommendationSeeds({
            generationContractId: "seed-empty-generation-v2",
            snapshot: emptySnapshot,
            userSeeds: input.userSeeds,
            systemCandidates: input.systemCandidates,
          }),
        ),
    });

    try {
      await registerBacklinksOpenApi(emptyApp);
      emptyApp.decorateRequest("actor");
      emptyApp.addHook("preHandler", async (request) => {
        request.actor = member;
      });
      registerBacklinksRecommendationSeedRoutes(emptyApp, {
        module: createBacklinksModule({
          projectContext: {
            resolve: async () => baseContext,
          },
          queries: {},
        }),
        commands: Object.freeze({
          ...emptyCommands,
          launch: async () => {
            throw new Error("launch must not be called");
          },
        }),
      });
      await emptyApp.ready();

      const response = await emptyApp.inject({
        method: "POST",
        url: "/api/v1/projects/project-key/backlinks/recommendation-seeds/generate",
        headers: { "idempotency-key": "seed-route-empty" },
        payload: { seeds: [] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        state: "INPUT_REQUIRED",
        reasonCodes: ["DISCOVERY_SEEDS_REQUIRED"],
        seeds: [],
        blueprintSeedReferences: [],
      });
    } finally {
      await emptyApp.close();
    }
  });
});
