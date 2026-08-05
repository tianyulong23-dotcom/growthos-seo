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
  sourcePageUrl: "https://publisher.example/article",
  targetUrl: "https://owner.example/guide",
  candidateStatus: null,
  matchStatus: null,
  validationStatus: "VALID",
  healthStatus: "active",
  monitoringStatus: "enabled",
  wasRecovered: true,
  version: 4,
  createdAt: "2026-07-28T09:00:00.000Z",
};

describe("BL-AI-158 Links public query", () => {
  it("builds Recovered from the immutable placement.recovered fact", async () => {
    let sql = "";
    let values: readonly unknown[] | undefined;
    const query = createPlacementLinksQuery({
      query: async (text, parameters) => {
        sql = text;
        values = parameters;
        return { rows: [placementRow] };
      },
    });

    await expect(query.listLinks(context, {
      view: "recovered",
      limit: 25,
    })).resolves.toMatchObject({
      items: [{
        placementId,
        displayState: "recovered",
        healthStatus: "active",
      }],
    });
    expect(sql).toContain("FROM backlink_lifecycle_events lifecycle");
    expect(sql).toContain("'placement',p.id,'placement.recovered'");
    expect(sql).toContain("$4='recovered'");
    expect(values?.slice(0, 4)).toEqual([
      "organization-158",
      "workspace-158",
      "project-158",
      "recovered",
    ]);
  });

  it("returns server freshness, safe failure, and latest Monitor Run status", async () => {
    const query = createPlacementLinksQuery({
      query: async () => ({
        rows: [{
          placementId,
          candidateId,
          opportunityId: "018f0000-0000-7000-8000-000000000162",
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
          nextCheckAt: "2026-07-29T09:30:00.000Z",
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
