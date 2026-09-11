import { describe, expect, it, vi } from "vitest";

import {
  createOpportunityCommands,
  type RecommendationFeedOpportunityCreation,
  type RecommendationFeedOpportunityRepository,
} from "../../src/modules/backlinks/application/commands/opportunities.command.js";
import type { OpportunityRepository } from "../../src/modules/backlinks/db/repositories/opportunity.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const recommendationFeedItemId = "018f0000-0000-7000-8000-000000000101";
const recommendationId = "018f0000-0000-7000-8000-000000000102";
const opportunityId = "018f0000-0000-7000-8000-000000000103";
const cycleId = "018f0000-0000-7000-8000-000000000104";

function context(
  input: Readonly<{
    organizationId?: string;
    workspaceId?: string;
    websiteProjectId?: string;
    userId?: string;
  }> = {},
) {
  return {
    actor: createActorContext({
      userId: input.userId ?? "user-1",
      sessionId: "session-1",
      roles: ["member"],
    }),
    tenant: createTenantContext({
      organizationId: input.organizationId ?? "organization-1",
      workspaceId: input.workspaceId ?? "workspace-1",
    }),
    project: createProjectContext({
      websiteProjectId: input.websiteProjectId ?? "project-1",
      canonicalDomain: "owner.test",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "target-v1",
    }),
  };
}

function creation(
  overrides: Partial<RecommendationFeedOpportunityCreation> = {},
): RecommendationFeedOpportunityCreation {
  return {
    opportunityId,
    recommendationId,
    recommendationFeedItemId,
    cycleId,
    websiteProjectId: "project-1",
    targetSiteKey: "publisher.test",
    targetHostAscii: "www.publisher.test",
    contactCandidateId: "018f0000-0000-7000-8000-000000000105",
    contactReviewRequired: false,
    joinSequence: 1,
    businessStage: "JOINED",
    managementStatus: "ACTIVE",
    outcomeStatus: "OPEN",
    fulfillmentStatus: "NOT_EXPECTED",
    version: 1,
    lifecycleEventId: "life-v2",
    auditEventId: "audit-v2",
    existingOpportunity: false,
    teamAdded: true,
    createdByCurrentUser: true,
    ...overrides,
  };
}

function repository(
  createFromRecommendationFeedItem: RecommendationFeedOpportunityRepository["createFromRecommendationFeedItem"],
) {
  return {
    createFromRecommendation:
      vi.fn<OpportunityRepository["createFromRecommendation"]>(),
    createFromRecommendationFeedItem: vi.fn(createFromRecommendationFeedItem),
    transitionBusinessStage:
      vi.fn<OpportunityRepository["transitionBusinessStage"]>(),
    patchManagement: vi.fn<OpportunityRepository["patchManagement"]>(),
  };
}

describe("Recommendation Pool V2 Opportunity command bridge", () => {
  it("delegates V2 creation as one actor-scoped repository transaction", async () => {
    const store = repository(async (input) => ({
      state: "completed",
      requestHash: input.requestHash,
      responseBody: creation(),
    }));
    const commands = createOpportunityCommands(store);

    await expect(
      commands.createFromRecommendation({
        context: context(),
        recommendationFeedItemId,
        idempotencyKey: "v2-create-1",
        requestId: "request-v2-create-1",
      }),
    ).resolves.toMatchObject({
      recommendationFeedItemId,
      opportunityId,
      existingOpportunity: false,
      teamAdded: true,
      createdByCurrentUser: true,
      replayed: false,
    });

    expect(store.createFromRecommendation).not.toHaveBeenCalled();
    expect(store.createFromRecommendationFeedItem).toHaveBeenCalledTimes(1);
    expect(store.createFromRecommendationFeedItem).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "organization-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        actorId: "user-1",
        recommendationFeedItemId,
        idempotencyKey: "v2-create-1",
        requestId: "request-v2-create-1",
        opportunityCreatedActionId: expect.any(String),
      }),
    );
  });

  it("returns an existing team Opportunity without a second action write", async () => {
    let opportunityActionCount = 0;
    const store = repository(async (input) => {
      if (input.actorId === "user-1") {
        opportunityActionCount += 1;
        return {
          state: "completed",
          requestHash: input.requestHash,
          responseBody: creation(),
        };
      }
      return {
        state: "existing",
        requestHash: input.requestHash,
        responseBody: creation({
          existingOpportunity: true,
          createdByCurrentUser: false,
        }),
      };
    });
    const commands = createOpportunityCommands(store);

    await commands.createFromRecommendation({
      context: context({ userId: "user-1" }),
      recommendationFeedItemId,
      idempotencyKey: "v2-create-owner",
      requestId: "request-v2-create-owner",
    });
    const duplicate = await commands.createFromRecommendation({
      context: context({ userId: "user-2" }),
      recommendationFeedItemId,
      idempotencyKey: "v2-create-team-duplicate",
      requestId: "request-v2-create-team-duplicate",
    });

    expect(duplicate).toMatchObject({
      opportunityId,
      existingOpportunity: true,
      teamAdded: true,
      createdByCurrentUser: false,
      replayed: false,
    });
    expect(opportunityActionCount).toBe(1);
    expect(store.createFromRecommendationFeedItem).toHaveBeenCalledTimes(2);
  });

  it("preserves contact_review_required without fabricating an email contact", async () => {
    const store = repository(async (input) => ({
      state: "completed",
      requestHash: input.requestHash,
      responseBody: creation({
        contactCandidateId: null,
        contactReviewRequired: true,
      }),
    }));
    const commands = createOpportunityCommands(store);

    await expect(
      commands.createFromRecommendation({
        context: context(),
        recommendationFeedItemId,
        idempotencyKey: "v2-create-no-email",
        requestId: "request-v2-create-no-email",
      }),
    ).resolves.toMatchObject({
      contactCandidateId: null,
      contactReviewRequired: true,
      createdByCurrentUser: true,
    });
    expect(
      store.createFromRecommendationFeedItem.mock.calls[0]?.[0],
    ).not.toHaveProperty("contactCandidateId");
  });

  it.each([
    [
      {
        organizationId: "foreign-organization",
      },
      "tenant",
    ],
    [
      {
        workspaceId: "foreign-workspace",
      },
      "workspace",
    ],
    [
      {
        websiteProjectId: "foreign-project",
      },
      "project",
    ],
    [
      {
        userId: "foreign-user",
      },
      "user publication",
    ],
  ] as const)(
    "maps %s isolation misses to not found",
    async (scope, _label) => {
      const store = repository(async (input) => ({
        state: "not_found",
        requestHash: input.requestHash,
      }));
      const commands = createOpportunityCommands(store);

      await expect(
        commands.createFromRecommendation({
          context: context(scope),
          recommendationFeedItemId,
          idempotencyKey: `v2-isolation-${_label}`,
          requestId: `request-v2-isolation-${_label}`,
        }),
      ).rejects.toMatchObject({ code: "BACKLINK_NOT_FOUND" });
      expect(store.createFromRecommendationFeedItem).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: scope.organizationId ?? "organization-1",
          workspaceId: scope.workspaceId ?? "workspace-1",
          websiteProjectId: scope.websiteProjectId ?? "project-1",
          actorId: scope.userId ?? "user-1",
        }),
      );
    },
  );
});
