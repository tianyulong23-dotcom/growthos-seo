import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { OpportunitiesQuery } from "../application/queries/opportunities.query.js";
import {
  engagementPathStates,
  opportunityPrimaryNextActionKinds,
} from "../application/read-models/opportunity-handoff.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import {
  manualActionStates,
  nonEmailCooperationPathTypes,
} from "../domain/opportunities/cooperation-path.js";
import {
  opportunityBusinessStages,
  opportunityFulfillmentStatuses,
  opportunityManagementStatuses,
  opportunityOutcomeStatuses,
} from "../domain/opportunities/opportunity-state.js";
import {
  placementCandidateSchema,
  publicAssessmentSchema,
} from "./evidence-contracts.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";

const nonBlank = z.string().trim().min(1);
const listParams = z.object({ websiteProjectKey: nonBlank }).strict();
const detailParams = z.object({
  websiteProjectKey: nonBlank,
  opportunityId: z.uuid(),
}).strict();
export const opportunitiesQuerySchema = z.object({
  businessStage: z.enum(opportunityBusinessStages).optional(),
  managementStatus: z.enum(opportunityManagementStatuses).optional(),
  outcomeStatus: z.enum(opportunityOutcomeStatuses).optional(),
  fulfillmentStatus: z.enum(opportunityFulfillmentStatuses).optional(),
  search: nonBlank.max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();
const listItemSchema = z.object({
  id: z.uuid(),
  targetSiteKey: nonBlank,
  targetHostAscii: nonBlank,
  joinSequence: z.number().int().positive(),
  businessStage: z.enum(opportunityBusinessStages),
  managementStatus: z.enum(opportunityManagementStatuses),
  outcomeStatus: z.enum(opportunityOutcomeStatuses),
  fulfillmentStatus: z.enum(opportunityFulfillmentStatuses),
  engagementChannel: z.enum(["EMAIL", "COOPERATION_PATH"]),
  engagementPathState: z.enum(engagementPathStates),
  primaryNextAction: z.object({
    kind: z.enum(opportunityPrimaryNextActionKinds),
    enabled: z.boolean(),
    blockerCode: z.enum([
      "CONTACT_OR_PATH_REQUIRED",
      "DRAFT_GENERATING",
    ]).nullable(),
  }).strict(),
  draftId: z.uuid().nullable(),
  sourceContactCandidateId: z.uuid().nullable(),
  contactEmail: nonBlank.nullable(),
  contactReviewRequired: z.boolean(),
  manualActionState: z.enum(manualActionStates).nullable(),
  hasDownstreamFacts: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const detailSchema = listItemSchema.extend({
  recommendationId: z.uuid(),
  prospectId: z.uuid(),
  recommendationContextVersionId: z.uuid(),
  targetIdentityKind: z.enum(["registrable_domain", "exact_host"]),
  targetIdentityRuleVersion: nonBlank,
  targetIdentityOverrideReason: z.string().nullable(),
  assessment: publicAssessmentSchema.nullable(),
  placementCandidate: placementCandidateSchema.nullable(),
  cooperationPath: z.object({
    factId: z.uuid(),
    manualActionId: z.uuid(),
    pathType: z.enum(nonEmailCooperationPathTypes),
    pathUrl: z.url(),
    contentType: z.enum(["FORM_MESSAGE", "SUBMISSION_PITCH"]),
    editableContent: nonBlank,
    state: z.enum(manualActionStates),
    nextAction: nonBlank,
    evidence: z.record(z.string(), z.unknown()),
    version: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  }).strict().nullable(),
  selectionSnapshot: z.object({
    lineageStatus: z.enum(["COMPLETE", "PARTIAL"]),
    recommendationId: z.uuid(),
    recommendationContextVersionId: z.uuid(),
    visiblePoolGeneration: z.number().int().positive().nullable(),
    generationContractId: z.uuid().nullable(),
    inputPinId: z.uuid().nullable(),
    scoreModelVersion: nonBlank.nullable(),
    projectContextVersion: z.number().int().positive().nullable(),
    siteProfileVersionId: nonBlank.nullable(),
    outreachProfileVersionId: z.uuid().nullable(),
    promotionTargetVersionId: nonBlank.nullable(),
    immutableFingerprint: nonBlank.nullable(),
    selectedTargetUrl: z.url().nullable(),
    selectedContactCandidateId: z.uuid().nullable(),
    selectedCooperationPathFactId: z.uuid().nullable(),
    selectedCooperationPathVersion: z.number().int().positive().nullable(),
    selectedBy: nonBlank,
    selectedAt: z.string().datetime(),
  }).strict(),
}).strict();
const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();
const listResponseSchema = z.object({
  items: z.array(listItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: metaSchema,
}).strict();
const detailResponseSchema = z.object({
  item: detailSchema,
  meta: metaSchema,
}).strict();
const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  500: backlinkProblemDetailsSchema,
};

function sendError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const normalized = error instanceof BacklinkError ? error
    : error.validation === undefined ? error : new BacklinkError({
      code: backlinkErrorCodes.invalidRequest,
      message: "Request validation failed.",
    });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

function meta(context: Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>,
  requestId: string) {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    requestId,
    schemaVersion: "backlinks.v1" as const,
    generatedAt: new Date().toISOString(),
  };
}

export function registerBacklinksOpportunitiesRoutes(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule<OpportunitiesQuery> }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities",
    { schema: {
      operationId: "backlinksListOpportunitiesV1",
      params: listParams,
      querystring: opportunitiesQuerySchema,
      response: { 200: listResponseSchema, ...errors },
    }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const page = await options.module.queries.listOpportunities(context, request.query);
      return { ...page, meta: meta(context, request.id) };
    },
  );
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId",
    { schema: {
      operationId: "backlinksGetOpportunityV1",
      params: detailParams,
      response: { 200: detailResponseSchema, ...errors },
    }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const item = await options.module.queries.getOpportunity(
        context,
        request.params.opportunityId,
      );
      return { item, meta: meta(context, request.id) };
    },
  );
}
