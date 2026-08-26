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
import {
  AiDraftError,
} from "../../../src/modules/backlinks/ports/ai-draft.port.js";
import type {
  CreateDraftGenerationJobInput,
  DraftGenerationJob,
} from "../../../src/modules/backlinks/application/repositories/draft-generation.repository.js";

const opportunityId = "018f0000-0000-7000-8000-000000000095";
const snapshotId = "018f0000-0000-7000-8000-000000000195";
const requestSnapshotId = "018f0000-0000-7000-8000-000000000196";
const runId = "018f0000-0000-7000-8000-000000000295";
const draftId = "018f0000-0000-7000-8000-000000000395";
const contactId = "018f0000-0000-7000-8000-000000000495";
const contactVersion = 2;
const queuedAt = new Date("2026-07-27T09:00:00.000Z");
const generationRequest = {
  cooperationType: "GENERAL_PARTNERSHIP",
  linkAttributePreference: "NOT_SPECIFIED",
  promotionTargetUrl: "https://example.com/product",
  anchorTextSuggestion: null,
  language: "en-US",
  tone: "NEUTRAL_BUSINESS",
  subjectStyle: "CLEAR_DIRECT",
  additionalRequirements: "",
  forbiddenPhrases: [],
} as const;
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
    let budgetChecks = 0;
    let modelProviderAvailable = true;
    let preparedSnapshotCount = 0;
    let prepareError: Error | null = null;
    const repository = {
      async prepareEvidenceSnapshot() {
        preparedSnapshotCount += 1;
        if (prepareError !== null) throw prepareError;
        return { snapshotId, requestSnapshotId, replayed: false };
      },
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
          contactId: input.contactId,
          contactVersion: input.contactVersion,
          evidenceSnapshotId: input.evidenceSnapshotId,
          requestSnapshotId: input.requestSnapshotId,
          request: generationRequest,
          generator: null,
          promptVersion: input.promptVersion,
          outputSchemaVersion: input.outputSchemaVersion,
          baseDraftVersion: 1,
          versionId: null,
          lastSuccessfulVersionId: null,
          queuedAt,
          startedAt: null,
          finishedAt: null,
          latencyMs: null,
          attemptCount: 0,
          lastErrorCategory: null,
          diagnosticCode: null,
          persistenceLatencyMs: null,
          readiness: "QUEUED",
          fallbackReason: null,
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
      async findLatestJob(input: {
        opportunityId: string;
        logicalDraftKey: string;
      }) {
        return [...jobs.values()]
          .find((job) =>
            job.opportunityId === input.opportunityId
            && input.logicalDraftKey === "initial-outreach"
          ) ?? null;
      },
      async getDraft() {
        throw new Error("not used");
      },
      async claimJob() {
        throw new Error("not used");
      },
      async loadPromptContext() {
        throw new Error("not used");
      },
      async completeJob() {
        throw new Error("not used");
      },
      async failJob() {
        throw new Error("not used");
      },
      async scheduleRetry() {
        throw new Error("not used");
      },
    };
    const commands = createDraftCommands({
      repository,
      budget: {
        async assertAvailable() {
          budgetChecks += 1;
          if (!budgetAvailable) {
            throw new AiDraftError({
              code: "BUDGET_EXCEEDED",
              message: "AI Draft budget is exhausted.",
              retryable: false,
            });
          }
        },
      },
      newId: (() => {
        const values = [
          snapshotId,
          requestSnapshotId,
          draftId,
          runId,
          "018f0000-0000-7000-8000-000000000595",
        ];
        return () => values.shift() ?? "018f0000-0000-7000-8000-999999999999";
      })(),
      now: () => new Date("2026-07-27T09:00:00.000Z"),
      promptVersion: "draft-prompt.v1",
      outputSchemaVersion: "draft-output.v1",
      generationMode: "MODEL",
      modelProviderAvailable: () => modelProviderAvailable,
      scheduler: {
        async start(input) {
          return { workflowId: `draft-generation:${input.runId}` };
        },
      },
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
          contactId,
          contactVersion,
          logicalDraftKey,
          request: generationRequest,
        },
      });
    const created = await create("draft-request-95", "initial-outreach");
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      jobId: runId,
      draftId,
      status: "QUEUED",
      contactId,
      contactVersion,
      evidenceSnapshotId: snapshotId,
      requestSnapshotId,
      workflowId: `draft-generation:${runId}`,
      generationMode: "MODEL",
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

    prepareError = new Error("DRAFT_PROMOTION_TARGET_OUTSIDE_PROJECT");
    const outsideProject = await create(
      "outside-project-request-95",
      "outside-project-outreach",
    );
    expect(outsideProject.statusCode).toBe(400);
    expect(outsideProject.json()).toMatchObject({
      code: "BACKLINK_INVALID_REQUEST",
      message:
        "The promotion target must be a valid HTTP(S) page on this project's website.",
      fieldErrors: [{
        field: "request.promotionTargetUrl",
      }],
    });
    prepareError = new Error("DRAFT_PROJECT_CONTEXT_INCOMPLETE");
    const incompleteProject = await create(
      "incomplete-project-request-95",
      "incomplete-project-outreach",
    );
    expect(incompleteProject.statusCode).toBe(409);
    expect(incompleteProject.json()).toMatchObject({
      code: "BACKLINK_CONFLICT",
      fieldErrors: [{
        field: "projectMarketingContext",
      }],
    });
    prepareError = null;

    const preparedBeforeMisconfigured = preparedSnapshotCount;
    const budgetChecksBeforeMisconfigured = budgetChecks;
    modelProviderAvailable = false;
    const misconfigured = await create(
      "misconfigured-request-95",
      "misconfigured-outreach",
    );
    expect(misconfigured.statusCode).toBe(202);
    expect(misconfigured.json()).toMatchObject({
      status: "QUEUED",
      generationMode: "MODEL",
    });
    expect(preparedSnapshotCount).toBe(preparedBeforeMisconfigured + 1);
    expect(budgetChecks).toBe(budgetChecksBeforeMisconfigured);
    modelProviderAvailable = true;

    const preparedBeforeBudgetExceeded = preparedSnapshotCount;
    const budgetChecksBeforeBudgetExceeded = budgetChecks;
    budgetAvailable = false;
    const budgetExceeded = await create(
      "budget-request-95",
      "budget-outreach",
    );
    expect(budgetExceeded.statusCode).toBe(202);
    expect(budgetExceeded.json()).toMatchObject({
      status: "QUEUED",
      generationMode: "MODEL",
    });
    expect(preparedSnapshotCount).toBe(preparedBeforeBudgetExceeded + 1);
    expect(budgetChecks).toBe(budgetChecksBeforeBudgetExceeded + 1);
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
        contactId,
        contactVersion,
        requestSnapshotId,
        request: generationRequest,
        generator: null,
        lastSuccessfulVersionId: null,
        queuedAt: "2026-07-27T09:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        deadlineAt: "2026-07-27T09:01:00.000Z",
        queueWaitMs: null,
        latencyMs: null,
        persistenceLatencyMs: null,
        attemptCount: 0,
        lastErrorCategory: null,
        diagnosticCode: null,
        readiness: "QUEUED",
        fallbackReason: null,
      },
    });
    const latest = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/opportunities/${opportunityId}/draft-jobs/latest?logicalDraftKey=initial-outreach`,
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      job: {
        id: runId,
        draftId,
        status: "QUEUED",
        queuedAt: "2026-07-27T09:00:00.000Z",
      },
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/opportunities/${opportunityId}/draft-jobs/latest?logicalDraftKey=unknown`,
    })).json()).toMatchObject({ job: null });
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/projects/foreign/backlinks/draft-jobs/${runId}`,
    })).statusCode).toBe(403);
  });
});
