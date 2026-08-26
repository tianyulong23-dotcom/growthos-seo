import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  commercialRecommendationFitModelVersion,
} from "../../domain/recommendations/commercial-score-v4.js";
import {
  resolveCommercialSupplyPublishedTarget,
} from "../../domain/recommendations/commercial-refill-cycle.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
} from "../../ports/recommendation-contract.port.js";
import {
  createRecommendationCommands,
} from "../commands/recommendations.command.js";
import {
  currentCommercialStaticAssessmentRecoveryContractVersion,
  maximumCurrentCommercialStaticAssessmentRecoveryAttempts,
} from "./current-commercial-static-assessment-recovery.service.js";

export type CurrentCommercialStaticAssessmentRecoverySchedulerClient =
  Readonly<{
    query(
      text: string,
      values?: readonly unknown[],
    ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
  }>;

export async function ensureCurrentCommercialStaticAssessmentRecovery(
  client: CurrentCommercialStaticAssessmentRecoverySchedulerClient,
  input: Readonly<{
    context: ResolvedProjectContext;
    recommendationContextVersionId: string;
    maximumCandidates: number;
    now: Date;
  }>,
): Promise<
  | Readonly<{
      status: "idle";
      recoverableCandidateCount: 0;
    }>
  | Readonly<{
      status: "queued";
      jobId: string;
      recoverableCandidateCount: number;
      replayed: boolean;
    }>
> {
  const maximumCandidates = Math.max(
    1,
    Math.min(25, Math.trunc(input.maximumCandidates)),
  );
  const { tenant, project } = input.context;
  const due = await client.query(
    `WITH current_policy AS MATERIALIZED (
       SELECT policy.visible_pool_generation "visiblePoolGeneration",
              policy.visible_pool_target_count "visiblePoolTargetCount"
         FROM backlink_commercial_inventory_policies AS policy
         JOIN backlink_project_context_snapshots AS context
           ON (
             context.organization_id,context.workspace_id,
             context.website_project_id,context.id
           )=(
             policy.organization_id,policy.workspace_id,
             policy.website_project_id,policy.project_context_version_id
           )
         JOIN backlink_generation_input_pins AS input_pin
           ON (
             input_pin.organization_id,input_pin.workspace_id,
             input_pin.website_project_id
           )=(
             context.organization_id,context.workspace_id,
             context.website_project_id
           )
          AND input_pin.project_context_version=context.snapshot_version
          AND input_pin.site_profile_version_id=context.profile_version_id
          AND input_pin.promotion_target_version_id=
              context.promotion_target_version_id
          AND input_pin.market=context.country_code
          AND input_pin.qualification_contract_version=$6
        WHERE (
          policy.organization_id,policy.workspace_id,
          policy.website_project_id,policy.project_context_version_id
        )=($1,$2,$3,$4)
          AND context.project_status='ACTIVE'
          AND policy.visible_pool_state IN (
            'idle','building','active','awaiting_refresh'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM backlink_recommendation_refills AS refill
              JOIN backlink_jobs AS job
                ON (
                  job.organization_id,job.workspace_id,
                  job.website_project_id,job.id
                )=(
                  refill.organization_id,refill.workspace_id,
                  refill.website_project_id,refill.job_id
                )
             WHERE (
               refill.organization_id,refill.workspace_id,
               refill.website_project_id,
               refill.recommendation_context_version_id
             )=($1,$2,$3,$4)
               AND refill.visible_pool_generation=
                   policy.visible_pool_generation
               AND job.status IN ('queued','running','waiting_provider')
          )
          AND NOT EXISTS (
            SELECT 1
              FROM backlink_commercial_discovery_batches AS batch
             WHERE (
               batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.project_context_version_id
             )=($1,$2,$3,$4)
               AND batch.visible_pool_generation=
                   policy.visible_pool_generation
               AND batch.status='running'
          )
          AND (
            SELECT count(*)
              FROM backlink_recommendation_inventory AS inventory
              JOIN backlink_recommendations AS recommendation
                ON (
                  recommendation.organization_id,
                  recommendation.workspace_id,
                  recommendation.website_project_id,
                  recommendation.id
                )=(
                  inventory.organization_id,
                  inventory.workspace_id,
                  inventory.website_project_id,
                  inventory.recommendation_id
                )
             WHERE (
               inventory.organization_id,inventory.workspace_id,
               inventory.website_project_id,
               inventory.recommendation_context_version_id
             )=($1,$2,$3,$4)
               AND inventory.visible_pool_generation=
                   policy.visible_pool_generation
               AND inventory.fit_decision='eligible'
               AND inventory.fit_score_model_version=$5
               AND inventory.status IN ('ready','shown','accepted')
               AND recommendation.status IN ('ready','shown','accepted')
          ) < policy.visible_pool_target_count
     ),
     recoverable AS MATERIALIZED (
       SELECT candidate.id::text "candidateId",
              CASE
                WHEN candidate.static_assessment
                       #>>'{recovery,contractVersion}'=$10
                 AND candidate.static_assessment
                       #>>'{recovery,attemptCount}' ~ '^[0-9]+$'
                  THEN (
                    candidate.static_assessment
                      #>>'{recovery,attemptCount}'
                  )::integer
                ELSE 0
              END "attemptCount"
         FROM backlink_commercial_candidates AS candidate
         JOIN current_policy AS policy
           ON policy."visiblePoolGeneration"=
              candidate.visible_pool_generation
        WHERE (
          candidate.organization_id,candidate.workspace_id,
          candidate.website_project_id,
          candidate.project_context_version_id
        )=($1,$2,$3,$4)
          AND candidate.score_model_version=$5
          AND candidate.recommendation_id IS NULL
          AND candidate.prospect_id IS NULL
          AND candidate.state IN ('insufficient_data','manual_review')
          AND candidate.static_assessment->>'decision'='insufficient_data'
          AND jsonb_typeof(
            candidate.static_assessment->'failedUrls'
          )='array'
          AND jsonb_array_length(
            candidate.static_assessment->'failedUrls'
          )>0
          AND CASE
                WHEN candidate.static_assessment
                       #>>'{recovery,contractVersion}'=$10
                 AND candidate.static_assessment
                       #>>'{recovery,attemptCount}' ~ '^[0-9]+$'
                  THEN (
                    candidate.static_assessment
                      #>>'{recovery,attemptCount}'
                  )::integer
                ELSE 0
              END < $8
          AND (
            candidate.static_assessment
              #>>'{recovery,contractVersion}' IS DISTINCT FROM $10
            OR (
              candidate.static_assessment
                #>>'{recovery,contractVersion}'=$10
              AND (
                COALESCE(
                  candidate.static_assessment#>>'{recovery,status}',
                  ''
                ) NOT IN (
                  'running','retry_scheduled','completed',
                  'manual_review','exhausted'
                )
                OR (
                  candidate.static_assessment
                    #>>'{recovery,status}'='running'
                  AND NULLIF(
                        candidate.static_assessment
                          #>>'{recovery,leaseExpiresAt}',
                        ''
                      )::timestamptz <= $7
                )
                OR (
                  candidate.static_assessment
                    #>>'{recovery,status}'='retry_scheduled'
                  AND NULLIF(
                        candidate.static_assessment
                          #>>'{recovery,nextRetryAt}',
                        ''
                      )::timestamptz <= $7
                )
              )
            )
          )
        ORDER BY candidate.updated_at,candidate.id
        LIMIT $9
     )
     SELECT policy."visiblePoolGeneration",
            policy."visiblePoolTargetCount",
            recoverable."candidateId",
            recoverable."attemptCount"
       FROM current_policy AS policy
       JOIN recoverable ON true
      ORDER BY recoverable."candidateId"`,
    [
      tenant.organizationId,
      tenant.workspaceId,
      project.websiteProjectId,
      input.recommendationContextVersionId,
      commercialRecommendationFitModelVersion,
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      input.now,
      maximumCurrentCommercialStaticAssessmentRecoveryAttempts,
      maximumCandidates,
      currentCommercialStaticAssessmentRecoveryContractVersion,
    ],
  );
  const anchor = due.rows[0];
  if (anchor === undefined) {
    return Object.freeze({
      status: "idle",
      recoverableCandidateCount: 0,
    });
  }
  const visiblePoolGeneration = Number(anchor.visiblePoolGeneration);
  if (!Number.isSafeInteger(visiblePoolGeneration) || visiblePoolGeneration < 1) {
    throw new Error("CURRENT_COMMERCIAL_RECOVERY_GENERATION_INVALID");
  }
  const targetPublishedCount = resolveCommercialSupplyPublishedTarget(
    process.env.BACKLINK_RECOMMENDATION_POOL_TARGET_COUNT
      ?? anchor.visiblePoolTargetCount,
  );
  const nextAttempt = Number(anchor.attemptCount) + 1;
  const recoveryWindowVersion =
    currentCommercialStaticAssessmentRecoveryContractVersion.replace(
      "commercial-static-assessment-recovery.",
      "",
    );
  const refillWindowKey = [
    "commercial-existing",
    project.websiteProjectId,
    input.recommendationContextVersionId,
    `g${visiblePoolGeneration}`,
    `static-recovery-${recoveryWindowVersion}`,
    String(anchor.candidateId),
    `a${nextAttempt}`,
  ].join(":");
  const terminalRefill = await client.query(
    `SELECT 1
       FROM backlink_recommendation_refills AS refill
       JOIN backlink_jobs AS job
         ON (
           job.organization_id,job.workspace_id,
           job.website_project_id,job.id
         )=(
           refill.organization_id,refill.workspace_id,
           refill.website_project_id,refill.job_id
         )
      WHERE (
        refill.organization_id,refill.workspace_id,
        refill.website_project_id,
        refill.recommendation_context_version_id
      )=($1,$2,$3,$4)
        AND refill.visible_pool_generation=$5
        AND refill.refill_window_key=$6
        AND job.status IN (
          'success','partial_success','failed','cancelled'
        )
      LIMIT 1`,
    [
      tenant.organizationId,
      tenant.workspaceId,
      project.websiteProjectId,
      input.recommendationContextVersionId,
      visiblePoolGeneration,
      refillWindowKey,
    ],
  );
  if (terminalRefill.rows.length > 0) {
    return Object.freeze({
      status: "idle",
      recoverableCandidateCount: 0,
    });
  }
  const queued = await createRecommendationCommands(client).requestRefill({
    context: input.context,
    requestId: refillWindowKey,
    expectedVersion: 0,
    recommendationContextVersionId:
      input.recommendationContextVersionId,
    visiblePoolGeneration,
    lowWatermark: 0,
    highWatermark: targetPublishedCount,
    refillWindowKey,
    triggerReason: "inventory_low",
    supplyMode: "existing_evidence",
  });
  return Object.freeze({
    status: "queued",
    jobId: queued.jobId,
    recoverableCandidateCount: due.rows.length,
    replayed: queued.replayed,
  });
}
