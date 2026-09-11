import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type { RecommendationFeedObserver } from "../db/repositories/recommendation-pool-v2-timing.repository.js";
import {
  recommendationFeedSorts,
  type RecommendationFeedQuery,
} from "../application/queries/recommendation-feed.query.js";
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
const queryBoolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const sharedFilterFields = {
  batchId: z.uuid().optional(),
  category: nonBlank.optional(),
  trafficMin: z.coerce.number().min(0).optional(),
  trafficMax: z.coerce.number().min(0).optional(),
  rankMin: z.coerce.number().min(0).optional(),
  rankMax: z.coerce.number().min(0).optional(),
  spamMin: z.coerce.number().min(0).max(100).optional(),
  spamMax: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(recommendationFeedSorts).optional(),
  domainSearch: nonBlank.optional(),
} as const;
const feedQuery = z
  .object({
    recommendedOnly: queryBoolean.optional(),
    ...sharedFilterFields,
    cursor: nonBlank.max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(35),
  })
  .strict();
const exportFilters = z
  .object({
    recommendedOnly: z.boolean().optional(),
    ...sharedFilterFields,
  })
  .strict();
const exportBody = z
  .object({
    selectedItemIds: z.array(z.uuid()).min(1).max(1_000).optional(),
    filters: exportFilters.optional(),
  })
  .strict();
const publicItem = z
  .object({
    itemId: z.uuid(),
    domain: nonBlank,
    displayUrl: z.url(),
    recommended: z.boolean(),
    reasons: z.array(nonBlank),
    category: z.string().nullable(),
    metrics: z
      .object({
        targetMarketOrganicTraffic: z.number().nullable(),
        ahrefsDr: z.number().nullable().optional(),
        libraryMonthlyTraffic: z.number().nullable().optional(),
        dataForSeoRank: z.number().nullable(),
        spamScore: z.number().nullable(),
      })
      .strict(),
    contact: z
      .object({
        email: z.email().nullable(),
        contactPage: z.url().nullable(),
        outcome: nonBlank,
      })
      .strict(),
    opportunity: z
      .object({
        opportunityId: z.uuid().nullable(),
        businessStage: z.string().nullable(),
        managementStatus: z.string().nullable(),
        outcomeStatus: z.string().nullable(),
        createdByCurrentUser: z.boolean(),
      })
      .strict(),
    archived: z.literal(false),
    releasedAt: z.string().datetime(),
  })
  .strict();
const latestGeneration = z
  .object({
    generationContractId: z.uuid(),
    visiblePoolGeneration: z.number().int().positive(),
    jobState: nonBlank,
    progress: z.number().int().min(0).max(100),
    discoveryResult: nonBlank,
    contactPreparation: nonBlank,
    releaseResult: nonBlank,
    effectiveUniqueCandidateCount: z.number().int().nonnegative(),
    admittedCount: z.number().int().nonnegative(),
    releasedCount: z.number().int().nonnegative(),
    terminalReason: z.string().nullable(),
    retrySafe: z.boolean(),
  })
  .strict();
const releasedPool = z
  .object({
    generationCount: z.number().int().nonnegative(),
    oldestVisiblePoolGeneration: z.number().int().positive().nullable(),
    newestVisiblePoolGeneration: z.number().int().positive().nullable(),
    filterOptions: z.object({
      batches: z.array(z.object({
        batchId: z.uuid(),
        batchOrdinal: z.number().int().positive(),
        visiblePoolGeneration: z.number().int().positive(),
        releasedAt: z.string(),
        count: z.number().int().nonnegative(),
      }).strict()),
      categories: z.array(z.string()),
      hasUncategorized: z.boolean(),
    }).strict().optional(),
  })
  .strict();
const meta = z
  .object({
    organizationId: nonBlank,
    workspaceId: nonBlank,
    websiteProjectId: nonBlank,
    requestId: nonBlank,
    schemaVersion: z.literal("backlinks.recommendation-feed.v2"),
    generatedAt: z.string().datetime(),
  })
  .strict();
const feedResponse = z
  .object({
    items: z.array(publicItem),
    releasedPool,
    latestGeneration: latestGeneration.nullable(),
    totalCount: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
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
    schemaVersion: "backlinks.recommendation-feed.v2" as const,
    generatedAt: new Date().toISOString(),
  };
}

export function registerRecommendationFeedRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    query: RecommendationFeedQuery;
    observe?: RecommendationFeedObserver | undefined;
  }>,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const resolveContext = (request: {
    actor: FastifyRequest["actor"];
    params: z.infer<typeof projectParams>;
  }) =>
    options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });

  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed",
    {
      schema: {
        operationId: "backlinksListRecommendationFeedV2",
        params: projectParams,
        querystring: feedQuery,
        response: { 200: feedResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolveContext(request);
      const result = await options.query.list(context, request.query);
      return {
        items: result.items.map((item) => ({
          itemId: item.itemId,
          domain: item.domain,
          displayUrl: item.displayUrl,
          recommended: item.recommended,
          reasons: [...item.recommendationReasons],
          category: item.category,
          metrics: item.metrics,
          contact: item.contact,
          opportunity: item.opportunity,
          archived: item.archived,
          releasedAt: item.releasedAt,
        })),
        releasedPool: {
          ...result.releasedPool,
          filterOptions: result.releasedPool.filterOptions ? {
            ...result.releasedPool.filterOptions,
            batches: [...result.releasedPool.filterOptions.batches],
            categories: [...result.releasedPool.filterOptions.categories],
          } : undefined,
        },
        latestGeneration: result.latestGeneration,
        totalCount: result.totalCount,
        nextCursor: result.nextCursor,
        meta: responseMeta(context, request.id),
      };
    },
  );

  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/observations",
    {
      schema: {
        operationId: "backlinksObserveRecommendationFeedV2",
        params: projectParams,
        body: z.object({
          generationContractId: z.uuid(),
          observedState: z.string().max(256).regex(
            /^[A-Z][A-Z0-9_]{0,63}\|[A-Z][A-Z0-9_]{0,63}\|[A-Z][A-Z0-9_]{0,63}\|[A-Z][A-Z0-9_]{0,63}$/,
          ),
          clientObservedAt: z.string().datetime(),
        }).strict(),
        response: { 200: z.object({ recorded: z.literal(true) }).strict(), ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolveContext(request);
      if (!options.observe) {
        throw new Error("Recommendation feed observation recorder is unavailable.");
      }
      await options.observe(context, request.body);
      return { recorded: true as const };
    },
  );

  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-feed/export",
    {
      schema: {
        operationId: "backlinksExportRecommendationFeedV2",
        params: projectParams,
        body: exportBody,
        response: { 200: z.string(), ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await resolveContext(request);
      const exported = await options.query.export(context, {
        ...(request.body.filters ?? {}),
        selectedItemIds: request.body.selectedItemIds,
      });
      return reply
        .type(exported.contentType)
        .header(
          "content-disposition",
          `attachment; filename="${exported.fileName}"`,
        )
        .send(exported.content);
    },
  );
}
