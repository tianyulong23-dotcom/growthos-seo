import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type { RecommendationUserReleaseCommands } from "../application/commands/recommendation-user-release.command.js";
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
const itemParams = projectParams
  .extend({
    itemId: z.uuid(),
  })
  .strict();
const idempotencyHeaders = z.object({
  "idempotency-key": nonBlank.max(200),
});
const meta = z
  .object({
    organizationId: nonBlank,
    workspaceId: nonBlank,
    websiteProjectId: nonBlank,
    requestId: nonBlank,
    schemaVersion: z.literal("backlinks.recommendation-user-release.v2"),
    generatedAt: z.string().datetime(),
  })
  .strict();
const publicationResponse = z
  .object({
    state: z.enum(["PUBLISHED", "NOT_READY"]),
    currentBatchOrdinal: z.number().int().positive().nullable(),
    replayed: z.boolean(),
    meta,
  })
  .strict();
const statusResponse = z
  .object({
    state: z.enum(["PUBLISHED", "NOT_PUBLISHED"]),
    currentBatchOrdinal: z.number().int().positive().nullable(),
    requiredOpportunityCount: z.number().int().nonnegative().nullable(),
    successfulOpportunityCount: z.number().int().nonnegative(),
    unlockAt: z.string().datetime().nullable(),
    unlockReason: z.enum(["OPPORTUNITY_RATIO", "ELAPSED_18H", "NO_GATE"]).nullable(),
    canGetMore: z.boolean(),
    getMoreState: z.enum([
      "INITIAL_BATCH_NOT_PUBLISHED",
      "RELEASE_NEXT",
      "NOT_UNLOCKED",
      "NEXT_BATCH_PREPARING",
      "POOL_EXHAUSTED",
    ]),
    meta,
  })
  .strict();
const getMoreResponse = z
  .object({
    state: z.enum([
      "RELEASED",
      "NOT_UNLOCKED",
      "NEXT_BATCH_PREPARING",
      "POOL_EXHAUSTED",
      "INITIAL_BATCH_NOT_READY",
    ]),
    currentBatchOrdinal: z.number().int().positive().nullable(),
    releasedBatchOrdinal: z.number().int().positive().nullable(),
    replayed: z.boolean(),
    meta,
  })
  .strict();
const archiveResponse = z
  .object({
    itemId: z.uuid(),
    archived: z.boolean(),
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
    schemaVersion: "backlinks.recommendation-user-release.v2" as const,
    generatedAt: new Date().toISOString(),
  };
}

export function registerBacklinksRecommendationUserReleaseRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: RecommendationUserReleaseCommands;
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

  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-user-release/publish-initial",
    {
      schema: {
        operationId: "backlinksPublishInitialRecommendationBatchV2",
        params: projectParams,
        response: { 200: publicationResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolveContext(request);
      return {
        ...(await options.commands.publishInitial({ context })),
        meta: responseMeta(context, request.id),
      };
    },
  );
  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-user-release/status",
    {
      schema: {
        operationId: "backlinksGetRecommendationFeedStatusV2",
        params: projectParams,
        response: { 200: statusResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolveContext(request);
      const status = await options.commands.getStatus({ context });
      return {
        ...status,
        unlockAt: status.unlockAt?.toISOString() ?? null,
        meta: responseMeta(context, request.id),
      };
    },
  );
  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-user-release/get-more",
    {
      schema: {
        operationId: "backlinksGetMoreRecommendationFeedV2",
        headers: idempotencyHeaders,
        params: projectParams,
        response: { 200: getMoreResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolveContext(request);
      return {
        ...(await options.commands.getMore({
          context,
          idempotencyKey: request.headers["idempotency-key"],
        })),
        meta: responseMeta(context, request.id),
      };
    },
  );

  for (const archived of [true, false] as const) {
    typed.post(
      `/api/v1/projects/:websiteProjectKey/backlinks/recommendation-user-release/items/:itemId/${archived ? "archive" : "unarchive"}`,
      {
        schema: {
          operationId: archived
            ? "backlinksArchiveRecommendationFeedItemV2"
            : "backlinksUnarchiveRecommendationFeedItemV2",
          headers: idempotencyHeaders,
          params: itemParams,
          response: { 200: archiveResponse, ...errors },
        },
        errorHandler: sendError,
      },
      async (request) => {
        const context = await resolveContext(request);
        return {
          ...(await options.commands.setArchived({
            context,
            itemId: request.params.itemId,
            archived,
            idempotencyKey: request.headers["idempotency-key"],
          })),
          meta: responseMeta(context, request.id),
        };
      },
    );
  }
}
