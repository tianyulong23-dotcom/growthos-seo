import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createPlacementReviewCommand,
} from "../../../src/modules/backlinks/application/commands/placement-review.command.js";
import type {
  PlacementReviewCandidate,
  PlacementReviewRepository,
  PlacementReviewRepositoryInput,
} from "../../../src/modules/backlinks/application/repositories/placement-review.repository.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  registerBacklinksPlacementReviewRoutes,
} from "../../../src/modules/backlinks/api/placement-review.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const candidateId = "018f0000-0000-7000-8000-000000000149";
const validationRunId = "018f0000-0000-7000-8000-000000000150";
const member = createActorContext({
  userId: "user-149",
  sessionId: "session-149",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "org-149",
    workspaceId: "workspace-149",
  }),
  project: createProjectContext({
    websiteProjectId: "project-149",
    canonicalDomain: "client.example",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-149",
    promotionTargetVersionId: "target-149",
  }),
};

function reviewCandidate(
  status: "INVALID" | "INCONCLUSIVE" = "INCONCLUSIVE",
  reasonCode = "SAFE_FETCH_TIMEOUT",
): PlacementReviewCandidate {
  return {
    candidateId,
    opportunityId: "018f0000-0000-7000-8000-000000000249",
    candidateStatus: "REVIEW_REQUIRED",
    matchStatus: "AUTO_MATCHED",
    initialValidationStatus: status,
    sourcePageUrl: "https://publisher.example/article",
    normalizedSourceUrl: "https://publisher.example/article",
    normalizedSourceUrlHash: "a".repeat(64),
    targetUrl: "https://client.example/guide",
    normalizedTargetUrl: "https://client.example/guide",
    normalizedTargetUrlHash: "b".repeat(64),
    urlNormalizationVersion: "whatwg-url-tldts-7.4.9-sha256-v1",
    version: 2,
    latestValidation: {
      validationRunId,
      runNumber: 1,
      validationMethod: "direct_page_check",
      status,
      reasonCode,
      evidenceSnapshot: {
        policyVersion: "placement-initial-validation.static.v1",
        result: { status, reasonCode },
      },
      evidenceSnapshotHash: "c".repeat(64),
      evidenceContractVersion: "placement.initial-validation.v1",
      evidenceSchemaVersion: 1,
      evidenceObservedAt: "2026-07-27T10:00:00.000Z",
      initialEvidenceRef: `placement-validation:${validationRunId}`,
    },
  };
}

function createRepository(): PlacementReviewRepository & Readonly<{
  writes: PlacementReviewRepositoryInput[];
  candidates: Map<string, PlacementReviewCandidate>;
}> {
  const writes: PlacementReviewRepositoryInput[] = [];
  const candidates = new Map([[candidateId, reviewCandidate()]]);

  return {
    writes,
    candidates,
    async getCandidate(input) {
      return candidates.get(input.candidateId) ?? null;
    },
    async review(input) {
      writes.push(input);
      const current = candidates.get(input.candidateId);
      if (
        current === undefined
        || current.version !== input.expectedVersion
      ) {
        return { state: "version_conflict" };
      }

      if (input.action === "manual_confirm") {
        return {
          state: "completed",
          response: {
            action: "manual_confirm",
            candidateId: input.candidateId,
            candidateStatus: "PROMOTED",
            initialValidationStatus: "MANUALLY_CONFIRMED",
            candidateVersion: current.version + 1,
            validationRunId: input.validationRunId,
            placementId: input.placementId,
            placementVersion: 1,
            monitoringOutboxEventId: input.monitoringOutboxEventId,
            lifecycleEventId: input.lifecycleEventId,
            auditEventId: input.auditEventId,
          },
        };
      }

      return {
        state: "completed",
        response: {
          action: "reject",
          candidateId: input.candidateId,
          candidateStatus: "REJECTED",
          initialValidationStatus: current.initialValidationStatus,
          candidateVersion: current.version + 1,
          lifecycleEventId: input.lifecycleEventId,
          auditEventId: input.auditEventId,
        },
      };
    },
  };
}

