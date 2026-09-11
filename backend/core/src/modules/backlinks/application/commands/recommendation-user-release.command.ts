import { createHash } from "node:crypto";

import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  RecommendationArchiveResult,
  RecommendationGetMoreResult,
  RecommendationInitialPublicationResult,
  RecommendationUserReleaseRepository,
} from "../../db/repositories/recommendation-user-release.repository.js";
import { evaluateRecommendationUserRelease } from "../services/recommendation-user-release.service.js";

function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role),
    )
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Recommendation publication write permission is required.",
    });
  }
}

function scopeFrom(context: ResolvedProjectContext) {
  return Object.freeze({
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    actorId: context.actor.userId,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type RecommendationUserReleaseStatusResult = Readonly<{
  state: "PUBLISHED" | "NOT_PUBLISHED";
  currentBatchOrdinal: number | null;
  requiredOpportunityCount: number | null;
  successfulOpportunityCount: number;
  unlockAt: Date | null;
  unlockReason: "OPPORTUNITY_RATIO" | "ELAPSED_18H" | "NO_GATE" | null;
  canGetMore: boolean;
  getMoreState:
    | "INITIAL_BATCH_NOT_PUBLISHED"
    | "RELEASE_NEXT"
    | "NOT_UNLOCKED"
    | "NEXT_BATCH_PREPARING"
    | "POOL_EXHAUSTED";
}>;

export function createRecommendationUserReleaseCommands(
  repository: RecommendationUserReleaseRepository,
) {
  return Object.freeze({
    async getStatus(
      input: Readonly<{
        context: ResolvedProjectContext;
      }>,
    ): Promise<RecommendationUserReleaseStatusResult> {
      authorize(input.context);
      const status = await repository.getStatus(scopeFrom(input.context));
      if (status === null) {
        return Object.freeze({
          state: "NOT_PUBLISHED",
          currentBatchOrdinal: null,
          requiredOpportunityCount: null,
          successfulOpportunityCount: 0,
          unlockAt: null,
          unlockReason: null,
          canGetMore: false,
          getMoreState: "INITIAL_BATCH_NOT_PUBLISHED",
        });
      }
      const release = evaluateRecommendationUserRelease(status);
      return Object.freeze({
        state: "PUBLISHED",
        currentBatchOrdinal: status.currentBatchOrdinal,
        ...release,
      });
    },
    publishInitial(
      input: Readonly<{
        context: ResolvedProjectContext;
      }>,
    ): Promise<RecommendationInitialPublicationResult> {
      authorize(input.context);
      return repository.publishInitial(scopeFrom(input.context));
    },
    getMore(
      input: Readonly<{
        context: ResolvedProjectContext;
        idempotencyKey: string;
      }>,
    ): Promise<RecommendationGetMoreResult> {
      authorize(input.context);
      return repository.getMore({
        ...scopeFrom(input.context),
        idempotencyKey: input.idempotencyKey,
        requestHash: digest({ action: "get-more" }),
      });
    },
    setArchived(
      input: Readonly<{
        context: ResolvedProjectContext;
        itemId: string;
        archived: boolean;
        idempotencyKey: string;
      }>,
    ): Promise<RecommendationArchiveResult> {
      authorize(input.context);
      return repository.setArchived({
        ...scopeFrom(input.context),
        itemId: input.itemId,
        archived: input.archived,
        idempotencyKey: input.idempotencyKey,
        requestHash: digest({
          action: input.archived ? "archive" : "unarchive",
          itemId: input.itemId,
        }),
      });
    },
  });
}

export type RecommendationUserReleaseCommands = ReturnType<
  typeof createRecommendationUserReleaseCommands
>;
