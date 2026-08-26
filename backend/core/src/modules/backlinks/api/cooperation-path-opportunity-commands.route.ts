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
  createCooperationPathOpportunityCommands,
} from "../application/commands/cooperation-path-opportunities.command.js";
import {
  manualActionStates,
  nonEmailCooperationPathTypes,
} from "../domain/opportunities/cooperation-path.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Commands = ReturnType<typeof createCooperationPathOpportunityCommands>;

const nonBlank = z.string().trim().min(1);
const headers = z.object({ "idempotency-key": nonBlank.max(200) });
const projectParams = z.object({ websiteProjectKey: nonBlank }).strict();
const opportunityParams = z.object({
  websiteProjectKey: nonBlank,
  opportunityId: z.uuid(),
}).strict();
const evidenceSchema = z.record(z.string(), z.unknown());

export const createCooperationPathOpportunityBodySchema = z.object({
  recommendationId: z.uuid(),
  cooperationPathFactId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  editableContent: nonBlank.max(10_000),
  nextAction: nonBlank.max(1_000),
}).strict();

export const patchManualContentBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  editableContent: nonBlank.max(10_000),
  nextAction: nonBlank.max(1_000),
}).strict();

export const transitionManualActionBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  toState: z.enum(manualActionStates),
  nextAction: nonBlank.max(1_000),
  evidence: evidenceSchema.default({}),
  submissionConfirmed: z.boolean().default(false),
}).strict();

const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();

const mutationResponseSchema = z.object({
  opportunityId: z.uuid(),
  manualActionId: z.uuid(),
  manualActionState: z.enum(manualActionStates),
  editableContent: nonBlank,
  nextAction: nonBlank,
  manualActionVersion: z.number().int().positive(),
  lifecycleEventId: z.uuid(),
  auditEventId: z.uuid(),
  replayed: z.boolean(),
  meta: metaSchema,
}).strict();

const createResponseSchema = mutationResponseSchema.extend({
  recommendationId: z.uuid(),
  cycleId: z.uuid(),
  websiteProjectId: z.uuid(),
  targetSiteKey: nonBlank,
  targetHostAscii: nonBlank,
  cooperationPathFactId: z.uuid(),
  pathType: z.enum(nonEmailCooperationPathTypes),
  pathUrl: z.url(),
  contentType: z.enum(["FORM_MESSAGE", "SUBMISSION_PITCH"]),
  joinSequence: z.number().int().positive(),
  businessStage: z.literal("JOINED"),
  managementStatus: z.literal("ACTIVE"),
  outcomeStatus: z.literal("OPEN"),
  fulfillmentStatus: z.literal("NOT_EXPECTED"),
  version: z.number().int().positive(),
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

export function registerCooperationPathOpportunityCommandsRoutes(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule; commands: Commands }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/cooperation-path",
    {
      schema: {
        operationId: "backlinksCreateCooperationPathOpportunityV1",
        headers,
        params: projectParams,
        body: createCooperationPathOpportunityBodySchema,
        response: { 201: createResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.createFromVerifiedPath({
        context,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        ...request.body,
      });
      return reply.code(201).send({
        ...result,
        meta: meta(context, request.id),
      });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().patch(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId/cooperation-path/content",
    {
      schema: {
        operationId: "backlinksPatchCooperationPathContentV1",
        headers,
        params: opportunityParams,
        body: patchManualContentBodySchema,
        response: { 200: mutationResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.patchManualContent({
        context,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        opportunityId: request.params.opportunityId,
        ...request.body,
      });
      return { ...result, meta: meta(context, request.id) };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId/manual-action/transition",
    {
      schema: {
        operationId: "backlinksTransitionManualActionV1",
        headers,
        params: opportunityParams,
        body: transitionManualActionBodySchema,
        response: { 200: mutationResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.transitionManualAction({
        context,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        opportunityId: request.params.opportunityId,
        ...request.body,
      });
      return { ...result, meta: meta(context, request.id) };
    },
  );
}
