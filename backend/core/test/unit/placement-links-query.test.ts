import { describe, expect, it } from "vitest";

import {
  createPlacementLinksQuery,
  placementLifecycleEventTypes,
} from "../../src/modules/backlinks/application/queries/placement-links.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const placementId = "018f0000-0000-7000-8000-000000000158";
const candidateId = "018f0000-0000-7000-8000-000000000159";
const observationId = "018f0000-0000-7000-8000-000000000160";
const monitorRunId = "018f0000-0000-7000-8000-000000000161";
const replyId = "018f0000-0000-7000-8000-000000000166";
const context = {
  actor: createActorContext({
    userId: "user-158",
    sessionId: "session-158",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: "organization-158",
    workspaceId: "workspace-158",
  }),
  project: createProjectContext({
    websiteProjectId: "project-158",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-158",
    promotionTargetVersionId: "target-158",
  }),
};

const placementRow = {
  recordType: "placement",
  displayState: "confirmed",
  id: placementId,
  candidateId,
  placementId,
  opportunityId: "018f0000-0000-7000-8000-000000000162",
  replyId,
  sourcePageUrl: "https://publisher.example/article",
  targetUrl: "https://owner.example/guide",
  candidateStatus: null,
  matchStatus: null,
  validationStatus: "VALID",
  healthStatus: "active",
  monitoringStatus: "enabled",
  latestObservedAt: "2026-07-29T08:00:00.000Z",
  lastSuccessfulObservationAt: "2026-07-28T08:00:00.000Z",
  nextCheckAt: "2026-07-29T09:30:00.000Z",
  latestFailureCode: "PROVIDER_TIMEOUT",
  wasRecovered: true,
  version: 4,
  createdAt: "2026-07-28T09:00:00.000Z",
};

