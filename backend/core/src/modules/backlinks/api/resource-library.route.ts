import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import {
  resourceLibraryQualityBuckets,
  type ResourceLibraryQuery,
} from "../application/queries/resource-library.query.js";
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
const nullableNumber = z.number().nullable();
const paramsSchema = z.object({ websiteProjectKey: nonBlank }).strict();
const querySchema = z.object({
  search: z.string().trim().max(200).optional(),
  qualityBucket: z.enum(resourceLibraryQualityBuckets).optional(),
  resourceType: z.enum(["free", "paid"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const projectAuthoritySchema = z.object({
  score: z.number().int().min(0).max(100),
  band: z.enum(["high", "established", "growing", "emerging", "unknown"]),
  confidence: z.enum(["backlink_profile", "neutral_default"]),
  referringDomains: nullableNumber,
  minimumResourceAuthorityScore: z.number().int().min(0).max(100),
}).strict();
const summarySchema = z.object({
  total: z.number().int().min(0),
  free: z.number().int().min(0),
  paid: z.number().int().min(0),
  recommend: z.number().int().min(0),
  review: z.number().int().min(0),
  avoid: z.number().int().min(0),
  unclassified: z.number().int().min(0),
  autoEligible: z.number().int().min(0),
  authorityMatchedAutoEligible: z.number().int().min(0),
}).strict();
const itemSchema = z.object({
  key: nonBlank,
  domain: nonBlank,
  url: z.url(),
  websiteName: nonBlank,
  resourceType: z.enum(["free", "paid"]),
  categories: z.array(nonBlank),
  tags: z.array(nonBlank),
  countryLanguage: z.string().nullable(),
  domainAuthority: nullableNumber,
  monthlyOrganicTraffic: nullableNumber,
  dataForSeoRank: nullableNumber,
  spamScore: nullableNumber,
  profileHealthScore: nullableNumber,
  authorityScore: z.number().int().min(0).max(100),
  authorityMatch: z.enum(["stronger", "matched", "below"]),
  qualityBucket: z.enum(resourceLibraryQualityBuckets),
  qualityReviewed: z.boolean(),
  riskLevel: z.string().nullable(),
  recommendation: z.string().nullable(),
  referringDomains: nullableNumber,
  backlinks: nullableNumber,
  autoSupplementEligible: z.boolean(),
  sourceGeneratedAt: z.string().datetime(),
}).strict();
const responseSchema = z.object({
  projectAuthority: projectAuthoritySchema,
  summary: summarySchema,
  items: z.array(itemSchema),
  meta: z.object({
    organizationId: nonBlank,
    workspaceId: nonBlank,
    websiteProjectId: nonBlank,
    requestId: nonBlank,
    schemaVersion: z.literal("backlinks.v1"),
    generatedAt: z.string().datetime(),
  }).strict(),
}).strict();
const diagnosticRoles = new Set(["admin"]);

function authorizeDiagnostics(request: FastifyRequest): void {
  if (!request.actor.roles.some((role) => diagnosticRoles.has(role))) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Resource Library diagnostics permission is required.",
    });
  }
}

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

export function registerBacklinksResourceLibraryRoute(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule<ResourceLibraryQuery> }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/resource-library",
    {
      schema: {
        operationId: "backlinksListResourceLibraryV1",
        params: paramsSchema,
        querystring: querySchema,
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
      authorizeDiagnostics(request);
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const page = await options.module.queries.listResourceLibrary(
        context,
        request.query,
      );
      return {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          categories: [...item.categories],
          tags: [...item.tags],
        })),
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
