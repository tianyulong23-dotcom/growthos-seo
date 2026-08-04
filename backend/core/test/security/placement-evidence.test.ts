import { describe, expect, it } from "vitest";

import {
  hashPlacementEvidence,
} from "../../src/modules/backlinks/application/activities/placement-static-monitor.activity.js";
import {
  createPlacementLinksQuery,
} from "../../src/modules/backlinks/application/queries/placement-links.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import type { BacklinkError } from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const evidenceId = "018f0000-0000-7000-8000-000000000166";
const placementId = "018f0000-0000-7000-8000-000000000158";
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
const snapshot = {
  contractVersion: "placement.monitor-observation.v1",
  schemaVersion: 1,
  providerPayload: { authorization: "Bearer secret" },
  databaseObjectKey: "private/bucket/object.json",
  fetch: {
    requestedUrl: "https://publisher.example/private-request",
    finalUrl: "https://publisher.example/article",
    status: 200,
    contentType: "text/html",
    redirectChain: ["https://internal.example/redirect"],
    resolvedIps: ["203.0.113.8"],
    fetchedAt: "2026-07-29T09:00:00.000Z",
  },
  page: {
    canonicalUrl: "https://publisher.example/article",
    noindex: false,
    occurrences: [{ href: "https://owner.example/guide" }],
  },
  result: {
    status: "present",
    reasonCode: "TARGET_LINK_FOUND",
    retryable: false,
  },
};

function row(hash = hashPlacementEvidence(snapshot)) {
  return {
    evidenceId,
    placementId,
    result: "present",
    failureCode: null,
    evidenceSnapshot: snapshot,
    evidenceHash: hash,
    evidenceContractVersion: "placement.monitor-observation.v1",
    evidenceSchemaVersion: 1,
    observedAt: "2026-07-29T09:00:00.000Z",
    executionMode: "static",
    sourcePageUrl: "https://publisher.example/article",
    targetUrl: "https://owner.example/guide",
    nextCheckAt: "2026-07-30T09:00:00.000Z",
  };
}

describe("BL-AI-158 immutable public evidence", () => {
  it("verifies the immutable Hash and returns only the project-safe DTO", async () => {
    let values: readonly unknown[] | undefined;
    const query = createPlacementLinksQuery({
      query: async (_text, parameters) => {
        values = parameters;
        return { rows: [row()] };
      },
    }, {
      now: () => new Date("2026-07-29T10:00:00.000Z"),
    });

    const evidence = await query.getPlacementEvidence(context, evidenceId);
    expect(evidence).toEqual({
      evidenceId,
      placementId,
      kind: "placement_observation",
      immutable: true,
      hashVerified: true,
      hash: hashPlacementEvidence(snapshot),
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
        targetUrl: "https://owner.example/guide",
        fetchMode: "static",
        httpStatus: 200,
        finalUrl: "https://publisher.example/article",
        contentType: "text/html",
        fetchedAt: "2026-07-29T09:00:00.000Z",
      },
      link: {
        canonicalUrl: "https://publisher.example/article",
        noindex: false,
        occurrenceCount: 1,
      },
    });
    expect(values).toEqual([
      "organization-158",
      "workspace-158",
      "project-158",
      evidenceId,
    ]);
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "providerPayload",
      "authorization",
      "databaseObjectKey",
      "requestedUrl",
      "redirectChain",
      "resolvedIps",
      "Bearer secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed when persisted evidence no longer matches its Hash", async () => {
    const query = createPlacementLinksQuery({
      query: async () => ({ rows: [row("0".repeat(64))] }),
    });

    await expect(query.getPlacementEvidence(context, evidenceId))
      .rejects.toMatchObject<Partial<BacklinkError>>({
        code: "BACKLINK_INTERNAL_ERROR",
        message: "Placement evidence integrity verification failed.",
      });
  });
});
