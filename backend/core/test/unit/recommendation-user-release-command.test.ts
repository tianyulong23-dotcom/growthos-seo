import { describe, expect, it, vi } from "vitest";

import { createRecommendationUserReleaseCommands } from "../../src/modules/backlinks/application/commands/recommendation-user-release.command.js";
import type { RecommendationUserReleaseRepository } from "../../src/modules/backlinks/db/repositories/recommendation-user-release.repository.js";
import type { ResolvedProjectContext } from "../../src/modules/backlinks/ports/project-context.port.js";

const context = Object.freeze({
  tenant: {
    organizationId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
  },
  project: {
    websiteProjectId: "00000000-0000-4000-8000-000000000003",
  },
  actor: {
    userId: "actor-a",
    roles: ["member"],
  },
}) as ResolvedProjectContext;

function repository(): RecommendationUserReleaseRepository {
  return {
    getStatus: vi.fn().mockResolvedValue({
      currentBatchOrdinal: 1,
      originalBatchSize: 25,
      successfulOpportunityCount: 7,
      firstVisibleAt: new Date("2026-08-30T00:00:00.000Z"),
      databaseNow: new Date("2026-08-30T01:00:00.000Z"),
      previouslyUnlockedAt: null,
      previouslyUnlockReason: null,
      nextBatchState: "AVAILABLE",
    }),
    publishInitial: vi.fn().mockResolvedValue({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: false,
    }),
    getMore: vi.fn().mockResolvedValue({
      state: "RELEASED",
      currentBatchOrdinal: 1,
      releasedBatchOrdinal: 2,
      replayed: false,
    }),
    setArchived: vi.fn().mockResolvedValue({
      itemId: "00000000-0000-4000-8000-000000000004",
      archived: true,
      replayed: false,
    }),
  };
}

describe("recommendation user release commands", () => {
  it("maps the authorized actor scope without exposing Phase 6 feed reads", async () => {
    const target = repository();
    const commands = createRecommendationUserReleaseCommands(target);

    await expect(commands.getStatus({ context })).resolves.toEqual({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      requiredOpportunityCount: 0,
      successfulOpportunityCount: 7,
      unlockAt: new Date("2026-08-30T00:00:00.000Z"),
      unlockReason: "NO_GATE",
      canGetMore: true,
      getMoreState: "RELEASE_NEXT",
    });
    await expect(commands.publishInitial({ context })).resolves.toMatchObject({
      state: "PUBLISHED",
    });
    await expect(
      commands.getMore({
        context,
        idempotencyKey: "get-more-1",
      }),
    ).resolves.toMatchObject({
      state: "RELEASED",
    });
    await expect(
      commands.setArchived({
        context,
        itemId: "00000000-0000-4000-8000-000000000004",
        archived: true,
        idempotencyKey: "archive-1",
      }),
    ).resolves.toMatchObject({
      archived: true,
    });

    expect(target.getMore).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        actorId: context.actor.userId,
        idempotencyKey: "get-more-1",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(target.getStatus).toHaveBeenCalledWith({
      organizationId: context.tenant.organizationId,
      workspaceId: context.tenant.workspaceId,
      websiteProjectId: context.project.websiteProjectId,
      actorId: context.actor.userId,
    });
    expect(target.setArchived).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "00000000-0000-4000-8000-000000000004",
        archived: true,
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("rejects read-only roles before repository access", async () => {
    const target = repository();
    const commands = createRecommendationUserReleaseCommands(target);
    const viewerContext = {
      ...context,
      actor: {
        ...context.actor,
        roles: ["viewer"],
      },
    } as ResolvedProjectContext;

    expect(() =>
      commands.getMore({
        context: viewerContext,
        idempotencyKey: "denied",
      }),
    ).toThrow("write permission is required");
    expect(target.getMore).not.toHaveBeenCalled();
  });

  it("reports an unpublished actor without inventing unlock facts", async () => {
    const target = repository();
    vi.mocked(target.getStatus).mockResolvedValueOnce(null);
    const commands = createRecommendationUserReleaseCommands(target);

    await expect(commands.getStatus({ context })).resolves.toEqual({
      state: "NOT_PUBLISHED",
      currentBatchOrdinal: null,
      requiredOpportunityCount: null,
      successfulOpportunityCount: 0,
      unlockAt: null,
      unlockReason: null,
      canGetMore: false,
      getMoreState: "INITIAL_BATCH_NOT_PUBLISHED",
    });
  });
});
