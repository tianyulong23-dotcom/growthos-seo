import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type {
  ReportOverviewQuery,
  ReportOverviewRevision,
} from "../../application/queries/report-overview.query.js";
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
const dateTime = z.string().datetime({ offset: true });
const params = z.object({ websiteProjectKey: nonBlank }).strict();
const querystring = z.object({
  asOf: dateTime,
  reportKey: nonBlank.optional(),
}).strict();
const reportSchema = z.object({
  id: z.string().uuid(),
  reportKey: nonBlank,
  revision: z.number().int().positive(),
  inputSnapshotIds: z.array(nonBlank),
  metricDefinitionVersions: z.record(z.string(), z.string()),
  querySpec: z.record(z.string(), z.unknown()),
  payload: z.record(z.string(), z.unknown()),
  sourceStartedAt: dateTime,
  sourceEndedAt: dateTime,
  sourceWatermarkAt: dateTime,
  sourceWatermarkId: nonBlank,
  resultChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  generatedAt: dateTime,
  freshness: z.enum(["fresh", "stale"]),
}).strict();
const responseSchema = z.object({
  reports: z.array(reportSchema),
  meta: z.object({
    organizationId: nonBlank,
    workspaceId: nonBlank,
    websiteProjectId: nonBlank,
    requestId: nonBlank,
    schemaVersion: z.literal("backlink-report-overview.v1"),
    generatedAt: dateTime,
  }).strict(),
}).strict();

function responseRevision(revision: ReportOverviewRevision) {
  return {
    ...revision,
    inputSnapshotIds: [...revision.inputSnapshotIds],
    metricDefinitionVersions: { ...revision.metricDefinitionVersions },
    querySpec: { ...revision.querySpec },
    payload: { ...revision.payload },
    sourceStartedAt: revision.sourceStartedAt.toISOString(),
    sourceEndedAt: revision.sourceEndedAt.toISOString(),
    sourceWatermarkAt: revision.sourceWatermarkAt.toISOString(),
    generatedAt: revision.generatedAt.toISOString(),
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

export function registerBacklinksReportOverviewRoute(
  app: FastifyInstance,
  options: Readonly<{
    projectContext: ProjectContextPort;
    query: ReportOverviewQuery;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/reports",
    {
      schema: {
        operationId: "backlinksListPublishedReportsV1",
        params,
        querystring,
        response: {
          200: responseSchema,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
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
      const scope = {
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
      };
      const reports = await options.query.listPublished(
        request.query.reportKey === undefined
          ? { scope, asOf: new Date(request.query.asOf) }
          : {
              scope,
              asOf: new Date(request.query.asOf),
              reportKey: request.query.reportKey,
            },
      );
      return {
        reports: reports.map(responseRevision),
        meta: {
          ...scope,
          requestId: request.id,
          schemaVersion: "backlink-report-overview.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );
}
