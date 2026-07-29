import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type {
  ReportExportView,
  ReportExportWorkflow,
} from "../../application/workflows/report-export.workflow.js";
import type { ActorContext } from "../../domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ProjectContextPort } from "../../ports/project-context.port.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "../problem-details.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: ActorContext;
  }
}

const nonBlank = z.string().trim().min(1);
const identifier = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const projectParams = z.object({ websiteProjectKey: nonBlank }).strict();
const requestParams = projectParams.extend({
  reportKey: nonBlank,
  reportRevisionId: identifier,
}).strict();
const exportParams = projectParams.extend({ exportId: identifier }).strict();
const exportStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "expired",
]);
const exportSchema = z.object({
  id: identifier,
  reportKey: nonBlank,
  reportRevisionId: nonBlank,
  format: z.enum(["csv", "xlsx", "pdf"]),
  status: exportStatus,
  createdAt: dateTime,
  completedAt: dateTime.nullable(),
  expiresAt: dateTime.nullable(),
  failureCode: z.string().nullable(),
  object: z.object({
    contentType: nonBlank,
    contentLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    storagePolicyVersion: nonBlank,
  }).strict().nullable(),
}).strict();
const responseMeta = z.object({
  requestId: nonBlank,
  schemaVersion: z.literal("backlink-report-export.v1"),
}).strict();
const exportResponse = z.object({
  export: exportSchema,
  meta: responseMeta,
}).strict();
const downloadResponse = z.object({
  download: z.object({
    url: z.string().url(),
    expiresAt: dateTime,
  }).strict(),
  meta: responseMeta,
}).strict();

function toResponse(record: ReportExportView) {
  return {
    id: record.id,
    reportKey: record.reportKey,
    reportRevisionId: record.reportRevisionId,
    format: record.format,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    failureCode: record.failureCode,
    object: record.objectReference === null
      ? null
      : {
          contentType: record.objectReference.contentType,
          contentLength: record.objectReference.contentLength,
          sha256: record.objectReference.sha256,
          storagePolicyVersion:
            record.objectReference.storagePolicyVersion,
        },
  };
}

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

export function registerBacklinksReportExportRoutes(
  app: FastifyInstance,
  options: Readonly<{
    projectContext: ProjectContextPort;
    workflow: Pick<
      ReportExportWorkflow,
      "request" | "get" | "run" | "authorizeDownload"
    >;
  }>,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/reports/:reportKey/revisions/:reportRevisionId/exports",
    {
      schema: {
        operationId: "backlinksRequestReportExportV1",
        params: requestParams,
        body: z.object({ format: z.enum(["csv", "xlsx", "pdf"]) }).strict(),
        response: {
          202: exportResponse,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
          409: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const record = await options.workflow.request({
        scope: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        },
        reportKey: request.params.reportKey,
        reportRevisionId: request.params.reportRevisionId,
        format: request.body.format,
        requestedBy: request.actor.userId,
        correlationId: request.id,
      });
      return reply.code(202).send({
        export: toResponse(record),
        meta: {
          requestId: request.id,
          schemaVersion: "backlink-report-export.v1" as const,
        },
      });
    },
  );

  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/report-exports/:exportId",
    {
      schema: {
        operationId: "backlinksGetReportExportV1",
        params: exportParams,
        response: {
          200: exportResponse,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
          409: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const record = await options.workflow.get({
        scope: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        },
        exportId: request.params.exportId,
        actorId: request.actor.userId,
      });
      return {
        export: toResponse(record),
        meta: {
          requestId: request.id,
          schemaVersion: "backlink-report-export.v1" as const,
        },
      };
    },
  );

  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/report-exports/:exportId/download",
    {
      schema: {
        operationId: "backlinksAuthorizeReportExportDownloadV1",
        params: exportParams,
        response: {
          200: downloadResponse,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
          409: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const download = await options.workflow.authorizeDownload({
        scope: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        },
        exportId: request.params.exportId,
        actorId: request.actor.userId,
      });
      return {
        download: {
          url: download.url,
          expiresAt: download.expiresAt.toISOString(),
        },
        meta: {
          requestId: request.id,
          schemaVersion: "backlink-report-export.v1" as const,
        },
      };
    },
  );
}
