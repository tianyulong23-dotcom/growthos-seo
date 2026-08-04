import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { SummaryQuery } from "../application/queries/summary.query.js";
import type { ActorContext } from "../domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: ActorContext;
  }
}

const nonBlankStringSchema = z.string().trim().min(1);
export const summaryParamsSchema = z
  .object({ websiteProjectKey: nonBlankStringSchema })
  .strict();
export const summaryResponseSchema = z
  .object({
    summary: z.object({}).strict(),
    meta: z
      .object({
        organizationId: nonBlankStringSchema,
        workspaceId: nonBlankStringSchema,
        websiteProjectId: nonBlankStringSchema,
        requestId: nonBlankStringSchema,
        schemaVersion: z.literal("backlinks.v1"),
        generatedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

function sendSummaryError(
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
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

export function registerBacklinksSummaryRoute(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule<SummaryQuery> }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/summary",
    {
      schema: {
        operationId: "backlinksGetSummaryV1",
        params: summaryParamsSchema,
        response: {
          200: summaryResponseSchema,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendSummaryError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const summary = await options.module.queries.getSummary(context);
      return {
        summary,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );
}
