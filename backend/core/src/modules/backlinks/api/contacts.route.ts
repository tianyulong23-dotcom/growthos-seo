import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createContactCommands } from "../application/commands/contacts.command.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";
type Commands = ReturnType<typeof createContactCommands>;
const nonBlank = z.string().trim().min(1);
const projectParams = z.object({ websiteProjectKey: nonBlank }).strict();
const candidateParams = projectParams.extend({ candidateId: z.uuid() }).strict();
export const contactCandidatesQuerySchema = z.object({ prospectId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(100).default(25) }).strict();
export const confirmContactBodySchema = z.object({ expectedVersion: z.number().int().positive(),
  contactRole: z.enum(["press", "editorial", "partnerships", "advertising", "support", "general"]),
  reason: nonBlank.max(500) }).strict();
const evidence = z.object({ sourceUrl: z.url(), observedAt: nonBlank,
  extractionMethod: nonBlank, evidenceSnippet: nonBlank,
  confidence: z.number().int().min(0).max(100), expiresAt: nonBlank }).strict();
const purposeEvidence = z.object({
  tier: nonBlank, field: nonBlank, value: z.string(),
  matchedToken: nonBlank, ruleId: nonBlank,
}).strict();
const candidate = z.object({ id: z.uuid(), prospectId: z.uuid(),
  recommendationContextVersionId: z.uuid(), normalizedEmail: z.email(),
  domainRelation: z.enum(["same_registrable_domain", "external_domain", "unknown"]),
  confidence: z.number().int().min(0).max(100), observedRole: z.string().nullable(),
  inferredPurpose: z.enum(["press", "editorial", "partnerships", "advertising",
    "support", "general", "unknown"]),
  purposeConfidence: z.number().int().min(0).max(100),
  purposeRuleVersion: nonBlank, purposeEvidence: z.array(purposeEvidence),
  guessed: z.boolean(),
  status: z.literal("candidate"), version: z.number().int().positive(),
  evidence: z.array(evidence) }).strict();
const metaSchema = z.object({ organizationId: nonBlank, workspaceId: nonBlank,
  websiteProjectId: nonBlank, requestId: nonBlank, schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime() }).strict();
const listResponse = z.object({ items: z.array(candidate), meta: metaSchema }).strict();
const confirmResponse = z.object({ candidateId: z.uuid(), contactId: z.uuid(),
  candidateStatus: z.literal("promoted"), candidateVersion: z.number().int().positive(),
  contactStatus: z.literal("active"), contactVersion: z.number().int().positive(),
  lifecycleEventId: nonBlank, auditEventId: nonBlank, meta: metaSchema }).strict();
const errors = { 400: backlinkProblemDetailsSchema, 403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema, 409: backlinkProblemDetailsSchema, 500: backlinkProblemDetailsSchema };
function sendError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const normalized = error instanceof BacklinkError ? error : error.validation === undefined ? error
    : new BacklinkError({ code: backlinkErrorCodes.invalidRequest, message: "Request validation failed." });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}
const meta = (request: FastifyRequest, context:
  Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>) => ({
    organizationId: context.tenant.organizationId, workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId, requestId: request.id,
    schemaVersion: "backlinks.v1" as const, generatedAt: new Date().toISOString() });
export function registerBacklinksContactsRoutes(app: FastifyInstance, options:
  Readonly<{ module: BacklinksModule; commands: Commands }>): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get("/api/v1/projects/:websiteProjectKey/backlinks/contacts/candidates", { schema: {
    operationId: "backlinksListContactCandidatesV1",
    params: projectParams, querystring: contactCandidatesQuerySchema,
    response: { 200: listResponse, ...errors } }, errorHandler: sendError }, async (request) => {
    const context = await options.module.projectContext.resolve({ actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey });
    return { items: await options.commands.listCandidates(context, request.query.prospectId,
      request.query.limit), meta: meta(request, context) };
  });
  api.post("/api/v1/projects/:websiteProjectKey/backlinks/contacts/candidates/:candidateId/confirm",
    { schema: { operationId: "backlinksConfirmContactCandidateV1",
      params: candidateParams, body: confirmContactBodySchema,
      response: { 200: confirmResponse, ...errors } }, errorHandler: sendError }, async (request) => {
    const context = await options.module.projectContext.resolve({ actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey });
    const result = await options.commands.confirm({ context, requestId: request.id,
      candidateId: request.params.candidateId, ...request.body });
    return { ...result, meta: meta(request, context) };
    });
}
