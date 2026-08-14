import {
  createRecommendationCommands,
} from "../commands/recommendations.command.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../domain/context/index.js";
import {
  decideCommercialInventoryRefill,
} from "../../domain/recommendations/commercial-inventory.js";
import { commercialDiscoveryBlueprintVersion } from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  buildCommercialRefillWindowKey,
  commercialRefillTiers,
  commercialSupplyPublishedTarget,
  hasCommercialRefillAttempt,
  isCommercialRefillTier,
  nextCommercialRefillWindow,
  parseCommercialRefillAttempts,
  recordCommercialRefillAttemptOutcome,
  type CommercialRefillAttempt,
  type CommercialRefillTier,
} from "../../domain/recommendations/commercial-refill-cycle.js";

export type CommercialInventoryRefillClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type CommercialRefillTerminationReason =
  | "HIGH_WATERMARK"
  | "BUDGET"
  | "PROVIDER_UNAVAILABLE"
  | "TIERS_EXHAUSTED"
  | "PROJECT_CONTEXT";

export type CommercialInventoryRefillResult =
  | Readonly<{
    status: "idle" | "paused";
    pauseReason:
      | "inflight"
      | "budget"
      | "project_context"
      | "provider_unavailable"
      | "tiers_exhausted"
      | null;
    requestedCandidateCount: number;
    effectiveEmailHitRate: number;
    currentTier: CommercialRefillTier;
    currentRound: number;
    terminationReason: CommercialRefillTerminationReason | null;
  }>
  | Readonly<{
    status: "queued";
    jobId: string;
    requestedCandidateCount: number;
    effectiveEmailHitRate: number;
    currentTier: CommercialRefillTier;
    currentRound: number;
    terminationReason: null;
  }>;

type RefillCycleState =
  | "idle"
  | "running"
  | "waiting_contact"
  | "completed"
  | "paused"
  | "exhausted";

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value) as unknown);
    } catch {
      return Object.freeze({});
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.freeze({ ...(value as Record<string, unknown>) })
    : Object.freeze({});
}

function refillTier(value: unknown): CommercialRefillTier {
  return isCommercialRefillTier(value)
    ? value
    : commercialRefillTiers[0];
}

function terminationReason(
  value: unknown,
): CommercialRefillTerminationReason | null {
  return [
    "HIGH_WATERMARK",
    "BUDGET",
    "PROVIDER_UNAVAILABLE",
    "TIERS_EXHAUSTED",
    "PROJECT_CONTEXT",
  ].includes(String(value))
    ? value as CommercialRefillTerminationReason
    : null;
}

function appendAttempt(
  attempts: readonly CommercialRefillAttempt[],
  tier: CommercialRefillTier,
  round: number,
  window = 1,
): readonly CommercialRefillAttempt[] {
  return hasCommercialRefillAttempt(attempts, tier, round, window)
    ? attempts
    : Object.freeze([
        ...attempts,
        Object.freeze({ tier, round, window }),
      ]);
}

