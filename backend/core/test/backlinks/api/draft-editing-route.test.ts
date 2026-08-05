import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createDraftEditingCommands } from "../../../src/modules/backlinks/application/commands/draft.command.js";
import { registerBacklinksDraftEditingRoutes } from "../../../src/modules/backlinks/api/draft.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import type {
  DraftEditingRepository,
  DraftGenerationRepository,
} from "../../../src/modules/backlinks/application/repositories/draft-generation.repository.js";
import { createDraftQuery } from "../../../src/modules/backlinks/application/queries/draft.query.js";

const draftId = "018f0000-0000-7000-8000-000000000096";
const originalVersionId = "018f0000-0000-7000-8000-000000000196";
const manualVersionId = "018f0000-0000-7000-8000-000000000296";
const member = createActorContext({
  userId: "user-96",
  sessionId: "session-96",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "organization-96",
    workspaceId: "workspace-96",
  }),
  project: createProjectContext({
    websiteProjectId: "project-96",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-96",
    promotionTargetVersionId: "target-96",
  }),
};

describe("BL-AI-096 Draft editing and approval API", () => {
  it("appends a manual Version, requires ExpectedVersion, and preserves the original", async () => {
    const versions = new Map([
      [originalVersionId, {
        subjectText: "Original subject",
        bodyText: "Original body",
        bodyDocument: null,
        source: "MODEL" as const,
      }],
    ]);
    let aggregateVersion = 2;
    let currentVersionId = originalVersionId;
    const repository: DraftEditingRepository = {
      async saveManualVersion(input) {
        if (input.expectedVersion !== aggregateVersion) {
          return {
            state: "version_conflict",
            currentVersion: aggregateVersion,
          };
        }
        versions.set(input.versionId, {
          subjectText: input.subjectText,
          bodyText: input.bodyText,
          bodyDocument: input.bodyDocument,
          source: "MANUAL",
        });
        currentVersionId = input.versionId;
        aggregateVersion += 1;
        return {
          state: "completed",
          draftId,
          versionId: input.versionId,
          draftVersion: aggregateVersion,
          status: "draft",
        };
      },
      async approve(input) {
        if (input.expectedVersion !== aggregateVersion) {
          return {
            state: "version_conflict",
            currentVersion: aggregateVersion,
          };
        }
        aggregateVersion += 1;
        return {
          state: "completed",
          draftId,
          versionId: currentVersionId,
          draftVersion: aggregateVersion,
          status: "approved",
        };
      },
    };
    const queryRepository: Pick<
      DraftGenerationRepository,
      "getJob" | "findLatestJob" | "getDraft"
    > = {
      async getJob() {
        throw new Error("unused");
      },
      async findLatestJob() {
        return null;
      },
      async getDraft() {
        const current = versions.get(currentVersionId);
        if (current === undefined) throw new Error("not found");
        return {
          draftId,
          opportunityId: "018f0000-0000-7000-8000-000000000396",
          contactId: null,
          contactVersion: null,
          status: aggregateVersion === 4 ? "approved" : "draft",
          draftVersion: aggregateVersion,
          approvedVersionId: aggregateVersion === 4
            ? currentVersionId
            : null,
          currentVersion: {
            id: currentVersionId,
            versionNo: currentVersionId === originalVersionId ? 1 : 2,
            subjectText: current.subjectText,
            bodyText: current.bodyText,
            bodyDocument: current.bodyDocument,
            source: current.source,
            createdAt: "2026-07-27T09:30:00.000Z",
          },
        };
      },
    };
    const commands = createDraftEditingCommands({
      repository,
      newId: () => manualVersionId,
      now: () => new Date("2026-07-27T09:30:00.000Z"),
    });
    const app = Fastify({ logger: false, genReqId: () => "request-96" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = request.headers["x-role"] === "viewer"
        ? createActorContext({
            userId: "viewer-96",
            sessionId: "viewer-session-96",
            roles: ["viewer"],
          })
        : member;
    });
    registerBacklinksDraftEditingRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor }) => ({ ...context, actor }),
        },
        queries: createDraftQuery(queryRepository),
      }),
      commands,
    });
    await app.ready();
    afterAll(() => app.close());

    const initial = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      draft: {
        id: draftId,
        status: "draft",
        draftVersion: 2,
        currentVersion: {
          id: originalVersionId,
          subjectText: "Original subject",
          bodyText: "Original body",
          bodyDocument: {
            type: "doc",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "Original body" }],
            }],
          },
        },
      },
    });

    const save = await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}/versions`,
      payload: {
        expectedVersion: 2,
        subjectText: "Edited subject",
        bodyDocument: {
          type: "doc",
          content: [{
            type: "paragraph",
            content: [
              { type: "text", text: "Edited ", marks: [{ type: "bold" }] },
              { type: "text", text: "body" },
            ],
          }],
        },
      },
    });
    expect(save.statusCode).toBe(201);
    expect(save.json()).toMatchObject({
      draftId,
      versionId: manualVersionId,
      draftVersion: 3,
      status: "draft",
    });
    expect(versions.get(originalVersionId)).toEqual({
      subjectText: "Original subject",
      bodyText: "Original body",
      bodyDocument: null,
      source: "MODEL",
    });
    expect(versions.get(manualVersionId)).toEqual({
      subjectText: "Edited subject",
      bodyText: "Edited body",
      bodyDocument: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "Edited ", marks: [{ type: "bold" }] },
            { type: "text", text: "body" },
          ],
        }],
      },
      source: "MANUAL",
    });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}/approve`,
      payload: { expectedVersion: 2 },
    })).statusCode).toBe(409);
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}/approve`,
      payload: { expectedVersion: 3 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      draftId,
      versionId: manualVersionId,
      draftVersion: 4,
      status: "approved",
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}/versions`,
      headers: { "x-role": "viewer" },
      payload: {
        expectedVersion: 4,
        subjectText: "Forbidden",
        bodyDocument: {
          type: "doc",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Forbidden" }],
          }],
        },
      },
    })).statusCode).toBe(403);

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}/versions`,
      payload: {
        expectedVersion: 4,
        subjectText: "Unsafe",
        bodyDocument: {
          type: "doc",
          content: [{
            type: "paragraph",
            content: [{
              type: "text",
              text: "Unsafe",
              marks: [{
                type: "link",
                attrs: { href: "javascript:alert(1)" },
              }],
            }],
          }],
        },
      },
    })).statusCode).toBe(400);

    const refreshed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/drafts/${draftId}`,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      draft: {
        status: "approved",
        draftVersion: 4,
        approvedVersionId: manualVersionId,
        currentVersion: {
          id: manualVersionId,
          subjectText: "Edited subject",
          bodyText: "Edited body",
        },
      },
    });
  });
});
