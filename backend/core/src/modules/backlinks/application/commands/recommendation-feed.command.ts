import { createHash } from "node:crypto";

import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type RecommendationGetMoreResult = Readonly<{
  state:
    | "RELEASED"
    | "NOT_UNLOCKED"
    | "NEXT_BATCH_PREPARING"
    | "POOL_EXHAUSTED";
  currentBatchOrdinal: number;
  releasedBatchOrdinal: number | null;
  replayed: boolean;
}>;

export type RecommendationArchiveResult = Readonly<{
  itemId: string;
  archived: boolean;
  replayed: boolean;
}>;

export type RecommendationSeedInput = Readonly<{
  kind: "KEYWORD" | "COMPETITOR_DOMAIN" | "CATEGORY";
  value: string;
  source: "USER" | "PROJECT_FACT" | "SYSTEM_FALLBACK";
}>;

export type RecommendationSeedResult = Readonly<{
  seeds: readonly Readonly<{
    id: string;
    kind: RecommendationSeedInput["kind"];
    value: string;
    source: RecommendationSeedInput["source"];
    validationStatus: "VALID" | "INVALID";
    validationReason: string | null;
  }>[];
}>;

type RecommendationCommandScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;

type IdempotentCommand = Readonly<{
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
}>;

export type RecommendationFeedCommandRepository = Readonly<{
  getMore(
    input: RecommendationCommandScope & IdempotentCommand,
  ): Promise<RecommendationGetMoreResult>;
  setArchived(
    input: RecommendationCommandScope &
      IdempotentCommand &
      Readonly<{ itemId: string; archived: boolean }>,
  ): Promise<RecommendationArchiveResult>;
  generateSeeds(
    input: RecommendationCommandScope &
      IdempotentCommand &
      Readonly<{ seeds: readonly RecommendationSeedInput[] }>,
  ): Promise<RecommendationSeedResult>;
  validateSeeds(
    input: RecommendationCommandScope &
      Readonly<{ seeds: readonly RecommendationSeedInput[] }>,
  ): Promise<RecommendationSeedResult>;
}>;

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role),
    )
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Recommendation feed write permission is required.",
    });
  }
}

function scopeFrom(
  context: ResolvedProjectContext,
): RecommendationCommandScope {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    actorId: context.actor.userId,
  };
}

export function createRecommendationFeedCommands(
  repository: RecommendationFeedCommandRepository,
) {
  return Object.freeze({
    getMore(
      input: Readonly<{
        context: ResolvedProjectContext;
        idempotencyKey: string;
        requestId: string;
      }>,
    ): Promise<RecommendationGetMoreResult> {
      authorize(input.context);
      return repository.getMore({
        ...scopeFrom(input.context),
        idempotencyKey: input.idempotencyKey,
        requestHash: digest({ action: "get-more" }),
        requestId: input.requestId,
      });
    },
    setArchived(
      input: Readonly<{
        context: ResolvedProjectContext;
        itemId: string;
        archived: boolean;
        idempotencyKey: string;
        requestId: string;
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
        requestId: input.requestId,
      });
    },
    generateSeeds(
      input: Readonly<{
        context: ResolvedProjectContext;
        seeds: readonly RecommendationSeedInput[];
        idempotencyKey: string;
        requestId: string;
      }>,
    ): Promise<RecommendationSeedResult> {
      authorize(input.context);
      return repository.generateSeeds({
        ...scopeFrom(input.context),
        seeds: input.seeds,
        idempotencyKey: input.idempotencyKey,
        requestHash: digest({ action: "generate-seeds", seeds: input.seeds }),
        requestId: input.requestId,
      });
    },
    validateSeeds(
      input: Readonly<{
        context: ResolvedProjectContext;
        seeds: readonly RecommendationSeedInput[];
      }>,
    ): Promise<RecommendationSeedResult> {
      authorize(input.context);
      return repository.validateSeeds({
        ...scopeFrom(input.context),
        seeds: input.seeds,
      });
    },
  });
}

export type RecommendationFeedCommands = ReturnType<
  typeof createRecommendationFeedCommands
>;
