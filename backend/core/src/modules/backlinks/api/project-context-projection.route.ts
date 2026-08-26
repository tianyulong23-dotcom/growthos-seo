import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type {
  ProjectContextProjectionCommand,
} from "../application/commands/project-context-projection.command.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

const nonBlankString = z.string().trim().min(1).max(200);
const paramsSchema = z
  .object({ websiteProjectKey: nonBlankString })
  .strict();
const projectTextListSchema = z.array(
  z.string().trim().min(1).max(2_048),
).max(100);
const outreachProfileSchema = z
  .object({
    recordId: z.string().uuid(),
    immutableFingerprint: nonBlankString,
    profile: z
      .object({
        organizationId: nonBlankString,
        websiteProjectId: nonBlankString,
        profileVersionId: z.string().uuid(),
        promotionTargetVersionId: z.string().uuid(),
        keywordsAndTopics: projectTextListSchema,
        productsAndServices: projectTextListSchema,
        targetUrls: z.array(z.string().trim().url().max(2_048)).max(100),
        targetAudiences: projectTextListSchema,
        partnershipGoals: projectTextListSchema,
        market: nonBlankString,
        location: nonBlankString,
        language: nonBlankString,
        authorizedDiscoverySources: projectTextListSchema,
        immutableFingerprint: nonBlankString,
      })
      .strict(),
  })
  .strict();
const sharedSeoEvidenceSchema = z
  .object({
    recordId: z.string().uuid(),
    snapshot: z
      .object({
        organizationId: nonBlankString,
        websiteProjectId: nonBlankString,
        evidenceType: nonBlankString,
        sourceModule: z.enum([
          "site-profile",
          "keywords",
          "competitor-serp",
          "content",
          "gsc",
        ]),
        sourceRecordId: nonBlankString,
        sourceVersion: nonBlankString,
        provider: nonBlankString,
        endpoint: nonBlankString,
        normalizedParameters: z.record(z.string(), z.unknown()),
        requestFingerprint: nonBlankString,
        market: nonBlankString,
        location: nonBlankString,
        language: nonBlankString,
        fetchedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
        providerRequestId: nonBlankString,
        providerTaskId: nonBlankString.nullable(),
        costMicros: z.number().int().nonnegative().nullable(),
        artifactRef: nonBlankString,
        status: z.enum(["ready", "expired", "failed"]),
      })
      .strict(),
  })
  .strict();
const generationInputPinsSchema = z
  .object({
    recordId: z.string().uuid(),
    outreachProfileRecordId: z.string().uuid(),
    immutableFingerprint: nonBlankString,
    pins: z
      .object({
        organizationId: nonBlankString,
        websiteProjectId: nonBlankString,
        projectContextVersion: z.number().int().positive(),
        siteProfileVersionId: z.string().uuid(),
        outreachProfileVersionId: z.string().uuid(),
        promotionTargetVersionId: z.string().uuid(),
        keywordEvidenceSnapshotIds: z.array(z.string().uuid()).max(100),
        sharedEvidenceSnapshotIds: z.array(z.string().uuid()).max(100),
        market: nonBlankString,
        qualificationContractVersion: nonBlankString,
      })
      .strict(),
  })
  .strict();
const bodySchema = z
  .object({
    snapshotId: z.string().uuid(),
    snapshotVersion: z.number().int().positive(),
    projectStatus: z.enum(["ACTIVE", "PAUSED"]),
    canonicalDomain: nonBlankString,
    locale: nonBlankString,
    countryCode: nonBlankString,
    targetMarket: nonBlankString,
    profileVersionId: z.string().uuid(),
    promotionTargetVersionId: z.string().uuid(),
    products: projectTextListSchema,
    keywords: projectTextListSchema,
    targetUrls: z.array(z.string().trim().url().max(2_048)).max(100),
    targetAudiences: projectTextListSchema,
    partnershipGoals: projectTextListSchema,
    inputComplete: z.boolean(),
    jobId: z.string().uuid(),
    outboxEventId: z.string().uuid(),
    outreachProfile: outreachProfileSchema,
    sharedSeoEvidence: z.array(sharedSeoEvidenceSchema).max(100),
    generationInputPins: generationInputPinsSchema,
  })
  .strict()
  .superRefine((body, context) => {
    if (!body.inputComplete) return;
    if (body.products.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["products"],
        message: "A complete Website Project context requires a site theme.",
      });
    }
    if (
      body.outreachProfile.profile.keywordsAndTopics.length === 0
      && body.outreachProfile.profile.targetUrls.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["keywords"],
        message: "A promotion topic or published target is required.",
      });
    }
    if (
      !body.sharedSeoEvidence.some(
        (item) => item.snapshot.sourceModule === "site-profile",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["sharedSeoEvidence"],
        message: "A traceable Website Project site profile is required.",
      });
    }
  });
const responseSchema = z
  .object({
    state: z.enum(["projected", "replayed"]),
    snapshotVersion: z.number().int().positive(),
    inputRequired: z.boolean(),
    jobScheduled: z.boolean(),
    jobId: z.string().uuid().nullable(),
  })
  .strict();

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

export function registerProjectContextProjectionRoute(
  app: FastifyInstance,
  command: ProjectContextProjectionCommand,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/internal/v1/projects/:websiteProjectKey/backlinks/project-context-projection",
    {
      schema: {
        hide: true,
        params: paramsSchema,
        body: bodySchema,
        response: {
          200: responseSchema,
          400: backlinkProblemDetailsSchema,
          401: backlinkProblemDetailsSchema,
          403: backlinkProblemDetailsSchema,
          409: backlinkProblemDetailsSchema,
          500: backlinkProblemDetailsSchema,
        },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = request.platformContext;
      if (context.project === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.accessDenied,
          message: "A project-bound platform context is required.",
        });
      }
      return command.project({
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        actorId: context.actor.userId,
        actorSessionId: context.actor.sessionId,
        actorRoles: context.actor.roles,
        correlationId: context.correlationId,
        ...request.body,
      });
    },
  );
}
