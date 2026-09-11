import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type { RecommendationSeedPersisted } from "../application/commands/recommendation-seeds.command.js";
import type { RecommendationPoolV2GenerationLifecycleCommands } from "../application/services/recommendation-pool-v2-generation-launcher.service.js";
import type { PreparedRecommendationSeed } from "../application/services/recommendation-seed-preparation.service.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

const nonBlank = z.string().trim().min(1);
const projectParams = z
  .object({
    websiteProjectKey: nonBlank,
  })
  .strict();
const idempotencyHeaders = z.object({
  "idempotency-key": nonBlank.max(200),
});
const seedKind = z.enum(["KEYWORD", "CATEGORY", "SEO_COMPETITOR"]);
const seedBody = z
  .object({
    seeds: z
      .array(
        z
          .object({
            kind: seedKind,
            value: nonBlank.max(500),
            supersedesSeedId: z.uuid().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const evidenceRef = z
  .object({
    evidenceType: z.enum([
      "USER_INPUT",
      "PROJECT_CONTEXT",
      "SITE_PROFILE",
      "OUTREACH_PROFILE",
      "PROVIDER_VALIDATION",
      "FAKE_AI_CANDIDATE",
    ]),
    recordId: nonBlank,
    field: nonBlank,
    fingerprint: nonBlank.optional(),
  })
  .strict();
const preparedSeed = z
  .object({
    kind: seedKind,
    rawValue: nonBlank,
    normalizedValue: nonBlank,
    source: z.enum([
      "USER_INPUT",
      "USER_TRIGGERED_GENERATION",
      "SYSTEM_FALLBACK",
      "SYSTEM_SUPPLEMENT",
    ]),
    validationStatus: z.enum([
      "PENDING",
      "VERIFIED",
      "RETAINED_LOW_CONFIDENCE",
      "REJECTED",
    ]),
    validationReasonCodes: z.array(nonBlank),
    evidenceRefs: z.array(evidenceRef),
    confidenceBand: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
    seedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    supersedesSeedId: z.uuid().nullable(),
  })
  .strict();
const snapshot = z
  .object({
    projectContextSnapshotId: z.uuid(),
    projectContextSnapshotVersion: z.number().int().positive(),
    canonicalDomain: nonBlank,
    locale: nonBlank,
    countryCode: nonBlank,
    siteProfileVersionId: nonBlank,
    outreachProfileVersionId: z.uuid(),
    outreachProfileFingerprint: nonBlank,
    promotionTargetVersionId: nonBlank,
    market: nonBlank,
    location: nonBlank,
    language: nonBlank,
    keywords: z.array(nonBlank),
    categories: z.array(nonBlank),
    products: z.array(nonBlank),
    targetAudiences: z.array(nonBlank),
    seoCompetitors: z.array(nonBlank),
  })
  .strict();
const meta = z
  .object({
    organizationId: nonBlank,
    workspaceId: nonBlank,
    websiteProjectId: nonBlank,
    requestId: nonBlank,
    schemaVersion: z.literal("backlinks.recommendation-seeds.v2"),
    generatedAt: z.string().datetime(),
  })
  .strict();
const validationResponse = z
  .object({
    state: z.enum(["READY", "INPUT_REQUIRED"]),
    reasonCodes: z.array(nonBlank),
    seeds: z.array(preparedSeed),
    blueprintSeedReferences: z.array(
      z
        .object({
          seedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          seedOrdinal: z.number().int().positive(),
        })
        .strict(),
    ),
    meta,
  })
  .strict();
const generateResponse = z
  .object({
    state: z.enum(["READY", "INPUT_REQUIRED"]),
    replayed: z.boolean(),
    reasonCodes: z.array(nonBlank),
    confirmation: z
      .object({
        generationContractId: z.uuid(),
        seedSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .nullable(),
    snapshot,
    seeds: z.array(preparedSeed.extend({ id: z.uuid() }).strict()),
    blueprintSeedReferences: z.array(
      z
        .object({
          id: z.uuid(),
          blueprintId: z.uuid(),
          seedId: z.uuid(),
          seedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          seedOrdinal: z.number().int().positive(),
        })
        .strict(),
    ),
    meta,
  })
  .strict();
const launchBody = z
  .object({
    generationContractId: z.uuid(),
    seedSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const launchResponse = z
  .object({
    generationContractId: z.uuid(),
    visiblePoolGeneration: z.number().int().positive(),
    jobId: z.uuid(),
    workflowId: nonBlank,
    state: z.enum(["STARTED", "ALREADY_STARTED"]),
    replayed: z.boolean(),
    meta,
  })
  .strict();
const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  409: backlinkProblemDetailsSchema,
  500: backlinkProblemDetailsSchema,
};

function sendError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const normalized =
    error instanceof BacklinkError
      ? error
      : error.validation === undefined
        ? error
        : new BacklinkError({
            code: backlinkErrorCodes.invalidRequest,
            message: "Request validation failed.",
          });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply
    .code(problem.status)
    .type(backlinkProblemContentType)
    .send(problem);
}

function responseMeta(
  context: Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>,
  requestId: string,
) {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    requestId,
    schemaVersion: "backlinks.recommendation-seeds.v2" as const,
    generatedAt: new Date().toISOString(),
  };
}

function responsePreparedSeed(seed: PreparedRecommendationSeed) {
  return {
    ...seed,
    validationReasonCodes: [...seed.validationReasonCodes],
    evidenceRefs: seed.evidenceRefs.map((reference) => ({ ...reference })),
  };
}

function responsePersistedSeed(
  seed: RecommendationSeedPersisted["seeds"][number],
) {
  return {
    ...responsePreparedSeed(seed),
    id: seed.id,
  };
}

function responseSnapshot(
  value: Awaited<
    ReturnType<RecommendationPoolV2GenerationLifecycleCommands["generate"]>
  >["snapshot"],
) {
  return {
    ...value,
    keywords: [...value.keywords],
    categories: [...value.categories],
    products: [...value.products],
    targetAudiences: [...value.targetAudiences],
    seoCompetitors: [...value.seoCompetitors],
  };
}

export function registerBacklinksRecommendationSeedRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: RecommendationPoolV2GenerationLifecycleCommands;
  }>,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-seeds/generate",
    {
      schema: {
        operationId: "backlinksGenerateRecommendationSeedsV2",
        headers: idempotencyHeaders,
        params: projectParams,
        body: seedBody,
        response: { 200: generateResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.generate({
        context,
        idempotencyKey: request.headers["idempotency-key"],
        requestId: request.id,
        userSeeds: request.body.seeds,
        systemCandidates: [],
      });
      return {
        ...result,
        reasonCodes: [...result.reasonCodes],
        snapshot: responseSnapshot(result.snapshot),
        seeds: result.seeds.map(responsePersistedSeed),
        blueprintSeedReferences: result.blueprintSeedReferences.map(
          (reference) => ({ ...reference }),
        ),
        meta: responseMeta(context, request.id),
      };
    },
  );
  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-seeds/launch",
    {
      schema: {
        operationId: "backlinksLaunchRecommendationPoolV2",
        headers: idempotencyHeaders,
        params: projectParams,
        body: launchBody,
        response: { 200: launchResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.launch({
        context,
        idempotencyKey: request.headers["idempotency-key"],
        requestId: request.id,
        generationContractId: request.body.generationContractId,
        seedSnapshotFingerprint: request.body.seedSnapshotFingerprint,
      });
      return {
        ...result,
        meta: responseMeta(context, request.id),
      };
    },
  );
  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-seeds/validate",
    {
      schema: {
        operationId: "backlinksValidateRecommendationSeedsV2",
        params: projectParams,
        body: seedBody,
        response: { 200: validationResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.validate({
        context,
        userSeeds: request.body.seeds,
        systemCandidates: [],
      });
      return {
        ...result,
        reasonCodes: [...result.reasonCodes],
        seeds: result.seeds.map(responsePreparedSeed),
        blueprintSeedReferences: result.blueprintSeedReferences.map(
          (reference) => ({ ...reference }),
        ),
        meta: responseMeta(context, request.id),
      };
    },
  );
}
