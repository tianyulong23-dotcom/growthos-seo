import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type {
  NegotiationFactsService,
} from "../application/services/negotiation-facts.service.js";
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
const idempotencyHeaders = z.object({
  "idempotency-key": nonBlank.max(200),
});
const params = z.object({
  websiteProjectKey: nonBlank,
  inboundMessageId: z.uuid(),
}).strict();
const fact = z.object({
  id: z.uuid(),
  inboundMessageId: z.uuid(),
  opportunityId: z.uuid(),
  factKey: nonBlank,
  factVersion: z.number().int().positive(),
  factType: nonBlank,
  rawValue: nonBlank,
  normalizedValue: z.unknown(),
  factAuthority: z.enum(["INFERRED", "MANUAL"]),
  reviewStatus: z.enum([
    "PENDING",
    "CONFIRMED",
    "REJECTED",
    "SUPERSEDED",
  ]),
  extractorType: z.enum(["RULE", "AI", "MANUAL"]),
  extractorVersion: nonBlank,
  confidenceScore: z.number().min(0).max(1),
  evidenceText: nonBlank,
  evidenceStart: z.number().int().nonnegative(),
  evidenceEnd: z.number().int().positive(),
  supersedesFactVersionId: z.uuid().nullable(),
  decidedBy: nonBlank.nullable(),
  decidedAt: z.string().datetime().nullable(),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  createdBy: nonBlank,
}).strict();
const meta = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();
const listResponse = z.object({
  inboundMessageId: z.uuid(),
  opportunityId: z.uuid(),
  items: z.array(fact),
  meta,
}).strict();
const decision = z.enum(["CONFIRM", "REJECT", "CORRECT"]);
const decisionBody = z.object({
  sourceFactVersionId: z.uuid(),
  expectedFactVersion: z.number().int().positive(),
  decision,
  reason: nonBlank.max(500),
  correction: z.object({
    factType: nonBlank,
    rawValue: nonBlank,
    normalizedValue: z.unknown(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "CORRECT" && value.correction === undefined) {
    context.addIssue({
      code: "custom",
      path: ["correction"],
      message: "Correction is required for CORRECT decisions.",
    });
  }
  if (value.decision !== "CORRECT" && value.correction !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["correction"],
      message: "Correction is only valid for CORRECT decisions.",
    });
  }
});
const decisionResponse = z.object({
  decision,
  replayed: z.boolean(),
  appendedFactVersionIds: z.array(z.uuid()).min(1).max(2),
  latestFact: fact,
  meta,
}).strict();
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

const responseMeta = (
  request: FastifyRequest,
  context: Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>,
) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  requestId: request.id,
  schemaVersion: "backlinks.v1" as const,
  generatedAt: new Date().toISOString(),
});

export function registerBacklinksNegotiationFactsRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    service: NegotiationFactsService;
  }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const path =
    "/api/v1/projects/:websiteProjectKey/backlinks/replies/"
    + ":inboundMessageId/negotiation-facts";

  api.get(
    path,
    {
      schema: {
        operationId: "backlinksListNegotiationFactsV1",
        params,
        response: { 200: listResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.service.list(
        context,
        request.params.inboundMessageId,
      );
      return listResponse.parse({
        ...result,
        items: [...result.items],
        meta: responseMeta(request, context),
      });
    },
  );

  api.post(
    `${path}/decisions`,
    {
      schema: {
        operationId: "backlinksReviewNegotiationFactV1",
        params,
        headers: idempotencyHeaders,
        body: decisionBody,
        response: { 200: decisionResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.service.decide({
        context,
        inboundMessageId: request.params.inboundMessageId,
        sourceFactVersionId: request.body.sourceFactVersionId,
        expectedFactVersion: request.body.expectedFactVersion,
        decision: request.body.decision,
        reason: request.body.reason,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        ...(request.body.correction === undefined
          ? {}
          : { correction: request.body.correction }),
      });
      return decisionResponse.parse({
        ...result,
        appendedFactVersionIds: [...result.appendedFactVersionIds],
        meta: responseMeta(request, context),
      });
    },
  );
}
