import { type ContactEnrichmentJobOptions } from "../application/commands/contact-enrichment.command.js";
import {
  createRecommendationPoolV2ContactPreparationService,
  type PrepareRecommendationPoolV2CanonicalBatchesInput,
} from "../application/services/recommendation-pool-v2-contact-preparation.service.js";
import {
  createRecommendationPoolV2GenerationService,
  type RecommendationPoolV2DiscoveryRoundExecutor,
} from "../application/services/recommendation-pool-v2-generation.service.js";
import type { RecommendationPoolV2WorkflowActivities } from "../application/services/recommendation-pool-v2-workflow.service.js";
import {
  createRecommendationPoolV2Repository,
  type RecommendationPoolV2CanonicalBatchRecoveryResult,
  type RecommendationPoolV2GenerationSupersessionInput,
} from "../db/repositories/recommendation-pool-v2.repository.js";
import { createRecommendationPoolV2TimingRepository } from "../db/repositories/recommendation-pool-v2-timing.repository.js";
import { createRecommendationHybridSupplyRepository } from "../db/repositories/recommendation-hybrid-supply.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../db/tenant-transaction.js";

type ProductionRecommendationPoolV2Dependencies = Readonly<{
  pool: BacklinkTenantPool;
  discoveryRoundExecutor: RecommendationPoolV2DiscoveryRoundExecutor;
  contactEnrichmentOptions: ContactEnrichmentJobOptions;
  enrichMetrics?: (
    input: Parameters<RecommendationPoolV2WorkflowActivities["finalizeGeneration"]>[0],
  ) => Promise<void>;
  prepareResourceSupply?: (
    input: Parameters<RecommendationPoolV2WorkflowActivities["finalizeGeneration"]>[0],
  ) => Promise<(client: BacklinkTransactionClient) =>
    Promise<import("../application/services/recommendation-hybrid-supply.service.js").RecommendationHybridSupplyOutcome>>;
}>;

export type RecommendationPoolV2ActivityDependencies =
  | RecommendationPoolV2WorkflowActivities
  | ProductionRecommendationPoolV2Dependencies;

export type RecommendationPoolV2Phase4ActivityDependencies = Readonly<{
  pool: BacklinkTenantPool;
  contactEnrichmentOptions: ContactEnrichmentJobOptions;
}>;

export type RecommendationPoolV2Phase4RecoveryInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;

export type RecommendationPoolV2Phase4RecoveryResult =
  | Extract<
      RecommendationPoolV2CanonicalBatchRecoveryResult,
      { status: "contract_not_applicable" | "idle" }
    >
  | Readonly<{
      status: "recovered";
      batchIds: readonly string[];
      state: "PREPARING" | "AVAILABLE" | "SUPERSEDED";
      workflowInput: Readonly<{
        organizationId: string;
        workspaceId: string;
        websiteProjectId: string;
        generationContractId: string;
        recommendationContextVersionId: string;
        visiblePoolGeneration: number;
        inputPinId: string;
        actorId: string;
      }>;
    }>;

export type RecommendationPoolV2Phase4Activities = Pick<
  RecommendationPoolV2WorkflowActivities,
  | "prepareCanonicalBatches"
  | "inspectCanonicalBatchPreparation"
  | "convergeCanonicalBatchPreparation"
> &
  Readonly<{
    completeGenerationSupersession(
      input: RecommendationPoolV2GenerationSupersessionInput,
    ): Promise<void>;
    recoverCanonicalBatchPreparation(
      input: RecommendationPoolV2Phase4RecoveryInput,
    ): Promise<RecommendationPoolV2Phase4RecoveryResult>;
  }>;

function isProductionDependencies(
  dependencies: RecommendationPoolV2ActivityDependencies,
): dependencies is Extract<
  RecommendationPoolV2ActivityDependencies,
  { pool: BacklinkTenantPool }
> {
  return "pool" in dependencies;
}

function contactPreparationService(
  client: BacklinkTransactionClient,
  options: ContactEnrichmentJobOptions,
) {
  const repository = createRecommendationPoolV2Repository(client);
  return createRecommendationPoolV2ContactPreparationService({
    client,
    options,
    loadCanonicalContactSources: (request) =>
      repository.loadCanonicalContactSources(request),
  });
}

async function prepareCanonicalBatches(
  client: BacklinkTransactionClient,
  options: ContactEnrichmentJobOptions,
  input: PrepareRecommendationPoolV2CanonicalBatchesInput,
): Promise<void> {
  await contactPreparationService(client, options).prepareCanonicalBatches(
    input,
  );
}