async function updateCycleState(
  client: CommercialInventoryRefillClient,
  input: Readonly<{
    scopeValues: readonly [string, string, string, string];
    state: RefillCycleState;
    tier: CommercialRefillTier;
    round: number;
    attempts: readonly CommercialRefillAttempt[];
    terminationReason: CommercialRefillTerminationReason | null;
    pauseReason: string | null;
    publishableCount: number;
    rawCandidateCount: number;
    eliminationReasonCounts: Readonly<Record<string, unknown>>;
    now: Date;
    actorId: string;
    visiblePoolGeneration: number;
    visiblePoolState?: "active" | "building" | undefined;
  }>,
): Promise<void> {
  await client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET refill_state=$5,current_refill_tier=$6,current_refill_round=$7,
            attempted_refill_tiers=$8::jsonb,termination_reason=$9,
            pause_reason=$10,last_publishable_count=$11,
            last_raw_candidate_count=$12,
            elimination_reason_counts=$13::jsonb,
            next_refill_at=NULL,updated_at=$14,updated_by=$15,
            visible_pool_state=COALESCE($17,visible_pool_state),
            version=version+1
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)
        AND visible_pool_generation=$16`,
    [
      ...input.scopeValues,
      input.state,
      input.tier,
      input.round,
      JSON.stringify(input.attempts),
      input.terminationReason,
      input.pauseReason,
      input.publishableCount,
      input.rawCandidateCount,
      JSON.stringify(input.eliminationReasonCounts),
      input.now,
      input.actorId,
      input.visiblePoolGeneration,
      input.visiblePoolState ?? null,
    ],
  );
}

export async function ensureCommercialRecommendationRefill(
  client: CommercialInventoryRefillClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    projectContextVersionId: string;
    actorId: string;
    estimatedCostMicros: number;
    candidateLimit: number;
    now: Date;
  }>,
): Promise<CommercialInventoryRefillResult> {
  if (
    !Number.isSafeInteger(input.estimatedCostMicros)
    || input.estimatedCostMicros <= 0
    || !Number.isSafeInteger(input.candidateLimit)
    || input.candidateLimit < 2
  ) {
    throw new TypeError("Commercial inventory refill limits are invalid");
  }
  const scopeValues = [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.projectContextVersionId,
  ] as const;
  await client.query(
    `INSERT INTO backlink_commercial_inventory_policies (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,updated_by
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       project_context_version_id
    ) DO NOTHING`,
    [...scopeValues, input.actorId],
  );
  await client.query(
    `UPDATE backlink_contact_enrichment_batches AS batch
        SET status='completed',
            completed_at=COALESCE(batch.completed_at,$5),
            updated_at=$5,updated_by=$6,version=batch.version+1
      WHERE (batch.organization_id,batch.workspace_id,
             batch.website_project_id,
             batch.recommendation_context_version_id)=($1,$2,$3,$4)
        AND batch.status='running'
        AND EXISTS (
          SELECT 1
            FROM backlink_contact_enrichment_jobs AS child
           WHERE (child.organization_id,child.workspace_id,
                  child.website_project_id,child.batch_id)=
                 (batch.organization_id,batch.workspace_id,
                  batch.website_project_id,batch.id)
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_contact_enrichment_jobs AS child
           WHERE (child.organization_id,child.workspace_id,
                  child.website_project_id,child.batch_id)=
                 (batch.organization_id,batch.workspace_id,
                  batch.website_project_id,batch.id)
             AND child.status IN (
               'pending','running','retry_scheduled'
             )
        )`,
    [...scopeValues, input.now, input.actorId],
  );
  const state = await client.query(
    `WITH candidate_counts AS (
       SELECT
         count(*) FILTER (
           WHERE state IN ('candidate_ready','contact_enrichment')
             AND score_model_version='recommendation-commercial-fit.v3'
             AND commercial_score->>'decision'='eligible'
         )::integer candidate_ready_count,
         count(*) FILTER (
           WHERE state<>'stale_context'
             AND score_model_version='recommendation-commercial-fit.v3'
         )::integer historical_candidate_count,
         count(*) FILTER (
           WHERE score_model_version='recommendation-commercial-fit.v3'
         )::integer raw_candidate_count
       FROM backlink_commercial_candidates
       WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
         AND project_context_version_id=$4
         AND visible_pool_generation=(
           SELECT visible_pool_generation
             FROM backlink_commercial_inventory_policies
            WHERE (organization_id,workspace_id,website_project_id,
                   project_context_version_id)=($1,$2,$3,$4)
         )
     ),
     elimination_reasons AS (
       SELECT COALESCE(
         jsonb_object_agg(reason_code,reason_count),
         '{}'::jsonb
       ) value
       FROM (
         SELECT COALESCE(
                  NULLIF(gate_decision->'hitGates'->>0,''),
                  NULLIF(upper(commercial_score->>'decision'),''),
                  'UNKNOWN'
                ) reason_code,
                count(*)::integer reason_count
           FROM backlink_commercial_candidates
          WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
            AND project_context_version_id=$4
            AND visible_pool_generation=(
              SELECT visible_pool_generation
                FROM backlink_commercial_inventory_policies
               WHERE (organization_id,workspace_id,website_project_id,
                      project_context_version_id)=($1,$2,$3,$4)
            )
            AND score_model_version='recommendation-commercial-fit.v3'
            AND state IN ('excluded','insufficient_data','manual_review')
          GROUP BY 1
       ) reasons
     ),
     publication_counts AS (
       SELECT count(*) FILTER (
                WHERE inventory.publication_status='PUBLISHED'
                  AND inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND inventory.contact_decision='eligible'
                  AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
                  AND inventory.verified_public_email_count>=1
                  AND inventory.status IN ('ready','shown','accepted')
                  AND recommendation.status IN ('ready','shown','accepted')
              )::integer published_count,
              count(*) FILTER (
                WHERE inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND inventory.contact_decision='eligible'
                  AND inventory.verified_public_email_count>=1
              )::integer historical_verified_email_count
       FROM backlink_recommendation_inventory AS inventory
       JOIN backlink_recommendations AS recommendation
         ON (
           recommendation.organization_id,recommendation.workspace_id,
           recommendation.website_project_id,recommendation.id
         )=(
           inventory.organization_id,inventory.workspace_id,
           inventory.website_project_id,inventory.recommendation_id
         )
       JOIN backlink_prospects AS prospect
         ON (
           prospect.organization_id,prospect.workspace_id,
           prospect.website_project_id,prospect.id
         )=(
           inventory.organization_id,inventory.workspace_id,
           inventory.website_project_id,inventory.prospect_id
         )
       WHERE (
         inventory.organization_id,inventory.workspace_id,
         inventory.website_project_id
         )=($1,$2,$3)
         AND inventory.recommendation_context_version_id=$4
         AND inventory.visible_pool_generation=(
           SELECT visible_pool_generation
             FROM backlink_commercial_inventory_policies
            WHERE (organization_id,workspace_id,website_project_id,
                   project_context_version_id)=($1,$2,$3,$4)
         )
     ),
     contact_pending AS (
       SELECT (
         EXISTS (
           SELECT 1
             FROM backlink_contact_enrichment_batches
            WHERE (organization_id,workspace_id,website_project_id)=
                  ($1,$2,$3)
              AND recommendation_context_version_id=$4
              AND status='running'
              AND EXISTS (
                SELECT 1
                  FROM backlink_contact_enrichment_jobs AS child
                  JOIN backlink_recommendation_inventory AS inventory
                    ON (
                      inventory.organization_id,inventory.workspace_id,
                      inventory.website_project_id,
                      inventory.recommendation_id
                    )=(
                      child.organization_id,child.workspace_id,
                      child.website_project_id,child.recommendation_id
                    )
                 WHERE (child.organization_id,child.workspace_id,
                        child.website_project_id,child.batch_id)=
                       (backlink_contact_enrichment_batches.organization_id,
                        backlink_contact_enrichment_batches.workspace_id,
                        backlink_contact_enrichment_batches.website_project_id,
                        backlink_contact_enrichment_batches.id)
                   AND inventory.visible_pool_generation=(
                     SELECT visible_pool_generation
                       FROM backlink_commercial_inventory_policies
                      WHERE (organization_id,workspace_id,website_project_id,
                             project_context_version_id)=($1,$2,$3,$4)
                   )
              )
         )
         OR EXISTS (
           SELECT 1
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
             JOIN backlink_prospects AS prospect
               ON (
                 prospect.organization_id,prospect.workspace_id,
                 prospect.website_project_id,prospect.id
               )=(
                 inventory.organization_id,inventory.workspace_id,
                 inventory.website_project_id,inventory.prospect_id
               )
            WHERE (
              inventory.organization_id,inventory.workspace_id,
              inventory.website_project_id
            )=($1,$2,$3)
              AND inventory.recommendation_context_version_id=$4
              AND inventory.visible_pool_generation=(
                SELECT visible_pool_generation
                  FROM backlink_commercial_inventory_policies
                 WHERE (organization_id,workspace_id,website_project_id,
                        project_context_version_id)=($1,$2,$3,$4)
              )
              AND inventory.status IN ('ready','shown','accepted')
              AND recommendation.status IN ('ready','shown','accepted')
              AND inventory.fit_decision='eligible'
              AND inventory.fit_score_model_version=
                'recommendation-commercial-fit.v3'
              AND inventory.publication_status IN (
                'CONTACT_PENDING','CONTACT_REVIEW'
              )
              AND (
                EXISTS (
                  SELECT 1
                    FROM backlink_contact_enrichment_jobs AS contact_job
                   WHERE (
                     contact_job.organization_id,
                     contact_job.workspace_id,
                     contact_job.website_project_id,
                     contact_job.recommendation_id,
                     contact_job.recommendation_context_version_id
                   )=(
                     inventory.organization_id,
                     inventory.workspace_id,
                     inventory.website_project_id,
                     inventory.recommendation_id,
                     inventory.recommendation_context_version_id
                   )
                     AND contact_job.status IN (
                       'pending','running','retry_scheduled'
                     )
                )
                OR (
                  inventory.contact_decision='pending'
                  AND NOT EXISTS (
                    SELECT 1
                      FROM backlink_contact_enrichment_jobs AS contact_job
                     WHERE (
                       contact_job.organization_id,
                       contact_job.workspace_id,
                       contact_job.website_project_id,
                       contact_job.recommendation_id,
                       contact_job.recommendation_context_version_id
                     )=(
                       inventory.organization_id,
                       inventory.workspace_id,
                       inventory.website_project_id,
                       inventory.recommendation_id,
                       inventory.recommendation_context_version_id
                     )
                  )
                )
              )
         )
       ) value
     ),
     inflight AS (
       SELECT (
         EXISTS (
           SELECT 1
             FROM backlink_jobs
           WHERE (organization_id,workspace_id,website_project_id)=
                  ($1,$2,$3)
              AND source_object_type='recommendation_context'
              AND source_object_id=$4
              AND status IN ('queued','running','waiting_provider')
              AND EXISTS (
                SELECT 1
                  FROM backlink_recommendation_refills AS refill
                 WHERE (refill.organization_id,refill.workspace_id,
                        refill.website_project_id,refill.job_id)=
                       (backlink_jobs.organization_id,
                        backlink_jobs.workspace_id,
                        backlink_jobs.website_project_id,
                        backlink_jobs.id)
                   AND refill.visible_pool_generation=(
                     SELECT visible_pool_generation
                       FROM backlink_commercial_inventory_policies
                      WHERE (organization_id,workspace_id,website_project_id,
                             project_context_version_id)=($1,$2,$3,$4)
                   )
              )
         )
         OR EXISTS (
           SELECT 1
             FROM backlink_commercial_discovery_batches
            WHERE (organization_id,workspace_id,website_project_id)=
                  ($1,$2,$3)
              AND project_context_version_id=$4
              AND visible_pool_generation=(
                SELECT visible_pool_generation
                  FROM backlink_commercial_inventory_policies
                 WHERE (organization_id,workspace_id,website_project_id,
                        project_context_version_id)=($1,$2,$3,$4)
              )
              AND status='running'
         )
       ) value
     ),
     latest_job AS (
       SELECT job.status
         FROM backlink_jobs AS job
         JOIN backlink_recommendation_refills AS refill
           ON (
             refill.organization_id,refill.workspace_id,
             refill.website_project_id,refill.job_id
           )=(
             job.organization_id,job.workspace_id,
             job.website_project_id,job.id
           )
        WHERE (job.organization_id,job.workspace_id,
               job.website_project_id)=($1,$2,$3)
           AND job.source_object_type='recommendation_context'
           AND job.source_object_id=$4
          AND refill.visible_pool_generation=(
            SELECT visible_pool_generation
              FROM backlink_commercial_inventory_policies
             WHERE (organization_id,workspace_id,website_project_id,
                    project_context_version_id)=($1,$2,$3,$4)
          )
         ORDER BY job.created_at DESC,job.id DESC
        LIMIT 1
     ),
     budget AS (
       SELECT COALESCE(bool_or(
         limit_micros-spent_micros-reserved_micros >= $6
       ),false) value
       FROM backlink_provider_budgets
       WHERE organization_id=$1 AND workspace_id=$2
         AND provider='dataforseo'
         AND period_start<=$5 AND period_end>$5
     ),
      current_batch AS (
        SELECT batch.status,batch.pause_reason,
               batch.raw_candidate_count,batch.eligible_candidate_count,
              (
                EXISTS (
                  SELECT 1
                    FROM backlink_provider_usage_ledger AS usage
                   WHERE (usage.organization_id,usage.workspace_id,
                          usage.website_project_id)=($1,$2,$3)
                     AND usage.provider='dataforseo'
                     AND usage.reservation_key LIKE
                         regexp_replace(
                           batch.idempotency_key,
                           '^commercial-discovery:',
                           ''
                         )||':%'
                     AND usage.status='reserved'
                )
                OR EXISTS (
                  SELECT 1
                    FROM provider_batch_requests AS request
                   WHERE (request.organization_id,request.workspace_id,
                          request.website_project_id)=($1,$2,$3)
                     AND request.request_id LIKE
                         regexp_replace(
                           batch.idempotency_key,
                           '^commercial-discovery:',
                           ''
                         )||':%'
                     AND request.status IN ('running','unknown_charge')
                )
                OR EXISTS (
                  SELECT 1
                    FROM provider_fetch_leases AS lease
                   WHERE lease.owner_request_id LIKE
                         regexp_replace(
                           batch.idempotency_key,
                           '^commercial-discovery:',
                           ''
                         )||':%'
                     AND (
                       lease.status='unknown_charge'
                       OR (
                         lease.status='acquired'
                         AND lease.lease_expires_at>now()
                       )
                     )
                )
              ) provider_unresolved
          FROM backlink_commercial_discovery_batches AS batch
          JOIN backlink_commercial_discovery_blueprints AS blueprint
            ON (
              blueprint.organization_id,blueprint.workspace_id,
              blueprint.website_project_id,blueprint.id
            )=(
              batch.organization_id,batch.workspace_id,
              batch.website_project_id,batch.blueprint_id
            )
          JOIN backlink_commercial_inventory_policies AS policy
           ON (
             policy.organization_id,policy.workspace_id,
             policy.website_project_id,policy.project_context_version_id
           )=(
             batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.project_context_version_id
           )
        WHERE (batch.organization_id,batch.workspace_id,
               batch.website_project_id)=($1,$2,$3)
          AND batch.project_context_version_id=$4
           AND batch.visible_pool_generation=policy.visible_pool_generation
           AND batch.refill_tier=policy.current_refill_tier
           AND batch.refill_round=policy.current_refill_round
           AND blueprint.blueprint_version=${commercialDiscoveryBlueprintVersion}
         ORDER BY batch.started_at DESC,batch.id DESC
        LIMIT 1
     )
     SELECT
       context.canonical_domain "canonicalDomain",
       context.locale,
       context.country_code "countryCode",
       context.profile_version_id "profileVersionId",
       context.promotion_target_version_id "promotionTargetVersionId",
       (
         jsonb_array_length(context.products)>0
         AND jsonb_array_length(context.target_urls)>0
       ) "projectContextReady",
       policy.candidate_low_watermark "candidateLowWatermark",
       policy.candidate_high_watermark "candidateHighWatermark",
       policy.published_contact_ready_low_watermark
         "publishedLowWatermark",
       policy.published_contact_ready_high_watermark
         "publishedHighWatermark",
       policy.minimum_email_hit_rate::double precision
         "minimumEmailHitRate",
       policy.maximum_email_hit_rate::double precision
         "maximumEmailHitRate",
       policy.refill_state "refillState",
       policy.current_refill_tier "currentRefillTier",
       policy.current_refill_round "currentRefillRound",
       policy.attempted_refill_tiers "attemptedRefillTiers",
       policy.termination_reason "terminationReason",
       policy.visible_pool_generation "visiblePoolGeneration",
       policy.visible_pool_state "visiblePoolState",
       policy.visible_pool_target_count "visiblePoolTargetCount",
       COALESCE(candidate_counts.candidate_ready_count,0)
         "candidateReadyCount",
       COALESCE(candidate_counts.historical_candidate_count,0)
         "historicalCandidateCount",
       COALESCE(candidate_counts.raw_candidate_count,0)
         "rawCandidateCount",
       elimination_reasons.value "eliminationReasonCounts",
       COALESCE(publication_counts.published_count,0)
         "publishedContactReadyCount",
       COALESCE(publication_counts.historical_verified_email_count,0)
         "historicalVerifiedEmailCount",
       inflight.value "inflight",
       contact_pending.value "contactPending",
       budget.value "budgetAvailable",
       current_batch.status "currentBatchStatus",
       current_batch.pause_reason "currentBatchPauseReason",
       current_batch.raw_candidate_count "currentBatchRawCandidateCount",
       current_batch.eligible_candidate_count
         "currentBatchEligibleCandidateCount",
       current_batch.provider_unresolved "currentBatchProviderUnresolved",
       latest_job.status "latestJobStatus"
     FROM backlink_project_context_snapshots AS context
     JOIN backlink_commercial_inventory_policies AS policy
       ON (policy.organization_id,policy.workspace_id,
           policy.website_project_id,policy.project_context_version_id)=
          (context.organization_id,context.workspace_id,
           context.website_project_id,context.id)
     CROSS JOIN candidate_counts
     CROSS JOIN elimination_reasons
     CROSS JOIN publication_counts
     CROSS JOIN inflight
     CROSS JOIN contact_pending
     CROSS JOIN budget
     LEFT JOIN current_batch ON true
     LEFT JOIN latest_job ON true
     WHERE (context.organization_id,context.workspace_id,
            context.website_project_id,context.id)=($1,$2,$3,$4)
       AND context.project_status='ACTIVE'`,
    [
      ...scopeValues,
      input.now,
      input.estimatedCostMicros,
    ],
  );
  const row = state.rows[0];
  if (row === undefined) {
    throw new Error("COMMERCIAL_INVENTORY_ACTIVE_CONTEXT_NOT_FOUND");
  }

  const policy = {
    candidateLowWatermark: integer(row.candidateLowWatermark),
    candidateHighWatermark: integer(row.candidateHighWatermark),
    publishedLowWatermark: commercialSupplyPublishedTarget - 1,
    publishedHighWatermark: commercialSupplyPublishedTarget,
    minimumEmailHitRate: number(row.minimumEmailHitRate, 0.1),
    maximumEmailHitRate: number(row.maximumEmailHitRate, 0.8),
  };
  const publishableCount = integer(row.publishedContactReadyCount);
  const visiblePoolGeneration = positiveInteger(row.visiblePoolGeneration, 1);
  const visiblePoolTargetCount = positiveInteger(
    row.visiblePoolTargetCount,
    commercialSupplyPublishedTarget,
  );
  const rawCandidateCount = integer(row.rawCandidateCount);
  const eliminationReasonCounts = record(row.eliminationReasonCounts);
  const tier = refillTier(row.currentRefillTier);
  const round = positiveInteger(row.currentRefillRound, 1);
  let attempts = parseCommercialRefillAttempts(row.attemptedRefillTiers);
  const currentBatchTerminal =
    row.currentBatchStatus === "completed"
    || (
      ["failed", "unavailable"].includes(String(row.currentBatchStatus))
      && row.latestJobStatus === "failed"
      && row.currentBatchProviderUnresolved !== true
    );
  if (currentBatchTerminal) {
    const currentWindow = attempts
      .filter((attempt) =>
        attempt.tier === tier
        && attempt.round === round
        && attempt.eligibleCandidateCount === undefined
      )
      .reduce(
        (maximum, attempt) => Math.max(maximum, attempt.window),
        0,
      );
    if (currentWindow > 0) {
      attempts = recordCommercialRefillAttemptOutcome(attempts, {
        tier,
        round,
        window: currentWindow,
        rawCandidateCount: integer(row.currentBatchRawCandidateCount),
        eligibleCandidateCount: integer(
          row.currentBatchEligibleCandidateCount,
        ),
      });
    }
  }
  const effectiveDecision = (active: boolean, inflight: boolean) =>
    decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: integer(row.candidateReadyCount),
      publishedContactReadyCount: publishableCount,
      historicalVerifiedEmailCount: integer(row.historicalVerifiedEmailCount),
      historicalCandidateCount: integer(row.historicalCandidateCount),
      refillCycleActive: active,
      inflight,
      cooldownActive: false,
      // The single operation can continue from the local resource library
      // while the paid provider is paused.
      budgetAvailable: true,
    });

  if (row.projectContextReady !== true) {
    const decision = effectiveDecision(false, false);
    await updateCycleState(client, {
      scopeValues,
      state: "paused",
      tier,
      round,
      attempts,
      terminationReason: "PROJECT_CONTEXT",
      pauseReason: "project_context",
      publishableCount,
      rawCandidateCount,
      eliminationReasonCounts,
      now: input.now,
      actorId: input.actorId,
      visiblePoolGeneration,
    });
    return Object.freeze({
      status: "paused",
      pauseReason: "project_context",
      requestedCandidateCount: 0,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: "PROJECT_CONTEXT",
    });
  }

  if (
    publishableCount >= visiblePoolTargetCount
    && row.inflight !== true
    && row.contactPending !== true
  ) {
    const decision = effectiveDecision(false, false);
    await updateCycleState(client, {
      scopeValues,
      state: "completed",
      tier,
      round,
      attempts,
      terminationReason: "HIGH_WATERMARK",
      pauseReason: null,
      publishableCount,
      rawCandidateCount,
      eliminationReasonCounts,
      now: input.now,
      actorId: input.actorId,
      visiblePoolGeneration,
      visiblePoolState: "active",
    });
    return Object.freeze({
      status: "idle",
      pauseReason: null,
      requestedCandidateCount: 0,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: "HIGH_WATERMARK",
    });
  }

  if (row.visiblePoolState === "active") {
    const decision = effectiveDecision(false, false);
    return Object.freeze({
      status: "idle",
      pauseReason: null,
      requestedCandidateCount: 0,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: "HIGH_WATERMARK",
    });
  }
  if (row.visiblePoolState === "awaiting_refresh") {
    const decision = effectiveDecision(false, false);
    return Object.freeze({
      status: "idle",
      pauseReason: null,
      requestedCandidateCount: 0,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: null,
    });
  }

  const persistedTermination = terminationReason(row.terminationReason);
  const operationAlreadyExists =
    row.inflight === true || row.contactPending === true;
  if (operationAlreadyExists) {
    const decision = effectiveDecision(true, true);
    const pauseReason = persistedTermination === "BUDGET"
      ? "budget" as const
      : persistedTermination === "PROVIDER_UNAVAILABLE"
        ? "provider_unavailable" as const
        : persistedTermination === "TIERS_EXHAUSTED"
          ? "tiers_exhausted" as const
          : "inflight" as const;
    return Object.freeze({
      status: "paused",
      pauseReason,
      requestedCandidateCount: decision.requestedCandidateCount,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: persistedTermination,
    });
  }

  if (persistedTermination === "TIERS_EXHAUSTED") {
    const decision = effectiveDecision(true, false);
    return Object.freeze({
      status: "paused",
      pauseReason: "tiers_exhausted",
      requestedCandidateCount: decision.requestedCandidateCount,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: persistedTermination,
    });
  }

  const decision = effectiveDecision(true, false);
  const requestedCandidateCount = Math.min(
    input.candidateLimit,
    decision.requestedCandidateCount,
  );
  if (!decision.shouldRefill || requestedCandidateCount === 0) {
    const normalizedPauseReason = decision.pauseReason === "budget"
      ? "budget" as const
      : decision.pauseReason === "inflight"
        ? "inflight" as const
        : null;
    const reason = normalizedPauseReason === "budget" ? "BUDGET" : null;
    await updateCycleState(client, {
      scopeValues,
      state: reason === null ? "idle" : "paused",
      tier,
      round,
      attempts,
      terminationReason: reason,
      pauseReason: normalizedPauseReason,
      publishableCount,
      rawCandidateCount,
      eliminationReasonCounts,
      now: input.now,
      actorId: input.actorId,
      visiblePoolGeneration,
    });
    return Object.freeze({
      status: reason === null ? "idle" : "paused",
      pauseReason: normalizedPauseReason,
      requestedCandidateCount,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: reason,
    });
  }

  const boundedRequest = Math.max(2, requestedCandidateCount);
  const window = nextCommercialRefillWindow(attempts, tier, round);
  const refillWindowKey = buildCommercialRefillWindowKey({
    websiteProjectId: input.websiteProjectId,
    projectContextVersionId: input.projectContextVersionId,
    visiblePoolGeneration,
    tier,
    round,
    window,
  });
  const lowWatermark = Math.max(0, visiblePoolTargetCount - 1);
  const highWatermark = visiblePoolTargetCount;
  const command = await createRecommendationCommands(client).requestRefill({
    context: {
      actor: createActorContext({
        userId: input.actorId,
        sessionId: "local-product-commercial-inventory",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
      }),
      project: createProjectContext({
        websiteProjectId: input.websiteProjectId,
        canonicalDomain: String(row.canonicalDomain),
        locale: String(row.locale),
        countryCode: String(row.countryCode),
        profileVersionId: String(row.profileVersionId),
        promotionTargetVersionId: String(row.promotionTargetVersionId),
      }),
    },
    requestId: `recommendation-refill:${refillWindowKey}`,
    expectedVersion: 0,
    recommendationContextVersionId: input.projectContextVersionId,
    visiblePoolGeneration,
    lowWatermark,
    highWatermark,
    refillWindowKey,
    triggerReason: "inventory_low",
  });
  attempts = appendAttempt(attempts, tier, round, window);
  await updateCycleState(client, {
    scopeValues,
    state: "running",
    tier,
    round,
    attempts,
    terminationReason: null,
    pauseReason: null,
    publishableCount,
    rawCandidateCount,
    eliminationReasonCounts,
    now: input.now,
    actorId: input.actorId,
    visiblePoolGeneration,
    visiblePoolState: "building",
  });
  return Object.freeze({
    status: "queued",
    jobId: command.jobId,
    requestedCandidateCount: boundedRequest,
    effectiveEmailHitRate: decision.effectiveEmailHitRate,
    currentTier: tier,
    currentRound: round,
    terminationReason: null,
  });
}
