import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createDraftCommands } from "../../../src/modules/backlinks/application/commands/draft.command.js";
import { createDraftQuery } from "../../../src/modules/backlinks/application/queries/draft.query.js";
import { registerBacklinksDraftRoutes } from "../../../src/modules/backlinks/api/draft.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
import type {
  CreateDraftGenerationJobInput,
  DraftGenerationJob,
} from "../../../src/modules/backlinks/application/repositories/draft-generation.repository.js";

const opportunityId = "018f0000-0000-7000-8000-000000000095";
const snapshotId = "018f0000-0000-7000-8000-000000000195";
const runId = "018f0000-0000-7000-8000-000000000295";
const draftId = "018f0000-0000-7000-8000-000000000395";
const member = createActorContext({
  userId: "user-95",
  sessionId: "session-95",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "organization-95",
    workspaceId: "workspace-95",
  }),
  project: createProjectContext({
    websiteProjectId: "project-95",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-95",
    promotionTargetVersionId: "target-95",
  }),
};

describe("BL-AI-095 Draft Job API", () => {
  it("enforces idempotency, permission, budget, 202 creation, and polling", async () => {
    const jobs = new Map<string, DraftGenerationJob>();
    const idempotency = new Map<string, {
      requestHash: string;
      job: DraftGenerationJob;
    }>();
    let budgetAvailable = true;
    const repository = {
      async createJob(input: CreateDraftGenerationJobInput) {
        const prior = idempotency.get(input.idempotencyKey);
        if (prior !== undefined) {
          if (prior.requestHash !== input.requestHash) {
            throw new Error("Idempotency key payload mismatch.");
          }
          return prior.job;
        }
        const job: DraftGenerationJob = {
          runId,
          draftId,
          status: "QUEUED",
          started: false,
          opportunityId: input.opportunityId,
          evidenceSnapshotId: input.evidenceSnapshotId,
          promptVersion: input.promptVersion,
          outputSchemaVersion: input.outputSchemaVersion,
          baseDraftVersion: 1,
          versionId: null,
          lastSuccessfulVersionId: null,
        };
        jobs.set(runId, job);
        idempotency.set(input.idempotencyKey, {
          requestHash: input.requestHash,
          job,
        });
        return job;
      },
      async getJob(input: { runId: string }) {
        const job = jobs.get(input.runId);
        if (job === undefined) {
          throw new Error("Draft generation Job was not found.");
        }
        return job;
      },
      async getDraft() {
        throw new Error("not used");
      },
      async claimJob() {
        throw new Error("not used");
      },
      async completeJob() {
        throw new Error("not used");
      },
      async failJob() {
        throw new Error("not used");
      },
    };
    const commands = createDraftCommands({
      repository,
      budget: {
        async assertAvailable() {
          if (!budgetAvailable) {
            throw new Error("BUDGET_EXCEEDED");
          }
        },
      },
      newId: (() => {
        const values = [draftId, runId];
        return () => values.shift() ?? "018f0000-0000-7000-8000-999999999999";
      })(),
      now: () => new Date("2026-07-27T09:00:00.000Z"),
      promptVersion: "draft-prompt.v1",
      outputSchemaVersion: "draft-output.v1",
    });
    const app = Fastify({ logger: false, genReqId: () => "request-95" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = request.headers["x-role"] === "viewer"
        ? createActorContext({
            userId: "viewer-95",
            sessionId: "viewer-session-95",
            roles: ["viewer"],
          })
        : member;
    });
    const module = createBacklinksModule({
      projectContext: {
        resolve: async ({ actor, websiteProjectKey }) => {
          if (websiteProjectKey === "foreign") {
            throw new BacklinkError({
              code: backlinkErrorCodes.accessDenied,
              message: "Project denied.",
            });
          }
          return { ...context, actor };
        },
      },
      queries: createDraftQuery(repository),
    });
    registerBacklinksDraftRoutes(app, { module, commands });
    await app.ready();
    afterAll(() => app.close());

    const create = (key: string, logicalDraftKey: string, role?: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/project-key/backlinks/opportunities/${opportunityId}/draft-jobs`,
        headers: {
          "idempotency-key": key,
          ...(role === undefined ? {} : { "x-role": role }),
        },
        payload: {
          evidenceSnapshotId: snapshotId,
          logicalDraftKey,
        },
      });
    const created = await create("draft-request-95", "initial-outreach");
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      jobId: runId,
      draftId,
      status: "QUEUED",
      replayed: false,
      meta: { websiteProjectId: "project-95", requestId: "request-95" },
    });
    expect((await create(
      "draft-request-95",
      "initial-outreach",
    )).json()).toMatchObject({
      jobId: runId,
      replayed: true,
    });
    expect((await create(
      "draft-request-95",
      "different-outreach",
    )).statusCode).toBe(409);
    expect((await create(
      "viewer-request-95",
      "viewer-outreach",
      "viewer",
    )).statusCode).toBe(403);

    budgetAvailable = false;
    expect((await create(
      "budget-request-95",
      "budget-outreach",
    )).statusCode).toBe(429);
    budgetAvailable = true;

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/draft-jobs/${runId}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      job: {
        id: runId,
        draftId,
        status: "QUEUED",
        lastSuccessfulVersionId: null,
      },
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/projects/foreign/backlinks/draft-jobs/${runId}`,
    })).statusCode).toBe(403);
  });
});
