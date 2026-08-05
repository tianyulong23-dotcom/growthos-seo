import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import {
  createBacklinksModule,
} from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createPlacementLinksQuery,
} from "../../../src/modules/backlinks/application/queries/placement-links.query.js";
import {
  registerBacklinksLinksRoutes,
} from "../../../src/modules/backlinks/api/links.route.js";
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

const candidateId = "018f0000-0000-7000-8000-000000000101";
const changedPlacementId = "018f0000-0000-7000-8000-000000000102";
const lostPlacementId = "018f0000-0000-7000-8000-000000000103";
const actor = createActorContext({
  userId: "user-1",
  sessionId: "session-1",
  roles: ["member"],
});
const context = {
  actor,
  tenant: createTenantContext({
    organizationId: "org-1",
    workspaceId: "workspace-1",
  }),
  project: createProjectContext({
    websiteProjectId: "project-1",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-1",
    promotionTargetVersionId: "target-1",
  }),
};

const candidateRow = {
  recordType: "candidate",
  displayState: "candidate",
  id: candidateId,
  candidateId,
  placementId: null,
  sourcePageUrl: "https://publisher.example/candidate",
  targetUrl: "https://target.example/landing",
  candidateStatus: "REVIEW_REQUIRED",
  matchStatus: "AUTO_MATCHED",
  validationStatus: "INCONCLUSIVE",
  healthStatus: null,
  monitoringStatus: null,
  version: 3,
  createdAt: "2026-07-28T10:00:00.000Z",
};
const changedRow = {
  recordType: "placement",
  displayState: "changed",
  id: changedPlacementId,
  candidateId,
  placementId: changedPlacementId,
  sourcePageUrl: "https://publisher.example/changed",
  targetUrl: "https://target.example/landing",
  candidateStatus: null,
  matchStatus: null,
  validationStatus: "VALID",
  healthStatus: "changed",
  monitoringStatus: "enabled",
  nextCheckAt: "2026-07-29T12:00:00.000Z",
  consecutiveAnomalies: 1,
  browserFallbackEnabled: true,
  latestObservationId: null,
  latestMonitorRunId: null,
  version: 4,
  createdAt: "2026-07-28T09:00:00.000Z",
};
const lostRow = {
  ...changedRow,
  id: lostPlacementId,
  placementId: lostPlacementId,
  displayState: "lost",
  healthStatus: "lost",
  createdAt: "2026-07-28T08:00:00.000Z",
};

