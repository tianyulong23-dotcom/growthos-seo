import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type {
  MetricDashboard,
  MetricDashboardPoint,
  MetricDashboardQuery,
} from "../../application/queries/metric-dashboard.query.js";
import type {
  ActorContext,
} from "../../domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type {
  ProjectContextPort,
} from "../../ports/project-context.port.js";
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
const timezone = nonBlank.refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, "timezone must be a valid IANA timezone");

export const metricDashboardParamsSchema = z
  .object({ websiteProjectKey: nonBlank })
  .strict();
export const metricDashboardQuerySchema = z
  .object({
    from: dateTime,
    to: dateTime,
    asOf: dateTime,
    timezone,
  })
  .strict()
  .refine((query) => {
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    const asOf = Date.parse(query.asOf);
    return from < to && to <= asOf;
  }, "dashboard window must satisfy from < to <= asOf");

const dashboardPointSchema = z
  .object({
    snapshotId: nonBlank,
    snapshotVersion: z.number().int().positive(),
    windowStart: dateTime,
    windowEnd: dateTime,
    asOf: dateTime,
    dimensions: z.record(z.string(), z.string()),
    numerator: z.number().nonnegative(),
    denominator: z.number().nonnegative().nullable(),
    value: z.number().nonnegative().nullable(),
  })
  .strict();
const dashboardSummarySchema = dashboardPointSchema.extend({
  metricKey: nonBlank,
  metricDefinitionVersion: nonBlank,
}).strict();
const dashboardTrendSchema = z
  .object({
    metricKey: nonBlank,
    metricDefinitionVersion: nonBlank,
    points: z.array(dashboardPointSchema),
  })
  .strict();
export const metricDashboardResponseSchema = z
  .object({
    dashboard: z
      .object({
        timezone: nonBlank,
        from: dateTime,
        to: dateTime,
        asOf: dateTime,
        summary: z.array(dashboardSummarySchema),
        trends: z.array(dashboardTrendSchema),
      })
      .strict(),
    meta: z
      .object({
        organizationId: nonBlank,
        workspaceId: nonBlank,
        websiteProjectId: nonBlank,
        requestId: nonBlank,
        schemaVersion: z.literal("backlink-metric-dashboard.v1"),
        generatedAt: dateTime,
      })
      .strict(),
  })
  .strict();

function pointResponse(point: MetricDashboardPoint) {
  return {
    ...point,
    windowStart: point.windowStart.toISOString(),
    windowEnd: point.windowEnd.toISOString(),
    asOf: point.asOf.toISOString(),
  };
}

function dashboardResponse(dashboard: MetricDashboard) {
  return {
    timezone: dashboard.timezone,
    from: dashboard.from.toISOString(),
    to: dashboard.to.toISOString(),
    asOf: dashboard.asOf.toISOString(),
    summary: dashboard.summary.map((item) => ({
      metricKey: item.metricKey,
      metricDefinitionVersion: item.metricDefinitionVersion,
      ...pointResponse(item),
    })),
    trends: dashboard.trends.map((trend) => ({
      metricKey: trend.metricKey,
      metricDefinitionVersion: trend.metricDefinitionVersion,
      points: trend.points.map(pointResponse),
    })),
  };
}

function sendMetricDashboardError(
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

export function registerBacklinksMetricDashboardRoute(
  app: FastifyInstance,
  options: Readonly<{
    projectContext: ProjectContextPort;
    query: MetricDashboardQuery;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/metrics/dashboard",
    {
      schema: {
        operationId: "backlinksGetMetricDashboardV1",
        params: metricDashboardParamsSchema,
        querystring: metricDashboardQuerySchema,
        response: {
          200: metricDashboardResponseSchema,
          400: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          404: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendMetricDashboardError,
    },
    async (request) => {
      const context = await options.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const dashboard = await options.query.getDashboard({
        scope: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        },
        from: new Date(request.query.from),
        to: new Date(request.query.to),
        asOf: new Date(request.query.asOf),
        timezone: request.query.timezone,
      });
      return {
        dashboard: dashboardResponse(dashboard),
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlink-metric-dashboard.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );
}
