import { createHash } from "node:crypto";

import type {
  RecommendationSeedPreparationV2Result,
  RecommendationSeedSnapshot,
  RecommendationSystemSeedCandidate,
  RecommendationUserSeedInput,
} from "../services/recommendation-seed-preparation.service.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type RecommendationSeedTrigger = "USER_TRIGGERED" | "PRE_TASK_FALLBACK";

type RecommendationSeedScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;

export type RecommendationSeedPersisted = Omit<
  RecommendationSeedPreparationV2Result,
  "seeds" | "blueprintSeedReferences"
> &
  Readonly<{
    replayed: boolean;
    confirmation: Readonly<{
      generationContractId: string;
      seedSnapshotFingerprint: string;
    }> | null;
    snapshot: RecommendationSeedSnapshot;
    seeds: readonly (RecommendationSeedPreparationV2Result["seeds"][number] &
      Readonly<{ id: string }>)[];
    blueprintSeedReferences: readonly Readonly<{
      id: string;
      blueprintId: string;
      seedId: string;
      seedFingerprint: string;
      seedOrdinal: number;
    }>[];
  }>;

export type RecommendationSeedCommandRepository = Readonly<{
  prepare(
    input: RecommendationSeedScope &
      Readonly<{
        trigger: RecommendationSeedTrigger;
        idempotencyKey: string;
        requestHash: string;
        requestId: string;
        targetGenerationContractId?: string;
        userSeeds: readonly RecommendationUserSeedInput[];
        systemCandidates: readonly RecommendationSystemSeedCandidate[];
      }>,
  ): Promise<RecommendationSeedPersisted>;
  validate(
    input: RecommendationSeedScope &
      Readonly<{
        userSeeds: readonly RecommendationUserSeedInput[];
        systemCandidates: readonly RecommendationSystemSeedCandidate[];
      }>,
  ): Promise<RecommendationSeedPreparationV2Result>;
}>;

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function assertRecommendationSeedWriteAuthorized(
  context: ResolvedProjectContext,
): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role),
    )
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Recommendation seed write permission is required.",
    });
  }
}

function scopeFrom(context: ResolvedProjectContext): RecommendationSeedScope {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    actorId: context.actor.userId,
  };
}

function commandRequestHash(
  input: Readonly<{
    trigger: RecommendationSeedTrigger;
    targetGenerationContractId?: string;
    userSeeds: readonly RecommendationUserSeedInput[];
    systemCandidates: readonly RecommendationSystemSeedCandidate[];
  }>,
): string {
  return digest({
    contract: "recommendation-seed.v2",
    trigger: input.trigger,
    targetGenerationContractId: input.targetGenerationContractId ?? null,
    userSeeds: input.userSeeds,
    systemCandidates: input.systemCandidates,
  });
}

export function createRecommendationSeedCommands(
  repository: RecommendationSeedCommandRepository,
) {
  const prepare = async (
    trigger: RecommendationSeedTrigger,
    input: Readonly<{
      context: ResolvedProjectContext;
      idempotencyKey: string;
      requestId: string;
      targetGenerationContractId?: string;
      userSeeds: readonly RecommendationUserSeedInput[];
      systemCandidates: readonly RecommendationSystemSeedCandidate[];
    }>,
  ) => {
    assertRecommendationSeedWriteAuthorized(input.context);
    return await repository.prepare({
      ...scopeFrom(input.context),
      trigger,
      ...(input.targetGenerationContractId === undefined
        ? {}
        : {
            targetGenerationContractId: input.targetGenerationContractId,
          }),
      idempotencyKey: input.idempotencyKey,
      requestHash: commandRequestHash({
        trigger,
        ...(input.targetGenerationContractId === undefined
          ? {}
          : {
              targetGenerationContractId: input.targetGenerationContractId,
            }),
        userSeeds: input.userSeeds,
        systemCandidates: input.systemCandidates,
      }),
      requestId: input.requestId,
      userSeeds: input.userSeeds,
      systemCandidates: input.systemCandidates,
    });
  };

  return Object.freeze({
    generate(
      input: Readonly<{
        context: ResolvedProjectContext;
        idempotencyKey: string;
        requestId: string;
        userSeeds: readonly RecommendationUserSeedInput[];
        systemCandidates: readonly RecommendationSystemSeedCandidate[];
      }>,
    ) {
      return prepare("USER_TRIGGERED", input);
    },
    prepareBeforeTask(
      input: Readonly<{
        context: ResolvedProjectContext;
        idempotencyKey: string;
        requestId: string;
        userSeeds: readonly RecommendationUserSeedInput[];
        systemCandidates: readonly RecommendationSystemSeedCandidate[];
      }>,
    ) {
      return prepare("PRE_TASK_FALLBACK", input);
    },
    prepareForGeneration(
      input: Readonly<{
        context: ResolvedProjectContext;
        idempotencyKey: string;
        requestId: string;
        targetGenerationContractId: string;
        userSeeds: readonly RecommendationUserSeedInput[];
        systemCandidates: readonly RecommendationSystemSeedCandidate[];
      }>,
    ) {
      return prepare("PRE_TASK_FALLBACK", input);
    },
    validate(
      input: Readonly<{
        context: ResolvedProjectContext;
        userSeeds: readonly RecommendationUserSeedInput[];
        systemCandidates: readonly RecommendationSystemSeedCandidate[];
      }>,
    ) {
      assertRecommendationSeedWriteAuthorized(input.context);
      return repository.validate({
        ...scopeFrom(input.context),
        userSeeds: input.userSeeds,
        systemCandidates: input.systemCandidates,
      });
    },
  });
}

export type RecommendationSeedCommands = ReturnType<
  typeof createRecommendationSeedCommands
>;
