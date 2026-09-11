import { randomUUID } from "node:crypto";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";

import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";

export const recommendationPoolV2TimingEventTypes = Object.freeze([
  "COMMAND_ACCEPTED",
  "WORKFLOW_SCHEDULED",
  "WORKFLOW_STARTED",
  "SEED_SNAPSHOT_LOADED",
  "REQUEST_PLAN_CREATED",
  "PROVIDER_REQUEST_QUEUED",
  "PROVIDER_REQUEST_STARTED",
  "PROVIDER_REQUEST_COMPLETED",
  "PROVIDER_OUTCOME_PERSISTED",
  "CANDIDATE_NORMALIZATION_STARTED",
  "CANDIDATE_NORMALIZATION_COMPLETED",
  "CANDIDATE_ADMISSION_STARTED",
  "CANDIDATE_ADMISSION_COMPLETED",
  "METRIC_ENRICHMENT_STARTED",
  "METRIC_ENRICHMENT_COMPLETED",
  "CONTACT_ENRICHMENT_STARTED",
  "CONTACT_ENRICHMENT_COMPLETED",
  "BATCH_PREPARED",
  "PUBLICATION_COMMITTED",
  "FRONTEND_STATE_FIRST_OBSERVED",
] as const);

export type RecommendationPoolV2TimingEventType =
  (typeof recommendationPoolV2TimingEventTypes)[number];

export type RecommendationPoolV2TimingEventInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  generationContractId: string;
  jobId: string;
  actorId: string;
  eventType: RecommendationPoolV2TimingEventType;
  idempotencyKey: string;
  roundNumber?: 1 | 2;
  requestIntentId?: string;
  generationCandidateId?: string;
  batchId?: string;
  observedState?: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type RecommendationPoolV2TimingRecorder = Readonly<{
  record(input: RecommendationPoolV2TimingEventInput): Promise<void>;
}>;

export type RecommendationFeedObservation = Readonly<{
  generationContractId: string;
  observedState: string;
  clientObservedAt: string;
}>;

export type RecommendationFeedObserver = (
  context: ResolvedProjectContext,
  observation: RecommendationFeedObservation,
) => Promise<void>;

export function createRecommendationFeedObserver(
  pool: BacklinkTenantPool,
): RecommendationFeedObserver {
  return async (context, observation) => {
    const scope = {
      organizationId: context.tenant.organizationId,
      workspaceId: context.tenant.workspaceId,
      websiteProjectId: context.project.websiteProjectId,
      actorId: context.actor.userId,
    };
    await withBacklinkTenantTransaction(pool, scope, async (client) => {
      const result = await client.query(
        `SELECT id FROM backlinks.backlink_jobs
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
            AND job_type='recommendation_pool_v2_generation'
            AND result_summary->>'generationContractId'=$4
          ORDER BY created_at,id LIMIT 1`,
        [scope.organizationId, scope.workspaceId, scope.websiteProjectId,
          observation.generationContractId],
      );
      const job = result.rows[0];
      if (!job || typeof job.id !== "string") {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "Native generation not found in the current project.",
        });
      }
      await createRecommendationPoolV2TimingRepository(client).record({
        ...scope,
        generationContractId: observation.generationContractId,
        jobId: job.id,
        eventType: "FRONTEND_STATE_FIRST_OBSERVED",
        idempotencyKey: `frontend:${scope.actorId}:${observation.observedState}`,
        observedState: observation.observedState,
        // The durable timestamp is server receipt, never a backdated client claim.
        details: {
          clientObservedAt: observation.clientObservedAt,
          clockSource: "UNTRUSTED_CLIENT",
          source: "VISIBLE_RECOMMENDATION_FEED",
        },
      });
    });
  };
}