describe("BL-AI-158 Links API", () => {
  it("keeps candidate, confirmed health state, pagination, and project scope separate", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = createPlacementLinksQuery({
      query: async (text, values) => {
        calls.push({ text, values });
        if (text.includes("FROM backlink_placement_candidates c")
          && text.includes("c.id AS \"candidateId\"")) {
          return {
            rows: [{
              ...candidateRow,
              opportunityId: "018f0000-0000-7000-8000-000000000201",
              normalizedSourceUrl: candidateRow.sourcePageUrl,
              normalizedTargetUrl: candidateRow.targetUrl,
              urlNormalizationVersion: "placement-url-key.v1",
              latestValidationRunId: "018f0000-0000-7000-8000-000000000301",
              latestValidationStatus: "INCONCLUSIVE",
              latestValidationObservedAt: candidateRow.createdAt,
              latestEvidenceSnapshotHash: "a".repeat(64),
              latestEvidenceContractVersion: "placement.initial-validation.v1",
              latestEvidenceSchemaVersion: 1,
            }],
          };
        }
        if (text.includes("FROM backlink_placements p")
          && text.includes("p.id AS \"placementId\"")) {
          return {
            rows: [{
              ...changedRow,
              opportunityId: "018f0000-0000-7000-8000-000000000201",
              normalizedSourceUrl: changedRow.sourcePageUrl,
              normalizedTargetUrl: changedRow.targetUrl,
              urlNormalizationVersion: "placement-url-key.v1",
              initialValidationId: "018f0000-0000-7000-8000-000000000302",
              initialEvidenceSnapshotHash: "b".repeat(64),
              evidenceContractVersion: "placement.initial-validation.v1",
              initialEvidenceSchemaVersion: 1,
              updatedAt: changedRow.createdAt,
            }],
          };
        }

        const view = values?.[3];
        const after = values?.[4];
        if (view === "lost" || after !== null && after !== undefined) {
          return { rows: [lostRow] };
        }
        return { rows: [candidateRow, changedRow, lostRow] };
      },
    });
    const app = Fastify({ logger: false, genReqId: () => "request-1" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = actor;
    });
    registerBacklinksLinksRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ websiteProjectKey }) => {
            if (websiteProjectKey === "foreign") {
              throw new BacklinkError({
                code: backlinkErrorCodes.accessDenied,
                message: "Project denied.",
              });
            }
            return context;
          },
        },
        queries: query,
      }),
      reverifyCommand: {
        execute: async () => ({
          placementId: changedPlacementId,
          placementVersion: 5,
          accepted: true,
          replayed: false,
          browserFallbackAllowed: false,
          monitorRun: {
            monitorRunId: "018f0000-0000-7000-8000-000000000104",
            status: "scheduled",
            scheduledFor: "2026-07-29T12:00:00.000Z",
          },
        }),
      },
    });
    await app.ready();
    afterAll(() => app.close());

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/links?view=all&limit=2",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      items: [
        {
          recordType: "candidate",
          displayState: "candidate",
          candidateId,
          countsTowardKpi: false,
        },
        {
          recordType: "placement",
          displayState: "changed",
          placementId: changedPlacementId,
          healthStatus: "changed",
          countsTowardKpi: true,
        },
      ],
      hasMore: true,
      meta: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        requestId: "request-1",
      },
    });
    expect(calls[0]?.values?.slice(0, 4)).toEqual([
      "org-1",
      "workspace-1",
      "project-1",
      "all",
    ]);
    expect(calls[0]?.text).toContain("c.status NOT IN ('PROMOTED','REJECTED')");

    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/links?view=all&limit=2&cursor=${cursor}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      items: [{
        recordType: "placement",
        displayState: "lost",
        placementId: lostPlacementId,
        healthStatus: "lost",
      }],
      hasMore: false,
      nextCursor: null,
    });
    expect(calls[1]?.values?.[4]).toBe(changedRow.createdAt);

    const lost = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/links?view=lost",
    });
    expect(lost.statusCode).toBe(200);
    expect(lost.json()).toMatchObject({
      items: [{ displayState: "lost", placementId: lostPlacementId }],
    });
    expect(calls[2]?.values?.[3]).toBe("lost");

    const candidate = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/links/candidates/${candidateId}`,
    });
    expect(candidate.statusCode).toBe(200);
    expect(candidate.json()).toMatchObject({
      link: {
        recordType: "candidate",
        displayState: "candidate",
        countsTowardKpi: false,
        latestValidation: {
          status: "INCONCLUSIVE",
          evidenceSnapshotHash: "a".repeat(64),
        },
      },
    });

    const placement = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/links/placements/${changedPlacementId}`,
    });
    expect(placement.statusCode).toBe(200);
    expect(placement.json()).toMatchObject({
      link: {
        recordType: "placement",
        displayState: "changed",
        countsTowardKpi: true,
        healthStatus: "changed",
      },
    });

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/projects/foreign/backlinks/links",
    });
    expect(denied.statusCode).toBe(403);
    expect(calls).toHaveLength(5);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/links?cursor=invalid",
    });
    expect(invalid.statusCode).toBe(400);
    expect(calls).toHaveLength(5);
  });

  it("serves lifecycle, immutable evidence, and authorized reverify contracts", async () => {
    const reverifyCalls: unknown[] = [];
    const app = Fastify({ logger: false, genReqId: () => "request-158" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = actor;
    });
    registerBacklinksLinksRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async () => context,
        },
        queries: {
          listLinks: async () => ({
            items: [],
            nextCursor: null,
            hasMore: false,
          }),
          getCandidateLink: async () => null,
          getPlacementLink: async () => null,
          listPlacementEvents: async (_context, placementId, input) => ({
            items: [{
              eventId: "018f0000-0000-7000-8000-000000000104",
              eventType: "placement.recovered",
              occurredAt: "2026-07-29T09:00:00.000Z",
              placementVersion: 5,
              previousHealthStatus: "lost",
              nextHealthStatus: "active",
              observationId:
                "018f0000-0000-7000-8000-000000000105",
              reason: "PLACEMENT_RECOVERED",
            }],
            nextCursor: input.limit === 1 ? "next-events" : null,
            hasMore: input.limit === 1,
          }),
          getPlacementEvidence: async (_context, evidenceId) => ({
            evidenceId,
            placementId: changedPlacementId,
            kind: "placement_observation",
            immutable: true,
            hashVerified: true,
            hash: "a".repeat(64),
            contractVersion: "placement.monitor-observation.v1",
            schemaVersion: 1,
            observedAt: "2026-07-29T09:00:00.000Z",
            executionMode: "static",
            result: "present",
            reasonCode: "TARGET_LINK_FOUND",
            failure: { status: "none", code: null },
            freshness: "fresh",
            source: {
              sourcePageUrl: "https://publisher.example/article",
              targetUrl: "https://target.example/landing",
              fetchMode: "static",
              httpStatus: 200,
              finalUrl: "https://publisher.example/article",
              contentType: "text/html",
              fetchedAt: "2026-07-29T09:00:00.000Z",
              redirectChain: [],
              xRobotsTag: null,
            },
            link: {
              canonicalUrl: "https://publisher.example/article",
              noindex: false,
              occurrenceCount: 1,
              robotsDirectives: [],
              occurrences: [{
                resolvedHref: "https://target.example/landing",
                anchorText: "Target guide",
                rel: ["nofollow"],
                nofollow: true,
                sponsored: false,
                ugc: false,
              }],
            },
          }),
        },
      }),
      reverifyCommand: {
        execute: async (input) => {
          reverifyCalls.push(input);
          return {
            placementId: changedPlacementId,
            placementVersion: 5,
            accepted: true,
            replayed: false,
            browserFallbackAllowed: false,
            monitorRun: {
              monitorRunId:
                "018f0000-0000-7000-8000-000000000106",
              status: "scheduled",
              scheduledFor: "2026-07-29T10:00:00.000Z",
            },
          };
        },
      },
    });
    await app.ready();

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/links/placements/${changedPlacementId}/events?limit=1`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({
      items: [{
        eventType: "placement.recovered",
        previousHealthStatus: "lost",
        nextHealthStatus: "active",
      }],
      nextCursor: "next-events",
      hasMore: true,
    });

    const evidenceId = "018f0000-0000-7000-8000-000000000105";
    const evidence = await app.inject({
      method: "GET",
      url: `/api/v1/projects/project-key/backlinks/links/evidence/${evidenceId}`,
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json()).toMatchObject({
      evidence: {
        evidenceId,
        immutable: true,
        hashVerified: true,
        freshness: "fresh",
      },
    });

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/links/placements/${changedPlacementId}/reverify`,
      payload: { expectedVersion: 4 },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(reverifyCalls).toHaveLength(0);

    const reverify = await app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/links/placements/${changedPlacementId}/reverify`,
      headers: { "idempotency-key": "reverify-158" },
      payload: { expectedVersion: 4 },
    });
    expect(reverify.statusCode).toBe(202);
    expect(reverify.json()).toMatchObject({
      placementId: changedPlacementId,
      placementVersion: 5,
      accepted: true,
      replayed: false,
      browserFallbackAllowed: false,
      monitorRun: { status: "scheduled" },
    });
    expect(reverifyCalls).toEqual([expect.objectContaining({
      requestId: "request-158",
      placementId: changedPlacementId,
      expectedVersion: 4,
      idempotencyKey: "reverify-158",
    })]);

    await app.close();
  });
});
