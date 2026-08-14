import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createPlacementReverifyCommand,
} from "../../src/modules/backlinks/application/commands/placement-reverify.command.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import type { BacklinkError } from "../../src/modules/backlinks/domain/errors/backlink-error.js";
import {
  BACKLINK_PLACEMENT_MONITORING_REQUESTED,
} from "../../src/modules/backlinks/workflows/outbox-relay.js";

const placementId = "018f0000-0000-7000-8000-000000000158";
const monitorRunId = "018f0000-0000-7000-8000-000000000159";
const requestedAt = new Date("2026-07-29T10:00:00.000Z");

function context(
  websiteProjectId = "project-158",
  roles: readonly string[] = ["member"],
) {
  return {
    actor: createActorContext({
      userId: "user-158",
      sessionId: "session-158",
      roles,
    }),
    tenant: createTenantContext({
      organizationId: "organization-158",
      workspaceId: "workspace-158",
    }),
    project: createProjectContext({
      websiteProjectId,
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-158",
      promotionTargetVersionId: "target-158",
    }),
  };
}

const input = {
  context: context(),
  placementId,
  expectedVersion: 4,
  idempotencyKey: "placement-reverify-158",
  requestId: "request-158",
};

function requestHash(
  websiteProjectId = "project-158",
): string {
  return createHash("sha256").update(JSON.stringify({
    organizationId: "organization-158",
    workspaceId: "workspace-158",
    websiteProjectId,
    placementId,
    expectedVersion: 4,
  }), "utf8").digest("hex");
}

describe("BL-AI-158 Placement reverify command", () => {
  it("schedules the existing static monitoring boundary and returns 202 state", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        state: "completed",
        requestHash: requestHash(),
        responseBody: {
          placementId,
          placementVersion: 5,
          accepted: true,
          browserFallbackAllowed: false,
          monitorRun: {
            monitorRunId,
            status: "scheduled",
            scheduledFor: "2026-07-29T10:00:00.000+00:00",
          },
        },
      }],
    }));
    const ids = [
      "018f0000-0000-7000-8000-000000000160",
      monitorRunId,
      "018f0000-0000-7000-8000-000000000161",
      "018f0000-0000-7000-8000-000000000162",
    ];
    const command = createPlacementReverifyCommand(
      { query },
      {
        newId: () => ids.shift() ?? "unexpected-id",
        now: () => requestedAt,
      },
    );

    await expect(command.execute(input)).resolves.toEqual({
      placementId,
      placementVersion: 5,
      accepted: true,
      replayed: false,
      browserFallbackAllowed: false,
      monitorRun: {
        monitorRunId,
        status: "scheduled",
        scheduledFor: requestedAt.toISOString(),
      },
    });
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(sql).toContain("backlink_monitor_runs");
    expect(sql).toContain("backlink_outbox_events");
    expect(sql).toContain("'requestKind','reverify'");
    expect(sql).toContain("'executionMode','static'");
    expect(sql).toContain(
      "'browserFallbackAllowed',target.\"browserFallbackAllowed\"",
    );
    expect(values).toEqual([
      "organization-158",
      "workspace-158",
      "project-158",
      "user-158",
      placementId,
      4,
      "placement-reverify-158",
      requestHash(),
      "018f0000-0000-7000-8000-000000000160",
      monitorRunId,
      "018f0000-0000-7000-8000-000000000161",
      "018f0000-0000-7000-8000-000000000162",
      "request-158",
      requestedAt,
      BACKLINK_PLACEMENT_MONITORING_REQUESTED,
    ]);
  });

  it("returns the stable active Monitor Run without creating a duplicate", async () => {
    const command = createPlacementReverifyCommand({
      query: async () => ({
        rows: [{
          state: "completed",
          requestHash: requestHash(),
          responseBody: {
            placementId,
            placementVersion: 4,
            accepted: false,
            browserFallbackAllowed: false,
            monitorRun: {
              monitorRunId,
              status: "running",
              scheduledFor: requestedAt.toISOString(),
            },
          },
        }],
      }),
    });

    await expect(command.execute(input)).resolves.toMatchObject({
      accepted: false,
      replayed: false,
      placementVersion: 4,
      monitorRun: { monitorRunId, status: "running" },
    });
  });

  it("binds idempotency to project scope and rejects conflicting replays", async () => {
    const hashes: string[] = [];
    const command = createPlacementReverifyCommand({
      query: async (_text, values) => {
        hashes.push(String(values?.[7]));
        return {
          rows: [{
            state: "replay",
            requestHash: "different-request",
            responseBody: {},
          }],
        };
      },
    });

    await expect(command.execute(input)).rejects.toMatchObject<
      Partial<BacklinkError>
    >({ code: "BACKLINK_CONFLICT" });
    await expect(command.execute({
      ...input,
      context: context("project-159"),
    })).rejects.toMatchObject<Partial<BacklinkError>>({
      code: "BACKLINK_CONFLICT",
    });
    expect(hashes).toEqual([
      requestHash(),
      requestHash("project-159"),
    ]);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("rejects viewers before any persistence call", async () => {
    const query = vi.fn();
    const command = createPlacementReverifyCommand({ query });

    await expect(command.execute({
      ...input,
      context: context("project-158", ["viewer"]),
    })).rejects.toMatchObject<Partial<BacklinkError>>({
      code: "BACKLINK_ACCESS_DENIED",
    });
    expect(query).not.toHaveBeenCalled();
  });
});