export async function recoverRecommendationPoolV2CanonicalBatchPreparation(
  client: BacklinkTransactionClient,
  options: ContactEnrichmentJobOptions,
  input: RecommendationPoolV2Phase4RecoveryInput,
): Promise<RecommendationPoolV2Phase4RecoveryResult> {
  const repository = createRecommendationPoolV2Repository(client);
  const recovery =
    await repository.loadCanonicalBatchPreparationRecovery(input);
  if (recovery.status !== "preparing") return recovery;

  if (recovery.preparingBatchIds.length > 0) {
    await prepareCanonicalBatches(client, options, {
      ...recovery.input,
      batchIds: recovery.preparingBatchIds,
    });
  }
  let inspection = await repository.inspectCanonicalBatchPreparation(
    recovery.input,
  );
  if (
    inspection.state === "PREPARING" &&
    Date.parse(inspection.databaseNow) >=
      Date.parse(recovery.input.preparationDeadlineAt)
  ) {
    await repository.convergeCanonicalBatchPreparation(recovery.input);
    inspection = await repository.inspectCanonicalBatchPreparation(
      recovery.input,
    );
  }
  if (inspection.state === "AVAILABLE" && recovery.input.jobId !== undefined) {
    if (recovery.input.workflowId === undefined) {
      throw new Error("RECOMMENDATION_POOL_V2_PREPARATION_RECOVERY_INVALID");
    }
    await repository.activateGeneration({
      ...recovery.input,
      jobId: recovery.input.jobId,
      workflowId: recovery.input.workflowId,
    });
  }
  return Object.freeze({
    status: "recovered",
    batchIds: recovery.input.batchIds,
    state: inspection.state,
    workflowInput: Object.freeze({
      organizationId: recovery.input.organizationId,
      workspaceId: recovery.input.workspaceId,
      websiteProjectId: recovery.input.websiteProjectId,
      generationContractId: recovery.input.generationContractId,
      recommendationContextVersionId:
        recovery.input.recommendationContextVersionId,
      visiblePoolGeneration: recovery.input.visiblePoolGeneration,
      inputPinId: recovery.input.inputPinId,
      actorId: recovery.input.actorId,
    }),
  });
}

export function createRecommendationPoolV2Phase4Activities(
  dependencies: RecommendationPoolV2Phase4ActivityDependencies,
): RecommendationPoolV2Phase4Activities {
  const transact = <T>(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
    }>,
    work: (client: BacklinkTransactionClient) => Promise<T>,
  ) => withBacklinkTenantTransaction(dependencies.pool, input, work);

  return Object.freeze({
    prepareCanonicalBatches: (input) =>
      transact(input, (client) =>
        prepareCanonicalBatches(
          client,
          dependencies.contactEnrichmentOptions,
          input,
        ),
      ),
    inspectCanonicalBatchPreparation: (input) =>
      transact(input, (client) =>
        createRecommendationPoolV2Repository(
          client,
        ).inspectCanonicalBatchPreparation(input),
      ),
    convergeCanonicalBatchPreparation: (input) =>
      transact(input, async (client) => {
        await prepareCanonicalBatches(
          client,
          dependencies.contactEnrichmentOptions,
          input,
        );
        await createRecommendationPoolV2Repository(
          client,
        ).convergeCanonicalBatchPreparation(input);
      }),
    completeGenerationSupersession: (input) =>
      transact(input, (client) =>
        createRecommendationPoolV2Repository(
          client,
        ).completeGenerationSupersession(input),
      ),
    recoverCanonicalBatchPreparation: (input) =>
      transact(input, (client) =>
        recoverRecommendationPoolV2CanonicalBatchPreparation(
          client,
          dependencies.contactEnrichmentOptions,
          input,
        ),
      ),
  });
}

