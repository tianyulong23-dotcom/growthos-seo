import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
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
export const contextParamsSchema = z
  .object({ websiteProjectKey: nonBlankStringSchema })
  .strict();
export const contextResponseSchema = z
  .object({
    actor: z
      .object({
        userId: nonBlankStringSchema,
        sessionId: nonBlankStringSchema,
        roles: z.array(nonBlankStringSchema),
      })
      .strict(),
    tenant: z
      .object({
        organizationId: nonBlankStringSchema,
        workspaceId: nonBlankStringSchema,
      })
      .strict(),
    project: z
      .object({
        websiteProjectId: nonBlankStringSchema,
        canonicalDomain: nonBlankStringSchema,
        locale: nonBlankStringSchema,
        countryCode: nonBlankStringSchema,
        profileVersionId: nonBlankStringSchema,
        promotionTargetVersionId: nonBlankStringSchema,
      })
      .strict(),
  })
  .strict();

function sendContextError(
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

export function registerBacklinksContextRoute(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/context",
    {
      schema: {
        operationId: "backlinksGetProjectContextV1",
        params: contextParamsSchema,
        response: {
          200: contextResponseSchema,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendContextError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return {
        actor: { ...context.actor, roles: [...context.actor.roles] },
        tenant: { ...context.tenant },
        project: { ...context.project },
      };
    },
  );
}