export function createRecommendationPoolV2TimingRepository(
  client: BacklinkTransactionClient,
): RecommendationPoolV2TimingRecorder {
  return Object.freeze({
    async record(input) {
      const result = await client.query(
        `WITH lineage AS MATERIALIZED (
           SELECT generation.recommendation_context_version_id,
                  generation.visible_pool_generation,
                  generation.input_pin_id,
                  job.workflow_id,
                  job.correlation_id
             FROM backlinks.backlink_recommendation_generation_contracts
               AS generation
             JOIN backlinks.backlink_jobs AS job
               ON job.organization_id=generation.organization_id
              AND job.workspace_id=generation.workspace_id
              AND job.website_project_id=generation.website_project_id
              AND job.id=$5
              AND job.job_type='recommendation_pool_v2_generation'
              AND job.result_summary->>'generationContractId'=
                    generation.id::text
            WHERE generation.organization_id=$1
              AND generation.workspace_id=$2
              AND generation.website_project_id=$3
              AND generation.id=$4
              AND generation.pool_contract_version='recommendation-pool.v2'
              AND (
                $10::uuid IS NULL
                OR EXISTS (
                  SELECT 1
                    FROM backlinks
                      .backlink_recommendation_discovery_request_intents
                      AS intent
                   WHERE intent.organization_id=generation.organization_id
                     AND intent.workspace_id=generation.workspace_id
                     AND intent.website_project_id=
                           generation.website_project_id
                     AND intent.id=$10
                     AND intent.generation_contract_id=generation.id
                     AND intent.recommendation_context_version_id=
                           generation.recommendation_context_version_id
                     AND intent.visible_pool_generation=
                           generation.visible_pool_generation
                     AND intent.input_pin_id=generation.input_pin_id
                )
              )
              AND (
                $11::uuid IS NULL
                OR EXISTS (
                  SELECT 1
                    FROM backlinks
                      .backlink_recommendation_generation_candidates
                      AS candidate
                   WHERE candidate.organization_id=
                           generation.organization_id
                     AND candidate.workspace_id=generation.workspace_id
                     AND candidate.website_project_id=
                           generation.website_project_id
                     AND candidate.id=$11
                     AND candidate.generation_contract_id=generation.id
                     AND candidate.recommendation_context_version_id=
                           generation.recommendation_context_version_id
                     AND candidate.visible_pool_generation=
                           generation.visible_pool_generation
                     AND candidate.input_pin_id=generation.input_pin_id
                )
              )
              AND (
                $12::uuid IS NULL
                OR EXISTS (
                  SELECT 1
                    FROM backlinks.backlink_recommendation_release_batches
                      AS batch
                   WHERE batch.organization_id=generation.organization_id
                     AND batch.workspace_id=generation.workspace_id
                     AND batch.website_project_id=
                           generation.website_project_id
                     AND batch.id=$12
                     AND batch.generation_contract_id=generation.id
                     AND batch.recommendation_context_version_id=
                           generation.recommendation_context_version_id
                     AND batch.visible_pool_generation=
                           generation.visible_pool_generation
                     AND batch.input_pin_id=generation.input_pin_id
                )
              )
         ),
         inserted AS (
           INSERT INTO backlinks
             .backlink_recommendation_pool_v2_timing_events (
               id,organization_id,workspace_id,website_project_id,
               generation_contract_id,recommendation_context_version_id,
               visible_pool_generation,input_pin_id,job_id,workflow_id,
               command_id,event_type,round_number,request_intent_id,
               generation_candidate_id,batch_id,observed_state,details,
               idempotency_key,created_by
             )
           SELECT $15,$1,$2,$3,$4,lineage.recommendation_context_version_id,
                  lineage.visible_pool_generation,lineage.input_pin_id,$5,
                  lineage.workflow_id,lineage.correlation_id,$6,$9,$10,$11,
                  $12,$13,$14::jsonb,$7,$8
             FROM lineage
           ON CONFLICT (
             organization_id,workspace_id,website_project_id,
             generation_contract_id,idempotency_key
           ) DO NOTHING
           RETURNING id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT event.id
           FROM backlinks.backlink_recommendation_pool_v2_timing_events
             AS event
          WHERE event.organization_id=$1 AND event.workspace_id=$2
            AND event.website_project_id=$3
            AND event.generation_contract_id=$4
            AND event.idempotency_key=$7
         LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.generationContractId,
          input.jobId,
          input.eventType,
          input.idempotencyKey,
          input.actorId,
          input.roundNumber ?? null,
          input.requestIntentId ?? null,
          input.generationCandidateId ?? null,
          input.batchId ?? null,
          input.observedState ?? null,
          JSON.stringify(input.details ?? {}),
          randomUUID(),
        ],
      );
      if (result.rows[0] === undefined) {
        throw new Error("RECOMMENDATION_POOL_V2_TIMING_LINEAGE_INVALID");
      }
    },
  });
}

export function createScopedRecommendationPoolV2TimingRecorder(
  pool: BacklinkTenantPool,
): RecommendationPoolV2TimingRecorder {
  return Object.freeze({
    record: (input) =>
      withBacklinkTenantTransaction(pool, input, (client) =>
        createRecommendationPoolV2TimingRepository(client).record(input),
      ),
  });
}
