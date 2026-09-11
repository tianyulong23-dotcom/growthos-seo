import { createHash } from "node:crypto";

import {
  assertRecommendationSeedWriteAuthorized,
  type RecommendationSeedCommands,
} from "../commands/recommendation-seeds.command.js";
import { bindProviderOperationBudgetAuthorization } from "../../domain/recommendations/provider-operation-budget.js";
import { recommendationPoolV2OperationalPolicy } from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import type { RecommendationPoolV2GenerationLaunchRepository } from "../../db/repositories/recommendation-pool-v2-generation-launch.repository.js";
import type { RecommendationPoolV2TimingRecorder } from "../../db/repositories/recommendation-pool-v2-timing.repository.js";
import type { RecommendationPoolV2WorkflowLaunchInput } from "../../workflows/recommendation-pool-v2.starter.js";

type Starter = Readonly<{
  start(input: RecommendationPoolV2WorkflowLaunchInput): Promise<
    Readonly<{
      workflowId: string;
      status: "started" | "already_started";
    }>
  >;
}>;

export type RecommendationPoolV2GenerationLifecycleCommands =
  RecommendationSeedCommands &
    Readonly<{
      launch(
        input: Readonly<{
          context: Parameters<
            RecommendationSeedCommands["generate"]
          >[0]["context"];
          idempotencyKey: string;
          requestId: string;
          generationContractId: string;
          seedSnapshotFingerprint: string;
        }>,
      ): Promise<
        Readonly<{
          generationContractId: string;
          visiblePoolGeneration: number;
          jobId: string;
          workflowId: string;
          state: "STARTED" | "ALREADY_STARTED";
          replayed: boolean;
        }>
      >;
    }>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createRecommendationPoolV2GenerationLauncher(
  dependencies: Readonly<{
    seedCommands: RecommendationSeedCommands;
    repository: RecommendationPoolV2GenerationLaunchRepository;
    starter: Starter;
    timing: RecommendationPoolV2TimingRecorder;
  }>,
): RecommendationPoolV2GenerationLifecycleCommands {
  return Object.freeze({
    ...dependencies.seedCommands,
    async generate(input) {
      const validation = await dependencies.seedCommands.validate(input);
      if (validation.state !== "READY") {
        return dependencies.seedCommands.generate(input);
      }

      const authorization = bindProviderOperationBudgetAuthorization(
        {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls:
            recommendationPoolV2OperationalPolicy.discovery.maximumPaidRequests,
          maxCostMicros: 2_000_000,
        },
        { authorizedBy: input.context.actor.userId },
      );
      const launch = await dependencies.repository.stage({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        providerBudgetAuthorization: authorization,
      });
      const prepared = await dependencies.seedCommands.prepareForGeneration({
        ...input,
        idempotencyKey: hash({
          contract: "recommendation-pool-v2-seed-preparation.v1",
          idempotencyKey: input.idempotencyKey,
          generationContractId: launch.generationContractId,
        }),
        targetGenerationContractId: launch.generationContractId,
      });
      return prepared;
    },
    async launch(input) {
      const commandReceivedAt = new Date().toISOString();
      const commandStarted = performance.now();
      assertRecommendationSeedWriteAuthorized(input.context);
      const launch = await dependencies.repository.confirmLaunch({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        actorId: input.context.actor.userId,
        generationContractId: input.generationContractId,
        seedSnapshotFingerprint: input.seedSnapshotFingerprint,
        idempotencyKey: input.idempotencyKey,
      });

      const requestFingerprint = (round: 1 | 2) =>
        hash({
          contract: "recommendation-pool-v2-discovery-round.v1",
          generationContractId: launch.generationContractId,
          recommendationContextVersionId: launch.recommendationContextVersionId,
          visiblePoolGeneration: launch.visiblePoolGeneration,
          inputPinId: launch.inputPinId,
          round,
          seedFingerprints: launch.seedFingerprints,
        });
      const confirmationCompletedMs = performance.now() - commandStarted;
      const workflow = await dependencies.starter.start({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        generationContractId: launch.generationContractId,
        recommendationContextVersionId: launch.recommendationContextVersionId,
        visiblePoolGeneration: launch.visiblePoolGeneration,
        inputPinId: launch.inputPinId,
        actorId: input.context.actor.userId,
        jobId: launch.jobId,
        rounds: Object.freeze([
          Object.freeze({
            round: 1 as const,
            requestFingerprint: requestFingerprint(1),
            idempotencyKey: `recommendation-pool-v2:${launch.jobId}:round:1`,
            maxCostMicros: 1_000_000,
          }),
          Object.freeze({
            round: 2 as const,
            requestFingerprint: requestFingerprint(2),
            idempotencyKey: `recommendation-pool-v2:${launch.jobId}:round:2`,
            maxCostMicros: 1_000_000,
          }),
        ]),
      });
      await dependencies.timing.record({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        generationContractId: launch.generationContractId,
        jobId: launch.jobId,
        actorId: input.context.actor.userId,
        eventType: "WORKFLOW_SCHEDULED",
        idempotencyKey: `workflow-scheduled:${workflow.workflowId}`,
        observedState:
          workflow.status === "started" ? "STARTED" : "ALREADY_STARTED",
        details: {
          temporalStatus: workflow.status,
          workflowId: workflow.workflowId,
          commandReceivedAt,
          confirmationDurationMs: confirmationCompletedMs,
          temporalStartDurationMs:
            performance.now() - commandStarted - confirmationCompletedMs,
          commandToScheduleDurationMs: performance.now() - commandStarted,
          measurementBoundary: "LAUNCH_SERVICE_ENTRY_TO_TEMPORAL_ACK",
        },
      });
      return Object.freeze({
        generationContractId: launch.generationContractId,
        visiblePoolGeneration: launch.visiblePoolGeneration,
        jobId: launch.jobId,
        workflowId: workflow.workflowId,
        state: workflow.status === "started" ? "STARTED" : "ALREADY_STARTED",
        replayed: launch.replayed,
      });
    },
  });
}
