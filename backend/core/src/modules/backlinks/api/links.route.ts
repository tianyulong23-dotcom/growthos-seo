import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type {
  createPlacementReverifyCommand,
} from "../application/commands/placement-reverify.command.js";
import type { PlacementLinksQuery } from "../application/queries/placement-links.query.js";
import {
  placementLinkCandidateParamsSchema,
  placementLinkCandidateResponseSchema,
  placementLinkEvidenceParamsSchema,
  placementLinkEvidenceResponseSchema,
  placementLinkEventsQuerySchema,
  placementLinkEventsResponseSchema,
  placementLinkPlacementParamsSchema,
  placementLinkPlacementResponseSchema,
  placementLinkReverifyBodySchema,
  placementLinkReverifyHeadersSchema,
  placementLinkReverifyResponseSchema,
  placementLinksListQuerySchema,
  placementLinksListResponseSchema,
  placementLinksParamsSchema,
} from "../application/schemas/placement-links.schema.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

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
  const normalized = error instanceof BacklinkError
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

function meta(
  context: Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>,
  requestId: string,
) {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    requestId,
    schemaVersion: "backlinks.v1" as const,
    generatedAt: new Date().toISOString(),
  };
}

export function registerBacklinksLinksRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule<PlacementLinksQuery>;
    reverifyCommand: ReturnType<typeof createPlacementReverifyCommand>;
  }>,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/links",
    {
      schema: {
        operationId: "backlinksListLinksV1",
        params: placementLinksParamsSchema,
        querystring: placementLinksListQuerySchema,
        response: { 200: placementLinksListResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const page = await options.module.queries.listLinks(context, request.query);
      return { ...page, meta: meta(context, request.id) };
    },
  );
  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/links/candidates/:candidateId",
    {
      schema: {
        operationId: "backlinksGetCandidateLinkV1",
        params: placementLinkCandidateParamsSchema,
        response: { 200: placementLinkCandidateResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const link = await options.module.queries.getCandidateLink(
        context,
        request.params.candidateId,
      );
      if (link === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Placement candidate link was not found.",
        });
      }
      return { link, meta: meta(context, request.id) };
    },
  );
  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/links/placements/:placementId",
    {
      schema: {
        operationId: "backlinksGetPlacementLinkV1",
        params: placementLinkPlacementParamsSchema,
        response: { 200: placementLinkPlacementResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const link = await options.module.queries.getPlacementLink(
        context,
        request.params.placementId,
      );
      if (link === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Placement link was not found.",
        });
      }
      return { link, meta: meta(context, request.id) };
    },
  );
  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/links/placements/:placementId/events",
    {
      schema: {
        operationId: "backlinksListPlacementLifecycleEventsV1",
        params: placementLinkPlacementParamsSchema,
        querystring: placementLinkEventsQuerySchema,
        response: { 200: placementLinkEventsResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const page = await options.module.queries.listPlacementEvents(
        context,
        request.params.placementId,
        request.query,
      );
      if (page === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Placement link was not found.",
        });
      }
      return { ...page, meta: meta(context, request.id) };
    },
  );
  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/links/evidence/:evidenceId",
    {
      schema: {
        operationId: "backlinksGetPlacementEvidenceV1",
        params: placementLinkEvidenceParamsSchema,
        response: { 200: placementLinkEvidenceResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const evidence = await options.module.queries.getPlacementEvidence(
        context,
        request.params.evidenceId,
      );
      if (evidence === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Placement evidence was not found.",
        });
      }
      return { evidence, meta: meta(context, request.id) };
    },
  );
  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/links/placements/:placementId/reverify",
    {
      schema: {
        operationId: "backlinksReverifyPlacementV1",
        headers: placementLinkReverifyHeadersSchema,
        params: placementLinkPlacementParamsSchema,
        body: placementLinkReverifyBodySchema,
        response: { 202: placementLinkReverifyResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.reverifyCommand.execute({
        context,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        placementId: request.params.placementId,
        expectedVersion: request.body.expectedVersion,
      });
      return reply.code(202).send({
        ...result,
        meta: meta(context, request.id),
      });
    },
  );
}