async function createApp(repository: PlacementReviewRepository) {
  const ids = [
    "018f0000-0000-7000-8000-000000000349",
    "018f0000-0000-7000-8000-000000000449",
    "018f0000-0000-7000-8000-000000000549",
    "018f0000-0000-7000-8000-000000000649",
    "018f0000-0000-7000-8000-000000000749",
    "018f0000-0000-7000-8000-000000000849",
  ];
  const app = Fastify({ logger: false, genReqId: () => "request-149" });
  await registerBacklinksOpenApi(app);
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = request.headers["x-role"] === "viewer"
      ? createActorContext({
          userId: "viewer-149",
          sessionId: "viewer-session-149",
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
  const command = createPlacementReviewCommand({
    repository,
    newId: () => ids.shift() ?? crypto.randomUUID(),
    now: () => new Date("2026-07-27T11:00:00.000Z"),
  });
  registerBacklinksPlacementReviewRoutes(app, { module, command });
  await app.ready();
  return app;
}

describe("BL-AI-149 Placement manual review API", () => {
  const repository = createRepository();
  const appPromise = createApp(repository);
  afterAll(async () => (await appPromise).close());

  it("manually confirms only an inconclusive Candidate and projects KPI state", async () => {
    const response = await (await appPromise).inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/placement-candidates/${candidateId}/confirm`,
      payload: {
        expectedVersion: 2,
        reason: "Operator verified the rendered link in a normal browser.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidateId,
      candidateStatus: "PROMOTED",
      initialValidationStatus: "MANUALLY_CONFIRMED",
      candidateVersion: 3,
      placementVersion: 1,
      countsTowardKpi: true,
      meta: {
        websiteProjectId: "project-149",
        requestId: "request-149",
      },
    });
    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0]).toMatchObject({
      action: "manual_confirm",
      actorId: "user-149",
      candidateId,
      expectedVersion: 2,
      previousValidationRunId: validationRunId,
      previousValidationStatus: "INCONCLUSIVE",
      previousReasonCode: "SAFE_FETCH_TIMEOUT",
      manualEvidenceSnapshot: {
        decision: "MANUALLY_CONFIRMED",
        overriddenValidation: {
          validationRunId,
          status: "INCONCLUSIVE",
          reasonCode: "SAFE_FETCH_TIMEOUT",
          evidenceSnapshot: {
            result: {
              status: "INCONCLUSIVE",
              reasonCode: "SAFE_FETCH_TIMEOUT",
            },
          },
        },
      },
    });
    expect(repository.writes[0]?.manualEvidenceSnapshotHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(repository.writes[0]?.auditIntegrityHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("rejects a reviewed Candidate without producing a KPI Placement", async () => {
    const rejectedId = "018f0000-0000-7000-8000-000000000159";
    repository.candidates.set(
      rejectedId,
      { ...reviewCandidate("INVALID", "TARGET_LINK_MISSING"),
        candidateId: rejectedId },
    );
    const response = await (await appPromise).inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/placement-candidates/${rejectedId}/reject`,
      payload: {
        expectedVersion: 2,
        reason: "The submitted page does not contain the required link.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidateId: rejectedId,
      candidateStatus: "REJECTED",
      initialValidationStatus: "INVALID",
      candidateVersion: 3,
      countsTowardKpi: false,
    });
    expect(response.json()).not.toHaveProperty("placementId");
    expect(repository.writes.at(-1)).toMatchObject({
      action: "reject",
      candidateId: rejectedId,
      previousValidationStatus: "INVALID",
      previousReasonCode: "TARGET_LINK_MISSING",
    });
  });

  it("blocks security and factual validation failures from ordinary confirmation", async () => {
    const blockedId = "018f0000-0000-7000-8000-000000000169";
    const missingId = "018f0000-0000-7000-8000-000000000179";
    repository.candidates.set(
      blockedId,
      { ...reviewCandidate("INCONCLUSIVE", "SAFE_FETCH_URL_BLOCKED"),
        candidateId: blockedId },
    );
    repository.candidates.set(
      missingId,
      { ...reviewCandidate("INVALID", "TARGET_LINK_MISSING"),
        candidateId: missingId },
    );
    const confirm = (id: string) => (appPromise).then((app) => app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/placement-candidates/${id}/confirm`,
      payload: {
        expectedVersion: 2,
        reason: "Attempted ordinary override.",
      },
    }));

    const blocked = await confirm(blockedId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: backlinkErrorCodes.conflict,
    });
    const missing = await confirm(missingId);
    expect(missing.statusCode).toBe(409);
    expect(repository.writes).toHaveLength(2);
  });

  it("enforces ExpectedVersion, permissions, project scope, and strict schemas", async () => {
    const app = await appPromise;
    const post = (
      project: string,
      action: "confirm" | "reject",
      payload: unknown,
      role?: string,
    ) => app.inject({
      method: "POST",
      url: `/api/v1/projects/${project}/backlinks/placement-candidates/${candidateId}/${action}`,
      headers: role === undefined ? {} : { "x-role": role },
      payload,
    });

    expect((await post("project-key", "reject", {
      expectedVersion: 99,
      reason: "Stale reviewer screen.",
    })).statusCode).toBe(409);
    expect((await post("project-key", "reject", {
      expectedVersion: 2,
      reason: "Viewer cannot decide.",
    }, "viewer")).statusCode).toBe(403);
    expect((await post("foreign", "reject", {
      expectedVersion: 2,
      reason: "Cross-project attempt.",
    })).statusCode).toBe(403);
    expect((await post("project-key", "reject", {
      expectedVersion: 2,
      reason: "",
    })).statusCode).toBe(400);
    expect((await post("project-key", "reject", {
      expectedVersion: 2,
      reason: "Valid reason.",
      countsTowardKpi: true,
    })).statusCode).toBe(400);
  });
});