export function createRecommendationPoolV2Activities(
  dependencies: RecommendationPoolV2ActivityDependencies,
): RecommendationPoolV2WorkflowActivities {
  if (!isProductionDependencies(dependencies)) {
    return Object.freeze({ ...dependencies });
  }
  const generation = createRecommendationPoolV2GenerationService(
    dependencies.discoveryRoundExecutor,
  );
  const phase4 = createRecommendationPoolV2Phase4Activities(dependencies);
  const transact = <T>(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
    }>,
    work: (
      repository: ReturnType<typeof createRecommendationPoolV2Repository>,
      timing: ReturnType<
        typeof createRecommendationPoolV2TimingRepository
      >,
      client: BacklinkTransactionClient,
    ) => Promise<T>,
  ) =>
    withBacklinkTenantTransaction(dependencies.pool, input, (client) =>
      work(
        createRecommendationPoolV2Repository(client),
        createRecommendationPoolV2TimingRepository(client),
        client,
      ),
    );

  return Object.freeze({
    loadGeneration: async (input) => {
      const start = await transact(input, async (repository, timing) => {
        await timing.record({
          ...input,
          eventType: "WORKFLOW_STARTED",
          idempotencyKey: `workflow-started:${input.workflowId}`,
          observedState: "RUNNING",
          details: { source: "temporal_activity" },
        });
        const result = await repository.loadGeneration(input);
        await timing.record({
          ...input,
          eventType: "SEED_SNAPSHOT_LOADED",
          idempotencyKey: `seed-snapshot-loaded:${input.workflowId}`,
          observedState: result.status.toUpperCase(),
          details: { generationStartStatus: result.status },
        });
        return result;
      });
      if (start.status !== "ready" || input.visiblePoolGeneration <= 1
        || dependencies.prepareResourceSupply === undefined) return start;
      const existingSupply = await transact(input, (_repository, _timing, client) =>
        createRecommendationHybridSupplyRepository(client).load(input));
      // Resumed discovery must retain its settled-cost ledger and finalization path.
      if (existingSupply.dataForSeoCount > 0 || existingSupply.discoveryStarted) return start;
      const supplyInput = {
        ...input, terminalReason: "SAFE_SUPPLY_REACHED" as const,
        totalSettledCostMicros: 0, hardCandidateLimit: 1_000, rounds: [],
      };
      const prepare = await dependencies.prepareResourceSupply(supplyInput);
      const insufficient = new Error("HYBRID_SUPPLY_INSUFFICIENT");
      try {
        const resourceSupply = await transact(input, async (_repository, _timing, client) => {
          const supply = await prepare(client);
          if (supply.status === "BLOCKED") {
            throw new Error(supply.reason ?? "RESOURCE_LIBRARY_UNAVAILABLE");
          }
          // Roll back partial reservations before the existing bounded discovery
          // path. Its finalizer will select those rows again with the final mix.
          if (supply.status !== "ALREADY_FINALIZED"
            && existingSupply.admittedCount + supply.admittedCount < 100) {
            throw insufficient;
          }
          return supply;
        });
        // Persist candidates before network I/O; retries reuse source counts and
        // governed metric receipts before immutable release snapshots are made.
        await dependencies.enrichMetrics?.(supplyInput);
        return await transact(input, async (repository, timing) => {
          const finalization = await repository.finalizeGeneration(supplyInput);
          await timing.record({
            ...input, eventType: "SEED_SNAPSHOT_LOADED",
            idempotencyKey: `resource-supply-ready:${input.workflowId}`,
            observedState: "READY",
            details: { resourceSupply, paidDiscoverySkipped: true },
          });
          return { status: "already_completed" as const, finalization };
        });
      } catch (error) {
        if (error === insufficient) return start;
        throw error;
      }
    },
    executeDiscoveryRound: generation.executeDiscoveryRound,
    finalizeGeneration: async (input) => {
      const prepareResourceSupply = await dependencies.prepareResourceSupply?.(input);
      const resourceSupply = prepareResourceSupply === undefined ? undefined
        : await transact(input, (_repository, _timing, client) => prepareResourceSupply(client));
      await dependencies.enrichMetrics?.(input);
      return transact(input, async (repository, timing) => {
        const result = await repository.finalizeGeneration(input);
        for (const batch of result.batches) {
          await timing.record({
            ...input,
            eventType: "BATCH_PREPARED",
            idempotencyKey: `batch-prepared:${batch.batchId}`,
            batchId: batch.batchId,
            observedState: "PREPARING",
            details: {
              batchOrdinal: batch.ordinal,
              originalBatchSize: batch.originalBatchSize,
              discoveryTerminalReason: result.discoveryTerminalReason,
              ...(resourceSupply === undefined ? {} : { resourceSupply }),
            },
          });
        }
        return result;
      });
    },
    prepareCanonicalBatches: (input) =>
      transact(input, async (_repository, timing, client) => {
        await timing.record({
          ...input,
          eventType: "CONTACT_ENRICHMENT_STARTED",
          idempotencyKey: `contact-enrichment-started:${input.workflowId}`,
          observedState: "PREPARING",
          details: { batchCount: input.batchIds.length },
        });
        await prepareCanonicalBatches(
          client,
          dependencies.contactEnrichmentOptions,
          input,
        );
      }),
    inspectCanonicalBatchPreparation: (input) =>
      transact(input, async (repository, timing) => {
        const result =
          await repository.inspectCanonicalBatchPreparation(input);
        if (result.state === "AVAILABLE") {
          await timing.record({
            ...input,
            eventType: "CONTACT_ENRICHMENT_COMPLETED",
            idempotencyKey: `contact-enrichment-completed:${input.workflowId}`,
            observedState: result.state,
            details: {
              terminalBatchCount: result.terminalBatchCount,
              totalBatchCount: result.totalBatchCount,
            },
          });
        }
        return result;
      }),
    convergeCanonicalBatchPreparation: phase4.convergeCanonicalBatchPreparation,
    activateGeneration: (input) =>
      transact(input, async (repository, timing) => {
        await repository.activateGeneration(input);
        await timing.record({
          ...input,
          eventType: "PUBLICATION_COMMITTED",
          idempotencyKey: `publication-committed:${input.workflowId}`,
          observedState: "AVAILABLE",
          details: { batchCount: input.batchIds.length },
        });
      }),
    completeGenerationWithoutPublication: (input) =>
      transact(input, (repository) =>
        repository.completeGenerationWithoutPublication(input),
      ),
    failGeneration: (input) =>
      transact(input, (repository) => repository.failGeneration(input)),
    completeGenerationSupersession: phase4.completeGenerationSupersession,
  });
}
