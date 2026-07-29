import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

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

export const dangerousSettingsConfirmation =
  "CONFIRM DANGEROUS CHANGE";

const nonBlank = z.string().trim().min(1);
const nullableNonBlank = nonBlank.nullable();
const params = z.object({ websiteProjectKey: nonBlank }).strict();
const values = z.object({
  reportingTimezone: nonBlank,
  reportLookbackDays: z.number().int().min(1).max(366),
  exportExpiryHours: z.number().int().min(1).max(168),
}).strict();
const switchLayer = z.enum(["project", "provider"]);
const switchSourceLayer = z.enum([
  "global",
  "organization",
  "workspace",
  "project",
  "provider",
  "default",
  "authority_unavailable",
]);
const killSwitch = z.object({
  capability: nonBlank,
  provider: nullableNonBlank,
  effectiveBlocked: z.boolean(),
  sourceLayer: switchSourceLayer,
  sourceScopeId: nullableNonBlank,
  sourceVersion: z.number().int().positive().nullable(),
  editable: z.boolean(),
}).strict();
const settings = z.object({
  id: nonBlank,
  version: z.number().int().positive(),
  values,
}).strict();
const retention = z.object({
  id: nonBlank,
  version: z.number().int().positive(),
  rules: z.array(z.object({
    category: nonBlank,
    retainForDays: z.number().int().nonnegative(),
  }).strict()),
  exceptions: z.array(z.enum([
    "legal_hold",
    "audit_record",
    "lifecycle_record",
    "active_suppression",
  ])),
}).strict();
const viewResponse = z.object({
  settings,
  killSwitches: z.array(killSwitch),
  editableKillSwitchLayers: z.array(switchLayer),
  retention,
}).strict();
const settingsResponse = z.object({ settings }).strict();
const switchResponse = z.object({ killSwitch }).strict();

type SettingsValues = z.output<typeof values>;
type KillSwitchView = z.output<typeof killSwitch>;
type GovernanceView = z.output<typeof viewResponse>;

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

export function registerBacklinksSettingsGovernanceRoutes(
  app: FastifyInstance,
  options: Readonly<{
    projectContext: ProjectContextPort;
    service: Readonly<{
      getView(scope: Readonly<{
        organizationId: string;
        workspaceId: string;
        websiteProjectId: string;
      }>): Promise<GovernanceView>;
      updateSettings(input: Readonly<{
        scope: Readonly<{
          organizationId: string;
          workspaceId: string;
          websiteProjectId: string;
        }>;
        expectedVersion: number;
        values: SettingsValues;
        actorId: string;
      }>): Promise<z.output<typeof settings>>;
      updateKillSwitch(input: Readonly<{
        scope: Readonly<{
          organizationId: string;
          workspaceId: string;
          websiteProjectId: string;
        }>;
        expectedVersion: number;
        layer: "project" | "provider";
        capability: string;
        provider: string | null;
        blocked: boolean;
        reason: string;
        actorId: string;
      }>): Promise<KillSwitchView>;
    }>;
  }>,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/settings",
    {
      schema: {
        operationId: "backlinksGetSettingsGovernanceV1",
        params,
        response: {
          200: viewResponse,
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
      return options.service.getView({
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
      });
    },
  );

  typed.put(
    "/api/v1/projects/:websiteProjectKey/backlinks/settings",
    {
      schema: {
        operationId: "backlinksUpdateSettingsV1",
        params,
        body: z.object({
          expectedVersion: z.number().int().positive(),
          values,
        }).strict(),
        response: {
          200: settingsResponse,
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
      const updated = await options.service.updateSettings({
        scope: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        },
        expectedVersion: request.body.expectedVersion,
        values: request.body.values,
        actorId: request.actor.userId,
      });
      return { settings: updated };
    },
  );

  typed.put(
    "/api/v1/projects/:websiteProjectKey/backlinks/settings/kill-switches/:capability",
    {
      schema: {
        operationId: "backlinksUpdateKillSwitchV1",
        params: params.extend({ capability: nonBlank }).strict(),
        body: z.object({
          expectedVersion: z.number().int().nonnegative(),
          layer: switchLayer,
          provider: nullableNonBlank,
          blocked: z.boolean(),
          confirmation: nonBlank,
          reason: nonBlank,
        }).strict(),
        response: {
          200: switchResponse,
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
      if (request.body.confirmation !== dangerousSettingsConfirmation) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "Dangerous settings confirmation did not match.",
        });
      }
      const context = await options.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const updated = await options.service.updateKillSwitch({
        scope: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        },
        expectedVersion: request.body.expectedVersion,
        layer: request.body.layer,
        capability: request.params.capability,
        provider: request.body.provider,
        blocked: request.body.blocked,
        reason: request.body.reason,
        actorId: request.actor.userId,
      });
      return { killSwitch: updated };
    },
  );
}
