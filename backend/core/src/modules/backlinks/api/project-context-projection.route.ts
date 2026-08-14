import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type {
  ProjectContextProjectionCommand,
} from "../application/commands/project-context-projection.command.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

const nonBlankString = z.string().trim().min(1).max(200);
const paramsSchema = z
  .object({ websiteProjectKey: nonBlankString })
  .strict();
const projectTextListSchema = z.array(
  z.string().trim().min(1).max(2_048),
).max(100);
const bodySchema = z
  .object({
    snapshotId: z.string().uuid(),
    snapshotVersion: z.number().int().positive(),
    projectStatus: z.enum(["ACTIVE", "PAUSED"]),
    canonicalDomain: nonBlankString,
    locale: nonBlankString,
    countryCode: nonBlankString,
    targetMarket: nonBlankString,
    profileVersionId: z.string().uuid(),
    promotionTargetVersionId: z.string().uuid(),
    products: projectTextListSchema,
    keywords: projectTextListSchema,
    targetUrls: z.array(z.string().trim().url().max(2_048)).max(100),
    targetAudiences: projectTextListSchema,
    partnershipGoals: projectTextListSchema,
    inputComplete: z.boolean(),
    jobId: z.string().uuid(),
    outboxEventId: z.string().uuid(),
  })
  .strict()
  .superRefine((body, context) => {
    if (!body.inputComplete) return;
    for (const field of [
      "products",
      "keywords",
      "targetUrls",
      "targetAudiences",
      "partnershipGoals",
    ] as const) {
      if (body[field].length === 0) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "A complete Website Project context cannot contain an empty list.",
        });
      }
    }
  });
const responseSchema = z
  .object({
    state: z.enum(["projected", "replayed"]),
    snapshotVersion: z.number().int().positive(),
    inputRequired: z.boolean(),
    jobScheduled: z.boolean(),
    jobId: z.string().uuid().nullable(),
  })
  .strict();

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
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

export function registerProjectContextProjectionRoute(
  app: FastifyInstance,
  command: ProjectContextProjectionCommand,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/internal/v1/projects/:websiteProjectKey/backlinks/project-context-projection",
    {
      schema: {
        hide: true,
        params: paramsSchema,
        body: bodySchema,
        response: {
          200: responseSchema,
          400: backlinkProblemDetailsSchema,
          401: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          409: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = request.platformContext;
      if (context.project === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.accessDenied,
          message: "A project-bound platform context is required.",
        });
      }
      return command.project({
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        actorId: context.actor.userId,
        actorSessionId: context.actor.sessionId,
        actorRoles: context.actor.roles,
        correlationId: context.correlationId,
        ...request.body,
      });
    },
  );
}
