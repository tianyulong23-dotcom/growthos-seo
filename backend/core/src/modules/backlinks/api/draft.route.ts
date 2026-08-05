import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createDraftCommands } from "../application/commands/draft.command.js";
import type {
  createDraftEditingCommands,
} from "../application/commands/draft.command.js";
import type { DraftQuery } from "../application/queries/draft.query.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  draftDocumentSchema,
} from "../application/schemas/draft-document.schema.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Commands = ReturnType<typeof createDraftCommands>;
type EditingCommands = ReturnType<typeof createDraftEditingCommands>;
const nonBlank = z.string().trim().min(1);
const createHeaders = z.object({
  "idempotency-key": nonBlank.max(200),
});
const createParams = z.object({
  websiteProjectKey: nonBlank,
  opportunityId: z.uuid(),
}).strict();
const jobParams = z.object({
  websiteProjectKey: nonBlank,
  jobId: z.uuid(),
}).strict();
const latestJobQuery = z.object({
  logicalDraftKey: nonBlank.max(200),
}).strict();
const draftParams = z.object({
  websiteProjectKey: nonBlank,
  draftId: z.uuid(),
}).strict();
export const createDraftJobBodySchema = z.object({
  contactId: z.uuid(),
  contactVersion: z.number().int().positive(),
  logicalDraftKey: nonBlank.max(200),
}).strict();
const jobStatuses = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REFUSED",
] as const;
const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();
const createResponseSchema = z.object({
  jobId: z.uuid(),
  draftId: z.uuid(),
  status: z.enum(jobStatuses),
  contactId: z.uuid(),
  contactVersion: z.number().int().positive(),
  evidenceSnapshotId: z.uuid(),
  workflowId: nonBlank,
  generationMode: z.enum(["MODEL", "MANUAL"]),
  replayed: z.boolean(),
  meta: metaSchema,
}).strict();
const jobSchema = z.object({
  id: z.uuid(),
  draftId: z.uuid(),
  status: z.enum(jobStatuses),
  contactId: z.uuid().nullable(),
  contactVersion: z.number().int().positive().nullable(),
  versionId: z.uuid().nullable(),
  lastSuccessfulVersionId: z.uuid().nullable(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime(),
  queueWaitMs: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  persistenceLatencyMs: z.number().int().nonnegative().nullable(),
  attemptCount: z.number().int().nonnegative(),
  lastErrorCategory: nonBlank.nullable(),
}).strict();
const jobResponseSchema = z.object({
  job: jobSchema,
  meta: metaSchema,
}).strict();
const latestJobResponseSchema = z.object({
  job: jobSchema.nullable(),
  meta: metaSchema,
}).strict();
const draftResponseSchema = z.object({
  draft: z.object({
    id: z.uuid(),
    opportunityId: z.uuid(),
    contactId: z.uuid().nullable(),
    contactVersion: z.number().int().positive().nullable(),
    status: z.enum(["generating", "draft", "approved", "rejected", "sent"]),
    draftVersion: z.number().int().positive(),
    approvedVersionId: z.uuid().nullable(),
    currentVersion: z.object({
      id: z.uuid(),
      versionNo: z.number().int().positive(),
      subjectText: nonBlank.max(500),
      bodyText: nonBlank.max(50_000),
      bodyDocument: draftDocumentSchema,
      source: z.enum(["MODEL", "MANUAL", "RESTORED"]),
      createdAt: z.string().datetime(),
    }).strict().nullable(),
  }).strict(),
  meta: metaSchema,
}).strict();
export const saveDraftVersionBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  subjectText: nonBlank.max(500),
  bodyDocument: draftDocumentSchema,
}).strict();
export const approveDraftBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();
const draftMutationResponseSchema = z.object({
  draftId: z.uuid(),
  versionId: z.uuid(),
  draftVersion: z.number().int().positive(),
  status: z.enum(["draft", "approved"]),
  meta: metaSchema,
}).strict();
const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  409: backlinkProblemDetailsSchema,
  429: backlinkProblemDetailsSchema,
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
  void reply
    .code(problem.status)
    .type(backlinkProblemContentType)
    .send(problem);
}

const meta = (
  context: Awaited<
    ReturnType<BacklinksModule["projectContext"]["resolve"]>
  >,
  requestId: string,
) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  requestId,
  schemaVersion: "backlinks.v1" as const,
  generatedAt: new Date().toISOString(),
});

export function registerBacklinksDraftRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule<DraftQuery>;
    commands: Commands;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId/draft-jobs",
    {
      schema: {
        operationId: "backlinksCreateDraftJobV1",
        headers: createHeaders,
        params: createParams,
        body: createDraftJobBodySchema,
        response: { 202: createResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.create({
        context,
        opportunityId: request.params.opportunityId,
        idempotencyKey: request.headers["idempotency-key"],
        ...request.body,
      });
      return reply.code(202).send({
        ...result,
        meta: meta(context, request.id),
      });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId/draft-jobs/latest",
    {
      schema: {
        operationId: "backlinksGetLatestDraftJobV1",
        params: createParams,
        querystring: latestJobQuery,
        response: { 200: latestJobResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return {
        job: await options.module.queries.findLatestJob(
          context,
          request.params.opportunityId,
          request.query.logicalDraftKey,
        ),
        meta: meta(context, request.id),
      };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/draft-jobs/:jobId",
    {
      schema: {
        operationId: "backlinksGetDraftJobV1",
        params: jobParams,
        response: { 200: jobResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return {
        job: await options.module.queries.getJob(
          context,
          request.params.jobId,
        ),
        meta: meta(context, request.id),
      };
    },
  );
}

export function registerBacklinksDraftEditingRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule<DraftQuery>;
    commands: EditingCommands;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/drafts/:draftId",
    {
      schema: {
        operationId: "backlinksGetDraftV1",
        params: draftParams,
        response: { 200: draftResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return {
        draft: await options.module.queries.getDraft(
          context,
          request.params.draftId,
        ),
        meta: meta(context, request.id),
      };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/drafts/:draftId/versions",
    {
      schema: {
        operationId: "backlinksSaveDraftVersionV1",
        params: draftParams,
        body: saveDraftVersionBodySchema,
        response: { 201: draftMutationResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.saveManualVersion({
        context,
        draftId: request.params.draftId,
        ...request.body,
      });
      return reply.code(201).send({
        ...result,
        meta: meta(context, request.id),
      });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/drafts/:draftId/approve",
    {
      schema: {
        operationId: "backlinksApproveDraftV1",
        params: draftParams,
        body: approveDraftBodySchema,
        response: { 200: draftMutationResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return {
        ...await options.commands.approve({
          context,
          draftId: request.params.draftId,
          ...request.body,
        }),
        meta: meta(context, request.id),
      };
    },
  );
}
