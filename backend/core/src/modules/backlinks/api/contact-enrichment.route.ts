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
  createContactEnrichmentCommands,
} from "../application/commands/contact-enrichment.command.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Commands = ReturnType<typeof createContactEnrichmentCommands>;

const nonBlank = z.string().trim().min(1);
const contactRole = z.enum([
  "press",
  "editorial",
  "partnerships",
  "advertising",
  "support",
  "general",
]);
const projectParams = z.object({
  websiteProjectKey: nonBlank,
}).strict();
const recommendationParams = projectParams.extend({
  recommendationId: z.uuid(),
}).strict();
const jobParams = projectParams.extend({
  jobId: z.uuid(),
}).strict();
const candidateParams = projectParams.extend({
  candidateId: z.uuid(),
}).strict();
const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  409: backlinkProblemDetailsSchema,
  500: backlinkProblemDetailsSchema,
};
const job = z.object({
  id: z.uuid(),
  batchId: z.uuid(),
  recommendationId: z.uuid(),
  prospectId: z.uuid(),
  recommendationContextVersionId: z.uuid(),
  rootUrl: z.url(),
  status: z.enum([
    "pending",
    "running",
    "completed",
    "partially_completed",
    "no_contact_found",
    "retry_scheduled",
    "stale_context",
  ]),
  attemptCount: z.number().int().min(0),
  maxAttempts: z.number().int().positive(),
  maxPages: z.number().int().positive(),
  maxDepth: z.number().int().min(0),
  browserAllowed: z.boolean(),
  browserUsed: z.boolean(),
  pagesVisited: z.number().int().min(0),
  candidateCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  lastErrorCode: z.string().nullable(),
  terminalReasonCode: z.enum([
    "PUBLIC_EMAIL_FOUND",
    "CONTACT_FORM_ONLY",
    "LOGIN_REQUIRED",
    "CAPTCHA_OR_BOT_CHALLENGE",
    "ROBOTS_DISALLOWED",
    "ACCESS_DENIED",
    "NO_PUBLIC_EMAIL",
    "SITE_UNREACHABLE",
    "UNSUPPORTED_CONTENT",
    "MANUAL_REVIEW_REQUIRED",
    "COMPLETED_PARTIAL",
  ]).nullable(),
  method: z.enum(["none", "static", "browser", "static_and_browser"]),
  lastErrorCategory: z.string().nullable(),
  retryAfter: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  version: z.number().int().positive(),
}).strict();
const startResponse = job.extend({
  replayed: z.boolean(),
}).strict();
const manualCandidateBody = z.object({
  normalizedEmail: z.email(),
  contactRole,
  sourceUrl: z.url(),
  reason: nonBlank.max(500),
}).strict();
const manualCandidateResponse = z.object({
  candidateId: z.uuid(),
  normalizedEmail: z.email(),
  sourceUrl: z.url(),
  version: z.number().int().positive(),
}).strict();
const correctionBody = z.object({
  expectedVersion: z.number().int().positive(),
  contactRole,
  reason: nonBlank.max(500),
}).strict();
const correctionResponse = z.object({
  candidateId: z.uuid(),
  contactRole,
  version: z.number().int().positive(),
}).strict();
const retryUnpublishedResponse = z.object({
  batchId: z.uuid().nullable(),
  retriedJobCount: z.number().int().min(0),
}).strict();

function sendError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  request.log.error(
    { err: error },
    "backlinks.contact-enrichment.request.failed",
  );
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

export function registerBacklinksContactEnrichmentRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: Commands;
  }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const resolve = (request: FastifyRequest, websiteProjectKey: string) =>
    options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey,
    });

  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/contact-enrichment-batches/current/retry-unpublished",
    {
      schema: {
        operationId: "backlinksRetryUnpublishedContactsV1",
        params: projectParams,
        response: { 202: retryUnpublishedResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await resolve(
        request,
        request.params.websiteProjectKey,
      );
      const result = await options.commands.retryUnpublished(context);
      return reply.code(202).send(result);
    },
  );

  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendations/:recommendationId/contact-enrichment-jobs",
    {
      schema: {
        operationId: "backlinksStartContactEnrichmentV1",
        params: recommendationParams,
        response: { 202: startResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await resolve(
        request,
        request.params.websiteProjectKey,
      );
      const result = await options.commands.start({
        context,
        recommendationId: request.params.recommendationId,
      });
      return reply.code(202).send(result);
    },
  );

  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/contact-enrichment-jobs/:jobId",
    {
      schema: {
        operationId: "backlinksGetContactEnrichmentJobV1",
        params: jobParams,
        response: { 200: job, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolve(
        request,
        request.params.websiteProjectKey,
      );
      return options.commands.get(context, request.params.jobId);
    },
  );

  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/contact-enrichment-jobs/:jobId/retry",
    {
      schema: {
        operationId: "backlinksRetryContactEnrichmentV1",
        params: jobParams,
        response: { 202: job, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await resolve(
        request,
        request.params.websiteProjectKey,
      );
      const result = await options.commands.retry({
        context,
        jobId: request.params.jobId,
      });
      return reply.code(202).send(result);
    },
  );

  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendations/:recommendationId/contacts/candidates",
    {
      schema: {
        operationId: "backlinksAddPublicContactCandidateV1",
        params: recommendationParams,
        body: manualCandidateBody,
        response: { 201: manualCandidateResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await resolve(
        request,
        request.params.websiteProjectKey,
      );
      const result = await options.commands.addManualCandidate({
        context,
        recommendationId: request.params.recommendationId,
        ...request.body,
      });
      return reply.code(201).send(result);
    },
  );

  api.patch(
    "/api/v1/projects/:websiteProjectKey/backlinks/contacts/candidates/:candidateId",
    {
      schema: {
        operationId: "backlinksCorrectContactCandidateV1",
        params: candidateParams,
        body: correctionBody,
        response: { 200: correctionResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await resolve(
        request,
        request.params.websiteProjectKey,
      );
      return options.commands.correctCandidate({
        context,
        candidateId: request.params.candidateId,
        ...request.body,
      });
    },
  );
}
