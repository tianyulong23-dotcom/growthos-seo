import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerBacklinksSettingsGovernanceRoutes,
} from "../../../src/modules/backlinks/api/settings/settings-governance.route.js";
import {
  registerBacklinksOpenApi,
} from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const actor = createActorContext({
  userId: "user-171",
  sessionId: "session-171",
  roles: ["member"],
});
const context = {
  actor,
  tenant: createTenantContext({
    organizationId: "organization-171",
    workspaceId: "workspace-171",
  }),
  project: createProjectContext({
    websiteProjectId: "project-171",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-171",
    promotionTargetVersionId: "target-171",
  }),
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("BL-AI-171..173 Settings/Governance API", () => {
  it("returns versioned settings, effective switch source, retention exceptions, and handles 409", async () => {
    const app = Fastify({ logger: false, genReqId: () => "request-171" });
    apps.push(app);
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = actor;
    });
    registerBacklinksSettingsGovernanceRoutes(app, {
      projectContext: { resolve: async () => context },
      service: {
        getView: async () => ({
          settings: {
            id: "settings-v3",
            version: 3,
            values: {
              reportingTimezone: "Asia/Shanghai",
              reportLookbackDays: 30,
              exportExpiryHours: 24,
            },
          },
          killSwitches: [{
            capability: "DATA_PROVIDER",
            provider: "DataForSEO",
            effectiveBlocked: true,
            sourceLayer: "organization",
            sourceScopeId: "organization-171",
            sourceVersion: 2,
            editable: false,
          }],
          editableKillSwitchLayers: ["project", "provider"],
          retention: {
            id: "retention-v1",
            version: 1,
            rules: [{
              category: "raw_html",
              retainForDays: 30,
            }],
            exceptions: ["legal_hold", "audit_record", "active_suppression"],
          },
        }),
        updateSettings: async (input) => {
          if (input.expectedVersion !== 3) {
            throw new BacklinkError({
              code: backlinkErrorCodes.conflict,
              message: "Settings version conflict.",
            });
          }
          return {
            id: "settings-v4",
            version: 4,
            values: input.values,
          };
        },
        updateKillSwitch: async (input) => ({
          capability: input.capability,
          provider: input.provider,
          effectiveBlocked: input.blocked,
          sourceLayer: input.layer,
          sourceScopeId: context.project.websiteProjectId,
          sourceVersion: input.expectedVersion + 1,
          editable: true,
        }),
      },
    });
    await app.ready();

    const view = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/settings",
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      settings: { version: 3 },
      killSwitches: [{
        provider: "DataForSEO",
        sourceLayer: "organization",
        effectiveBlocked: true,
      }],
      retention: {
        exceptions: ["legal_hold", "audit_record", "active_suppression"],
      },
    });

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/project-key/backlinks/settings",
      payload: {
        expectedVersion: 2,
        values: {
          reportingTimezone: "UTC",
          reportLookbackDays: 14,
          exportExpiryHours: 12,
        },
      },
    });
    expect(conflict.statusCode).toBe(409);

    const unconfirmed = await app.inject({
      method: "PUT",
      url:
        "/api/v1/projects/project-key/backlinks/settings/kill-switches/" +
        "DATA_PROVIDER",
      payload: {
        expectedVersion: 2,
        layer: "provider",
        provider: "DataForSEO",
        blocked: false,
        confirmation: "wrong",
        reason: "approved canary",
      },
    });
    expect(unconfirmed.statusCode).toBe(400);
  });
});