describe("BL-AI-158 Links public query", () => {
  it("builds Recovered from the immutable placement.recovered fact", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = createPlacementLinksQuery({
      query: async (text, parameters) => {
        calls.push({ text, values: parameters });
        if (text.includes("placement_counts AS")) {
          return {
            rows: [{
              placementTotal: 1,
              pendingVerification: 0,
              active: 1,
              suspectedChanged: 0,
              changed: 0,
              suspectedLost: 0,
              lost: 0,
              recovered: 1,
              candidateTotal: 2,
              lastSuccessfulObservationAt:
                "2026-07-28T08:00:00.000Z",
              latestAttemptAt: "2026-07-29T08:15:00.000Z",
              latestAttemptStatus: "FAILED",
              latestFailureCode: "PROVIDER_TIMEOUT",
              nextCheckAt: "2026-07-29T09:30:00.000Z",
            }],
          };
        }
        return { rows: [placementRow] };
      },
    }, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
    });

    await expect(query.listLinks(context, {
      view: "recovered",
      limit: 25,
    })).resolves.toMatchObject({
      items: [{
        placementId,
        displayState: "recovered",
        healthStatus: "active",
        monitoringState: "active",
        freshness: "stale",
        latestFailure: {
          status: "failed",
          code: "PROVIDER_TIMEOUT",
        },
      }],
      summary: {
        placements: {
          total: 1,
          active: 1,
          recovered: 1,
        },
        candidates: {
          total: 2,
          countsTowardKpi: false,
        },
        evidence: {
          source: "DIRECT_MONITOR",
          dataCutoff: "2026-07-28T08:00:00.000Z",
          freshness: "stale",
          latestAttemptStatus: "failed",
          latestFailure: {
            status: "failed",
            code: "PROVIDER_TIMEOUT",
          },
        },
      },
    });
    expect(calls[0]?.text).toContain("FROM backlink_lifecycle_events lifecycle");
    expect(calls[0]?.text).toContain("'placement',p.id,'placement.recovered'");
    expect(calls[0]?.text).toContain("$4='recovered'");
    expect(calls[0]?.values?.slice(0, 4)).toEqual([
      "organization-158",
      "workspace-158",
      "project-158",
      "recovered",
    ]);
    expect(calls[1]?.values).toEqual([
      "organization-158",
      "workspace-158",
      "project-158",
    ]);
    expect(calls[1]?.text).toContain(
      "candidate.status NOT IN ('PROMOTED','REJECTED')",
    );
  });

  it("returns server freshness, safe failure, and latest Monitor Run status", async () => {
    const query = createPlacementLinksQuery({
      query: async () => ({
        rows: [{
          placementId,
          candidateId,
          opportunityId: "018f0000-0000-7000-8000-000000000162",
          replyId,
          sourcePageUrl: placementRow.sourcePageUrl,
          normalizedSourceUrl: placementRow.sourcePageUrl,
          targetUrl: placementRow.targetUrl,
          normalizedTargetUrl: placementRow.targetUrl,
          urlNormalizationVersion: "placement-url-key.v1",
          initialValidationId:
            "018f0000-0000-7000-8000-000000000163",
          validationStatus: "VALID",
          initialEvidenceSnapshotHash: "a".repeat(64),
          evidenceContractVersion: "placement.initial-validation.v1",
          initialEvidenceSchemaVersion: 1,
          healthStatus: "active",
          monitoringStatus: "enabled",
          version: 4,
          createdAt: "2026-07-28T09:00:00.000Z",
          updatedAt: "2026-07-29T09:00:00.000Z",
          latestObservationId: observationId,
          latestObservationResult: "inaccessible",
          latestObservedAt: "2026-07-29T08:00:00.000Z",
          latestExecutionMode: "static",
          latestEvidenceHash: "b".repeat(64),
          latestEvidenceContractVersion: "placement.monitor-observation.v1",
          latestEvidenceSchemaVersion: 1,
          latestFailureCode: "unsafe/path/provider-token",
          lastSuccessfulObservationId:
            "018f0000-0000-7000-8000-000000000167",
          lastSuccessfulObservationResult: "present",
          lastSuccessfulObservedAt: "2026-07-28T08:00:00.000Z",
          lastSuccessfulExecutionMode: "static",
          lastSuccessfulEvidenceHash: "c".repeat(64),
          lastSuccessfulEvidenceContractVersion:
            "placement.monitor-observation.v1",
          lastSuccessfulEvidenceSchemaVersion: 1,
          nextCheckAt: "2026-07-29T09:30:00.000Z",
          consecutiveAnomalies: 1,
          browserFallbackEnabled: true,
          latestMonitorRunId: monitorRunId,
          latestMonitorRunStatus: "RETRY_WAIT",
          latestMonitorRunScheduledFor: "2026-07-29T08:00:00.000Z",
          latestMonitorRunUpdatedAt: "2026-07-29T09:00:00.000Z",
        }],
      }),
    }, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
    });

    await expect(query.getPlacementLink(context, placementId)).resolves
      .toMatchObject({
        latestObservation: {
          observationId,
          result: "inaccessible",
          executionMode: "static",
          evidence: {
            evidenceId: observationId,
            freshness: "stale",
          },
          failure: {
            status: "failed",
            code: "MONITORING_FAILED",
          },
        },
        latestMonitorRun: {
          monitorRunId,
          status: "retry_wait",
        },
        lastSuccessfulObservation: {
          observationId: "018f0000-0000-7000-8000-000000000167",
          result: "present",
          failure: {
            status: "none",
            code: null,
          },
        },
        monitoringState: "active",
        lastSuccessfulObservationAt: "2026-07-28T08:00:00.000Z",
        replyId,
        lineageStatus: "OUTREACH_DERIVED",
      });
  });

  it("paginates only the public Placement lifecycle event registry", async () => {
    let call = 0;
    let eventValues: readonly unknown[] | undefined;
    const query = createPlacementLinksQuery({
      query: async (_text, values) => {
        call += 1;
        if (call === 1) return { rows: [{ exists: 1 }] };
        eventValues = values;
        return {
          rows: [
            {
              eventId: "018f0000-0000-7000-8000-000000000164",
              eventType: "placement.recovered",
              occurredAt: "2026-07-29T09:00:00.000Z",
              placementVersion: 4,
              previousHealthStatus: "lost",
              nextHealthStatus: "active",
              observationId,
              reason: "PLACEMENT_RECOVERED",
            },
            {
              eventId: "018f0000-0000-7000-8000-000000000165",
              eventType: "placement.lost",
              occurredAt: "2026-07-28T09:00:00.000Z",
              placementVersion: 3,
              previousHealthStatus: "active",
              nextHealthStatus: "lost",
              observationId: null,
              reason: "PLACEMENT_ABSENT_CONFIRMED",
            },
          ],
        };
      },
    });

    const page = await query.listPlacementEvents(context, placementId, {
      limit: 1,
    });

    expect(page).toMatchObject({
      items: [{
        eventType: "placement.recovered",
        previousHealthStatus: "lost",
        nextHealthStatus: "active",
      }],
      hasMore: true,
    });
    expect(page?.nextCursor).toEqual(expect.any(String));
    expect(eventValues?.[4]).toEqual(placementLifecycleEventTypes);
    expect(eventValues?.slice(0, 4)).toEqual([
      "organization-158",
      "workspace-158",
      "project-158",
      placementId,
    ]);
  });
});
