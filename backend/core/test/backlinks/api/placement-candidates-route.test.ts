import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createPlacementCandidateCommand,
  type CreatePlacementCandidateRepositoryInput,
  type PlacementCandidateRepository,
} from "../../../src/modules/backlinks/application/commands/placement-candidate.command.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { registerBacklinksPlacementCandidateRoutes } from "../../../src/modules/backlinks/api/placement-candidates.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const candidateId = "018f0000-0000-7000-8000-000000000147";
const member = createActorContext({
  userId: "user-147",
  sessionId: "session-147",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "org-147",
    workspaceId: "workspace-147",
  }),
  project: createProjectContext({
    websiteProjectId: "project-147",
    canonicalDomain: "client.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-147",
    promotionTargetVersionId: "target-147",
  }),
};
const requestBody = {
  sourceType: "manual" as const,
  sourceExternalId: "manual-placement-147",
  sourcePageUrl: "https://Publisher.com/article#reported-section",
  targetUrl: "https://Client.com/offer?campaign=summer#hero",
  evidence: {
    contractVersion: "placement.discovery.manual.v1",
    schemaVersion: 1,
    evidenceId: "manual-evidence-147",
    observedAt: "2026-07-27T09:30:00.000Z",
    sourceRef: "manual-entry:user-147",
    payload: {
      submittedBy: "user-147",
      note: "Published link reported by the operator.",
    },
  },
};

function createRepository(): PlacementCandidateRepository & Readonly<{
  writes: CreatePlacementCandidateRepositoryInput[];
}> {
  const writes: CreatePlacementCandidateRepositoryInput[] = [];
  const idempotencyRecords = new Map<string, Readonly<{
    requestHash: string;
    responseBody: Readonly<{
      candidateId: string;
      status: "PENDING_VALIDATION";
      matchStatus: "UNMATCHED";
      initialValidationStatus: "PENDING";
      version: number;
    }>;
  }>>();

  return {
    writes,
    async create(input) {
      const existing = idempotencyRecords.get(input.idempotencyKey);
      if (existing !== undefined) {
        return {
          state: "replay",
          requestHash: existing.requestHash,
          responseBody: existing.responseBody,
        };
      }

      const responseBody = {
        candidateId: input.candidateId,
        status: input.status,
        matchStatus: input.matchStatus,
        initialValidationStatus: input.initialValidationStatus,
        version: 1,
      } as const;
      writes.push(input);
      idempotencyRecords.set(input.idempotencyKey, {
        requestHash: input.requestHash,
        responseBody,
      });

      return {
        state: "completed",
        requestHash: input.requestHash,
        responseBody,
      };
    },
  };
}

async function createApp(repository: PlacementCandidateRepository) {
  const app = Fastify({ logger: false, genReqId: () => "request-147" });
  await registerBacklinksOpenApi(app);
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = request.headers["x-role"] === "viewer"
      ? createActorContext({
          userId: "viewer-147",
          sessionId: "viewer-session-147",
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
    queries: {},
  });
  const command = createPlacementCandidateCommand({
    repository,
    newId: () => candidateId,
  });
  registerBacklinksPlacementCandidateRoutes(app, { module, command });
  await app.ready();
  return app;
}

describe("BL-AI-147 Placement Candidate creation API", () => {
  const repository = createRepository();
  const appPromise = createApp(repository);
  afterAll(async () => (await appPromise).close());

  it("creates a non-KPI candidate and replays the same semantic request", async () => {
    const app = await appPromise;
    const url =
      "/api/v1/projects/project-key/backlinks/placement-candidates";
    const create = (payload: unknown) => app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": "candidate-create-147" },
      payload,
    });

    const created = await create(requestBody);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      candidateId,
      status: "PENDING_VALIDATION",
      matchStatus: "UNMATCHED",
      initialValidationStatus: "PENDING",
      version: 1,
      countsTowardKpi: false,
      replayed: false,
      meta: {
        organizationId: "org-147",
        workspaceId: "workspace-147",
        websiteProjectId: "project-147",
        requestId: "request-147",
      },
    });
    expect(created.json()).not.toHaveProperty("placementId");
    expect(created.json()).not.toHaveProperty("opportunityId");
    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0]).toMatchObject({
      candidateId,
      sourceType: "manual",
      sourcePageUrl: requestBody.sourcePageUrl,
      normalizedSourceUrl: "https://publisher.com/article",
      targetUrl: requestBody.targetUrl,
      normalizedTargetUrl:
        "https://client.com/offer?campaign=summer",
      status: "PENDING_VALIDATION",
      matchStatus: "UNMATCHED",
      initialValidationStatus: "PENDING",
      evidenceContractVersion: "placement.discovery.manual.v1",
      evidenceSchemaVersion: 1,
    });
    expect(repository.writes[0]?.discoveryEvidenceHash).toMatch(/^[a-f0-9]{64}$/u);

    const replayed = await create({
      ...requestBody,
      evidence: {
        ...requestBody.evidence,
        payload: {
          note: "Published link reported by the operator.",
          submittedBy: "user-147",
        },
      },
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toMatchObject({
      candidateId,
      countsTowardKpi: false,
      replayed: true,
    });
    expect(repository.writes).toHaveLength(1);

    const conflict = await create({
      ...requestBody,
      targetUrl: "https://client.com/offer?campaign=winter",
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: backlinkErrorCodes.conflict,
    });
  });

  it("requires source evidence and rejects unsupported placement URLs", async () => {
    const app = await appPromise;
    const url =
      "/api/v1/projects/project-key/backlinks/placement-candidates";
    const post = (idempotencyKey: string, payload: unknown) => app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": idempotencyKey },
      payload,
    });

    const missingEvidence = await post("candidate-missing-evidence", {
      sourceType: requestBody.sourceType,
      sourcePageUrl: requestBody.sourcePageUrl,
      targetUrl: requestBody.targetUrl,
    });
    expect(missingEvidence.statusCode).toBe(400);

    const missingIdempotencyKey = await app.inject({
      method: "POST",
      url,
      payload: requestBody,
    });
    expect(missingIdempotencyKey.statusCode).toBe(400);

    const emptyEvidence = await post("candidate-empty-evidence", {
      ...requestBody,
      evidence: { ...requestBody.evidence, payload: {} },
    });
    expect(emptyEvidence.statusCode).toBe(400);

    const invalidTarget = await post("candidate-invalid-target", {
      ...requestBody,
      targetUrl: "http://localhost/internal",
    });
    expect(invalidTarget.statusCode).toBe(400);
    expect(invalidTarget.json()).toMatchObject({
      code: backlinkErrorCodes.invalidRequest,
      fieldErrors: [{ field: "targetUrl" }],
    });

    const forbiddenKpiOverride = await post("candidate-kpi-override", {
      ...requestBody,
      countsTowardKpi: true,
    });
    expect(forbiddenKpiOverride.statusCode).toBe(400);
  });

  it("enforces project isolation and placement write permission", async () => {
    const app = await appPromise;
    const post = (project: string, role?: string) => app.inject({
      method: "POST",
      url: `/api/v1/projects/${project}/backlinks/placement-candidates`,
      headers: {
        "idempotency-key": `candidate-access-${project}-${role ?? "member"}`,
        ...(role === undefined ? {} : { "x-role": role }),
      },
      payload: requestBody,
    });

    expect((await post("project-key", "viewer")).statusCode).toBe(403);
    expect((await post("foreign")).statusCode).toBe(403);
  });
});
