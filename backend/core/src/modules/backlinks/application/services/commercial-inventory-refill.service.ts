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
  hasCommercialRefillAttempt,
  isCommercialRefillTier,
  nextCommercialRefillWindow,
  parseCommercialRefillWindowKey,
  parseCommercialRefillAttempts,
  recordCommercialRefillAttemptOutcome,
  resolveCommercialSupplyPublishedTarget,
  type CommercialRefillAttempt,
  type CommercialRefillTier,
} from "../../domain/recommendations/commercial-refill-cycle.js";
import {
  ensureProviderBudgetCycle,
} from "../../db/repositories/provider-budget.repository.js";
import {
  applyProviderBudgetAutomaticOverage,
  type ProviderOperationBudgetGrant,
} from "../../domain/recommendations/provider-operation-budget.js";

export type CommercialInventoryRefillClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export async function hasRecoverableAcceptedCommercialRecommendationRefill(
  client: CommercialInventoryRefillClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    projectContextVersionId: string;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
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
         JOIN backlink_commercial_inventory_policies AS policy
           ON (
             policy.organization_id,policy.workspace_id,
             policy.website_project_id,policy.project_context_version_id
           )=(
             refill.organization_id,refill.workspace_id,
             refill.website_project_id,
             refill.recommendation_context_version_id
           )
          AND policy.visible_pool_generation=refill.visible_pool_generation
         JOIN backlink_commercial_discovery_batches AS batch
           ON (
             batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.refill_job_id
           )=(
             job.organization_id,job.workspace_id,
             job.website_project_id,job.id
           )
          AND batch.project_context_version_id=
              refill.recommendation_context_version_id
          AND batch.visible_pool_generation=refill.visible_pool_generation
         JOIN provider_batch_requests AS request
           ON (
             request.organization_id,request.workspace_id,
             request.website_project_id
           )=(
             batch.organization_id,batch.workspace_id,
             batch.website_project_id
           )
          AND request.request_id LIKE refill.refill_window_key||':%'
          AND request.budget_reservation_id LIKE
              'commercial-refill-operation:'||job.id::text||
              ':discovery:'||refill.refill_window_key||':%'
          AND request.created_at>=job.created_at
         JOIN backlink_provider_requests AS provider_request
           ON (
             provider_request.organization_id,
             provider_request.workspace_id,
             provider_request.website_project_id,
             provider_request.id
           )=(
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )
         JOIN backlink_commercial_discovery_blueprints AS blueprint
           ON (
             blueprint.organization_id,blueprint.workspace_id,
             blueprint.website_project_id,
             blueprint.project_context_version_id
           )=(
             job.organization_id,job.workspace_id,
             job.website_project_id,
             refill.recommendation_context_version_id
           )
          AND blueprint.id::text=
              provider_request.request_payload
                #>>'{__growthosDiscoveryPlannerLineage,blueprintId}'
         JOIN backlink_provider_usage_ledger AS usage
           ON (
             usage.organization_id,usage.workspace_id,
             usage.website_project_id,usage.provider_request_id
           )=(
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )
          AND usage.provider='dataforseo'
          AND usage.reservation_key=request.budget_reservation_id
          AND usage.status='reserved'
         JOIN provider_fetch_leases AS lease
           ON lease.artifact_fingerprint=request.normalized_request_hash
          AND lease.owner_request_id=request.request_id
        WHERE (
          refill.organization_id,refill.workspace_id,
          refill.website_project_id,
          refill.recommendation_context_version_id
        )=($1,$2,$3,$4)
          AND job.status='failed'
          AND job.retry_count<6
          AND request.provider_task_id IS NOT NULL
          AND provider_request.request_payload
                #>>'{__growthosDiscoveryPlannerLineage,queryId}'
              ~'^[0-9a-f]{64}$'
          AND NOT EXISTS (
            SELECT 1
              FROM backlink_commercial_discovery_batches AS conflicting
             WHERE (
               conflicting.organization_id,conflicting.workspace_id,
               conflicting.website_project_id
             )=(
               job.organization_id,job.workspace_id,
               job.website_project_id
             )
               AND conflicting.project_context_version_id=
                   refill.recommendation_context_version_id
               AND conflicting.visible_pool_generation=
                   refill.visible_pool_generation
               AND conflicting.idempotency_key=
                   'commercial-discovery:'||refill.refill_window_key
               AND conflicting.refill_job_id<>job.id
          )
          AND (
            (
              request.status='running'
              AND provider_request.status='running'
              AND lease.status='acquired'
              AND lease.lease_expires_at<=now()
            )
            OR (
              request.status='unknown_charge'
              AND provider_request.status='unknown_charge'
              AND lease.status='unknown_charge'
            )
          )
     ) AS recoverable`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
    ],
  );
  return result.rows[0]?.recoverable === true;
}

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
      | "awaiting_authorization"
      | "budget"
      | "project_context"
      | "provider_unavailable"
      | "incompatible_generation"
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

function isProviderBudgetPause(value: unknown): boolean {
  return [
    "budget_or_endpoint_allowlist",
    "Data provider quota is exceeded",
    "Data provider budget is exceeded",
  ].includes(String(value));
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
    absoluteBudgetMicros: number;
    maxPaidCalls: number;
    providerBudgetGrant: ProviderOperationBudgetGrant;
    candidateLimit: number;
    now: Date;
  }>,
): Promise<CommercialInventoryRefillResult> {
  if (
    !Number.isSafeInteger(input.estimatedCostMicros)
    || input.estimatedCostMicros <= 0
    || !Number.isSafeInteger(input.absoluteBudgetMicros)
    || input.absoluteBudgetMicros < input.estimatedCostMicros
    || !Number.isSafeInteger(input.maxPaidCalls)
    || input.maxPaidCalls < 1
    || input.providerBudgetGrant.provider !== "dataforseo"
    || input.providerBudgetGrant.maxCostMicros !== input.absoluteBudgetMicros
    || input.providerBudgetGrant.maxPaidCalls !== input.maxPaidCalls
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
  const automaticBudgetLimitMicros = applyProviderBudgetAutomaticOverage(
    input.absoluteBudgetMicros,
  );
  const automaticPaidCallLimit = applyProviderBudgetAutomaticOverage(
    input.maxPaidCalls,
  );
  const authorizationState = await client.query(
    `SELECT refill_state "refillState",pause_reason "pauseReason",
            termination_reason "terminationReason",
            minimum_email_hit_rate::double precision "minimumEmailHitRate",
            current_refill_tier "currentRefillTier",
            current_refill_round "currentRefillRound"
       FROM backlink_commercial_inventory_policies
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)
      FOR UPDATE`,
    scopeValues,
  );
  const authorizationRow = authorizationState.rows[0];
  if (
    authorizationRow?.refillState === "paused"
    && authorizationRow.pauseReason === "awaiting_authorization"
  ) {
    await client.query(
      `UPDATE backlink_commercial_inventory_policies
          SET refill_state='idle',termination_reason=NULL,pause_reason=NULL,
              next_refill_at=NULL,updated_at=now(),updated_by=$5,
              version=version+1
        WHERE (organization_id,workspace_id,website_project_id,
               project_context_version_id)=($1,$2,$3,$4)
          AND refill_state='paused'
          AND pause_reason='awaiting_authorization'`,
      [...scopeValues, input.actorId],
    );
  }
  await ensureProviderBudgetCycle(client, {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    provider: "dataforseo",
    limitMicros: automaticBudgetLimitMicros,
    createdBy: input.actorId,
    observedAt: input.now,
  });
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
  const state = await client.query(
    `WITH candidate_counts AS (
       SELECT
         count(*) FILTER (
           WHERE state IN ('candidate_ready','contact_enrichment')
             AND score_model_version='recommendation-commercial-fit.v4'
             AND commercial_score->>'decision'='eligible'
         )::integer candidate_ready_count,
         count(*) FILTER (
           WHERE state<>'stale_context'
             AND score_model_version='recommendation-commercial-fit.v4'
         )::integer historical_candidate_count,
         count(*) FILTER (
           WHERE score_model_version='recommendation-commercial-fit.v4'
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
            AND score_model_version='recommendation-commercial-fit.v4'
            AND state IN ('excluded','insufficient_data','manual_review')
          GROUP BY 1
       ) reasons
     ),
     generation_contract AS (
       SELECT contract.id
         FROM backlink_recommendation_generation_contracts AS contract
        WHERE (
          contract.organization_id,contract.workspace_id,
          contract.website_project_id,
          contract.recommendation_context_version_id
        )=($1,$2,$3,$4)
          AND contract.visible_pool_generation=(
            SELECT visible_pool_generation
              FROM backlink_commercial_inventory_policies
             WHERE (organization_id,workspace_id,website_project_id,
                    project_context_version_id)=($1,$2,$3,$4)
          )
          AND contract.qualification_contract_version=
            'recommendation-qualification.v1'
          AND contract.visibility_contract_version=
            'recommendation-visibility.v1'
          AND contract.score_model_version=
            'recommendation-commercial-fit.v4'
        LIMIT 1
     ),
     occupied_generation_contract AS (
       SELECT contract.id
         FROM backlink_recommendation_generation_contracts AS contract
        WHERE (
          contract.organization_id,contract.workspace_id,
          contract.website_project_id,
          contract.recommendation_context_version_id
        )=($1,$2,$3,$4)
          AND contract.visible_pool_generation=(
            SELECT visible_pool_generation
              FROM backlink_commercial_inventory_policies
             WHERE (organization_id,workspace_id,website_project_id,
                    project_context_version_id)=($1,$2,$3,$4)
          )
        LIMIT 1
     ),
     publication_counts AS (
       SELECT count(*) FILTER (
                WHERE inventory.publication_status='PUBLISHED'
                  AND inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v4'
                  AND inventory.status IN ('ready','shown','accepted')
                  AND recommendation.status IN ('ready','shown','accepted')
              )::integer published_count,
              count(*) FILTER (
                WHERE inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v4'
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
     corrected_visibility_counts AS (
       SELECT count(*)::integer visible_count
         FROM (
           SELECT DISTINCT ON (qualification.canonical_domain)
                  qualification.id,qualification.canonical_domain,
                  qualification.decision
             FROM backlink_recommendation_qualification_facts
               AS qualification
            WHERE qualification.generation_contract_id=(
                    SELECT id FROM generation_contract
                  )
              AND (
                qualification.organization_id,
                qualification.workspace_id,
                qualification.website_project_id,
                qualification.recommendation_context_version_id
              )=($1,$2,$3,$4)
              AND qualification.recommendation_id IS NOT NULL
            ORDER BY qualification.canonical_domain,
                     qualification.attempt DESC,
                     qualification.observed_at DESC,
                     qualification.id DESC
         ) AS qualification
         JOIN LATERAL (
           SELECT visibility.decision
             FROM backlink_recommendation_visibility_facts AS visibility
            WHERE visibility.generation_contract_id=(
                    SELECT id FROM generation_contract
                  )
              AND (
                visibility.organization_id,visibility.workspace_id,
                visibility.website_project_id,
                visibility.recommendation_context_version_id,
                visibility.qualification_fact_id
              )=($1,$2,$3,$4,qualification.id)
            ORDER BY visibility.attempt DESC,
                     visibility.observed_at DESC,
                     visibility.id DESC
            LIMIT 1
         ) AS visibility ON true
        WHERE qualification.decision='eligible'
          AND visibility.decision='visible'
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
     budget AS (
       SELECT COALESCE(bool_or(
         budget.limit_micros-budget.spent_micros-budget.reserved_micros >= $6
         AND (
           SELECT count(*)
             FROM backlink_provider_usage_ledger AS usage
            WHERE (
              usage.organization_id,usage.workspace_id,
              usage.website_project_id
            )=($1,$2,$3)
              AND usage.budget_id=budget.id
              AND usage.provider='dataforseo'
              AND usage.status IN ('reserved','settled')
         ) < $8
       ),false) value
       FROM backlink_provider_budgets AS budget
       WHERE budget.organization_id=$1 AND budget.workspace_id=$2
         AND budget.provider='dataforseo'
         AND budget.period_start<=$5 AND budget.period_end>$5
         AND budget.limit_micros=$7
     ),
      current_batch AS (
        SELECT batch.status,batch.pause_reason,job.status AS job_status,
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
          JOIN backlink_jobs AS job
            ON (
              job.organization_id,job.workspace_id,
              job.website_project_id,job.id
            )=(
              batch.organization_id,batch.workspace_id,
              batch.website_project_id,batch.refill_job_id
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
     ),
     latest_refill_job AS (
       SELECT job.step,job.result_summary
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
          refill.website_project_id,refill.recommendation_context_version_id
        )=($1,$2,$3,$4)
          AND refill.visible_pool_generation=(
            SELECT visible_pool_generation
              FROM backlink_commercial_inventory_policies
             WHERE (organization_id,workspace_id,website_project_id,
                    project_context_version_id)=($1,$2,$3,$4)
          )
        ORDER BY refill.created_at DESC,refill.id DESC
        LIMIT 1
     ),
     occupied_refill_windows AS (
       SELECT COALESCE(
                jsonb_agg(occupied.refill_window_key),
                '[]'::jsonb
              ) value
         FROM (
           SELECT refill.refill_window_key
             FROM backlink_recommendation_refills AS refill
            WHERE (
              refill.organization_id,refill.workspace_id,
              refill.website_project_id,
              refill.recommendation_context_version_id
            )=($1,$2,$3,$4)
              AND refill.visible_pool_generation=(
                SELECT visible_pool_generation
                  FROM backlink_commercial_inventory_policies
                 WHERE (organization_id,workspace_id,website_project_id,
                        project_context_version_id)=($1,$2,$3,$4)
              )
           UNION
           SELECT regexp_replace(
                    idempotency.idempotency_key,
                    '^recommendation-refill:',
                    ''
                  )
             FROM backlink_idempotency_records AS idempotency
            WHERE (
              idempotency.organization_id,idempotency.workspace_id,
              idempotency.website_project_id
            )=($1,$2,$3)
              AND idempotency.command_type='recommendation.refill'
              AND idempotency.idempotency_key LIKE
                  'recommendation-refill:commercial-refill:'||
                  $3::text||':'||$4::text||':%'
         ) AS occupied
     )
     SELECT
       context.canonical_domain "canonicalDomain",
       context.locale,
       context.country_code "countryCode",
       context.profile_version_id "profileVersionId",
       context.promotion_target_version_id "promotionTargetVersionId",
       (
         jsonb_array_length(context.products)>0
         OR jsonb_array_length(context.keywords)>0
       ) "projectContextReady",
       policy.candidate_low_watermark "candidateLowWatermark",
       policy.candidate_high_watermark "candidateHighWatermark",
       0 "publishedLowWatermark",
       policy.visible_pool_target_count "publishedHighWatermark",
       policy.minimum_email_hit_rate::double precision
         "minimumEmailHitRate",
       policy.maximum_email_hit_rate::double precision
         "maximumEmailHitRate",
       policy.refill_state "refillState",
       policy.current_refill_tier "currentRefillTier",
       policy.current_refill_round "currentRefillRound",
       policy.attempted_refill_tiers "attemptedRefillTiers",
       policy.termination_reason "terminationReason",
       policy.pause_reason "pauseReason",
       policy.visible_pool_generation "visiblePoolGeneration",
       policy.visible_pool_state "visiblePoolState",
       policy.visible_pool_target_count "visiblePoolTargetCount",
       CASE
         WHEN generation_contract.id IS NOT NULL
           THEN 'corrected_visibility_v1'
         WHEN occupied_generation_contract.id IS NOT NULL
           THEN 'incompatible_generation'
         ELSE 'candidate_visibility_v1'
       END "contractKind",
       COALESCE(candidate_counts.candidate_ready_count,0)
         "candidateReadyCount",
       COALESCE(candidate_counts.historical_candidate_count,0)
         "historicalCandidateCount",
       COALESCE(candidate_counts.raw_candidate_count,0)
         "rawCandidateCount",
       elimination_reasons.value "eliminationReasonCounts",
       COALESCE(publication_counts.published_count,0)
         "publishedVisibleCount",
       COALESCE(corrected_visibility_counts.visible_count,0)
         "visibleMatchCount",
       COALESCE(publication_counts.historical_verified_email_count,0)
         "historicalVerifiedEmailCount",
       inflight.value "inflight",
       budget.value "budgetAvailable",
       current_batch.status "currentBatchStatus",
       current_batch.pause_reason "currentBatchPauseReason",
       current_batch.raw_candidate_count "currentBatchRawCandidateCount",
       current_batch.eligible_candidate_count
         "currentBatchEligibleCandidateCount",
       current_batch.provider_unresolved "currentBatchProviderUnresolved",
       current_batch.job_status "latestJobStatus",
       latest_refill_job.step "latestRefillStep",
       latest_refill_job.result_summary->>'terminalReason'
         "latestRefillTerminalReason",
       occupied_refill_windows.value "occupiedRefillWindowKeys"
     FROM backlink_project_context_snapshots AS context
     JOIN backlink_commercial_inventory_policies AS policy
       ON (policy.organization_id,policy.workspace_id,
           policy.website_project_id,policy.project_context_version_id)=
          (context.organization_id,context.workspace_id,
           context.website_project_id,context.id)
     CROSS JOIN candidate_counts
     CROSS JOIN elimination_reasons
     CROSS JOIN publication_counts
     CROSS JOIN corrected_visibility_counts
     CROSS JOIN inflight
     CROSS JOIN budget
     CROSS JOIN occupied_refill_windows
     LEFT JOIN generation_contract ON true
     LEFT JOIN occupied_generation_contract ON true
     LEFT JOIN current_batch ON true
     LEFT JOIN latest_refill_job ON true
     WHERE (context.organization_id,context.workspace_id,
            context.website_project_id,context.id)=($1,$2,$3,$4)
       AND context.project_status='ACTIVE'`,
    [
      ...scopeValues,
      input.now,
      input.estimatedCostMicros,
      automaticBudgetLimitMicros,
      automaticPaidCallLimit,
    ],
  );
  const row = state.rows[0];
  if (row === undefined) {
    throw new Error("COMMERCIAL_INVENTORY_ACTIVE_CONTEXT_NOT_FOUND");
  }

  const publishableCount = row.contractKind === "corrected_visibility_v1"
    ? integer(row.visibleMatchCount)
    : row.contractKind === "candidate_visibility_v1"
      ? integer(row.candidateReadyCount)
      : 0;
  const visiblePoolGeneration = positiveInteger(row.visiblePoolGeneration, 1);
  const visiblePoolTargetCount = resolveCommercialSupplyPublishedTarget(
    process.env.BACKLINK_RECOMMENDATION_POOL_TARGET_COUNT
      ?? row.visiblePoolTargetCount,
  );
  const policy = {
    candidateLowWatermark: integer(row.candidateLowWatermark),
    candidateHighWatermark: integer(row.candidateHighWatermark),
    publishedLowWatermark: 0,
    publishedHighWatermark: visiblePoolTargetCount,
    minimumEmailHitRate: number(row.minimumEmailHitRate, 0.1),
    maximumEmailHitRate: number(row.maximumEmailHitRate, 0.8),
  };
  const rawCandidateCount = integer(row.rawCandidateCount);
  const eliminationReasonCounts = record(row.eliminationReasonCounts);
  const tier = refillTier(row.currentRefillTier);
  const round = positiveInteger(row.currentRefillRound, 1);
  let attempts = parseCommercialRefillAttempts(row.attemptedRefillTiers);
  const settledBudgetPause =
    row.currentBatchStatus === "paused"
    && isProviderBudgetPause(row.currentBatchPauseReason)
    && row.latestJobStatus === "partial_success"
    && row.currentBatchProviderUnresolved !== true;
  const recoveredBudgetPause =
    settledBudgetPause && row.budgetAvailable === true;
  const terminalProviderFailure =
    ["failed", "unavailable"].includes(String(row.currentBatchStatus))
    && row.latestJobStatus === "failed"
    && row.currentBatchProviderUnresolved !== true;
  const currentBatchTerminal =
    row.currentBatchStatus === "completed"
    || recoveredBudgetPause
    || terminalProviderFailure;
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
      publishedVisibleCount: publishableCount,
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
  const existingEvidenceTermination =
    persistedTermination === "TIERS_EXHAUSTED"
    && ["existing_evidence_completed", "existing_evidence_no_progress"]
      .includes(String(row.latestRefillStep))
    && [
      "EXISTING_EVIDENCE_WINDOW_COMPLETED",
      "EXISTING_EVIDENCE_NO_PROGRESS",
    ].includes(String(row.latestRefillTerminalReason));
  const operationAlreadyExists = row.inflight === true;
  if (
    row.visiblePoolState === "building"
    && row.contractKind === "incompatible_generation"
  ) {
    const decision = effectiveDecision(true, operationAlreadyExists);
    if (operationAlreadyExists) {
      return Object.freeze({
        status: "paused",
        pauseReason: "inflight",
        requestedCandidateCount: decision.requestedCandidateCount,
        effectiveEmailHitRate: decision.effectiveEmailHitRate,
        currentTier: tier,
        currentRound: round,
        terminationReason: null,
      });
    }
    if (
      row.refillState !== "paused"
      || row.pauseReason !== "incompatible_generation"
      || persistedTermination !== null
    ) {
      await updateCycleState(client, {
        scopeValues,
        state: "paused",
        tier,
        round,
        attempts,
        terminationReason: null,
        pauseReason: "incompatible_generation",
        publishableCount,
        rawCandidateCount,
        eliminationReasonCounts,
        now: input.now,
        actorId: input.actorId,
        visiblePoolGeneration,
      });
    }
    return Object.freeze({
      status: "paused",
      pauseReason: "incompatible_generation",
      requestedCandidateCount: decision.requestedCandidateCount,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: null,
    });
  }
  const acceptedProviderRecoveryAvailable =
    await hasRecoverableAcceptedCommercialRecommendationRefill(client, input);
  if (terminalProviderFailure && !acceptedProviderRecoveryAvailable) {
    const decision = effectiveDecision(true, false);
    if (
      persistedTermination !== "PROVIDER_UNAVAILABLE"
      || row.refillState !== "paused"
    ) {
      await updateCycleState(client, {
        scopeValues,
        state: "paused",
        tier,
        round,
        attempts,
        terminationReason: "PROVIDER_UNAVAILABLE",
        pauseReason: "provider_unavailable",
        publishableCount,
        rawCandidateCount,
        eliminationReasonCounts,
        now: input.now,
        actorId: input.actorId,
        visiblePoolGeneration,
      });
    }
    return Object.freeze({
      status: "paused",
      pauseReason: "provider_unavailable",
      requestedCandidateCount: Math.min(
        input.candidateLimit,
        decision.requestedCandidateCount,
      ),
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: "PROVIDER_UNAVAILABLE",
    });
  }
  if (
    settledBudgetPause
    && row.budgetAvailable !== true
    && !acceptedProviderRecoveryAvailable
  ) {
    const decision = effectiveDecision(true, false);
    return Object.freeze({
      status: "paused",
      pauseReason: "budget",
      requestedCandidateCount: Math.min(
        input.candidateLimit,
        decision.requestedCandidateCount,
      ),
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: "BUDGET",
    });
  }
  if (
    persistedTermination === "PROVIDER_UNAVAILABLE"
    && !acceptedProviderRecoveryAvailable
  ) {
    const decision = effectiveDecision(true, false);
    return Object.freeze({
      status: "paused",
      pauseReason: "provider_unavailable",
      requestedCandidateCount: Math.min(
        input.candidateLimit,
        decision.requestedCandidateCount,
      ),
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
      currentTier: tier,
      currentRound: round,
      terminationReason: persistedTermination,
    });
  }
  if (operationAlreadyExists && !acceptedProviderRecoveryAvailable) {
    const decision = effectiveDecision(true, true);
    const pauseReason = persistedTermination === "BUDGET"
      ? "budget" as const
      : persistedTermination === "TIERS_EXHAUSTED"
          && !existingEvidenceTermination
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

  if (
    persistedTermination === "TIERS_EXHAUSTED"
    && !existingEvidenceTermination
  ) {
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
  if (
    (!decision.shouldRefill || requestedCandidateCount === 0)
    && !acceptedProviderRecoveryAvailable
  ) {
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
  const nextAttemptWindow = nextCommercialRefillWindow(attempts, tier, round);
  const occupiedWindow = (
    Array.isArray(row.occupiedRefillWindowKeys)
      ? row.occupiedRefillWindowKeys
      : []
  ).reduce((maximum: number, value: unknown) => {
    if (typeof value !== "string") return maximum;
    const parsed = parseCommercialRefillWindowKey(value);
    return parsed !== null
      && parsed.visiblePoolGeneration === visiblePoolGeneration
      && parsed.tier === tier
      && parsed.round === round
      ? Math.max(maximum, parsed.window)
      : maximum;
  }, 0);
  const window = acceptedProviderRecoveryAvailable
    ? nextAttemptWindow
    : Math.max(nextAttemptWindow, occupiedWindow + 1);
  const refillWindowKey = buildCommercialRefillWindowKey({
    websiteProjectId: input.websiteProjectId,
    projectContextVersionId: input.projectContextVersionId,
    visiblePoolGeneration,
    tier,
    round,
    window,
  });
  const lowWatermark = 0;
  const highWatermark = visiblePoolTargetCount;
  const recovery = await client.query(
    `WITH accepted_recovery AS MATERIALIZED (
       SELECT DISTINCT
              refill.id::text AS "operationId",
              request.id AS "providerRequestId",
              request.request_id AS "ownerRequestId",
              request.normalized_request_hash AS "artifactFingerprint"
         FROM backlink_recommendation_refills AS refill
         JOIN backlink_jobs AS job
           ON (
             job.organization_id,job.workspace_id,
             job.website_project_id,job.id
           )=(
             refill.organization_id,refill.workspace_id,
             refill.website_project_id,refill.job_id
           )
         JOIN backlink_commercial_discovery_batches AS batch
           ON (
             batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.refill_job_id
           )=(
             job.organization_id,job.workspace_id,
             job.website_project_id,job.id
           )
          AND batch.project_context_version_id=$4
          AND batch.visible_pool_generation=$5
         JOIN provider_batch_requests AS request
           ON (
             request.organization_id,request.workspace_id,
             request.website_project_id
           )=(
             batch.organization_id,batch.workspace_id,
             batch.website_project_id
           )
          AND request.request_id LIKE
              regexp_replace(
                batch.idempotency_key,
                '^commercial-discovery:',
                ''
              )||':%'
         JOIN backlink_provider_requests AS provider_request
           ON (
             provider_request.organization_id,
             provider_request.workspace_id,
             provider_request.website_project_id,
             provider_request.id
           )=(
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )
         JOIN backlink_provider_usage_ledger AS usage
           ON (
             usage.organization_id,usage.workspace_id,
             usage.website_project_id,usage.provider_request_id
           )=(
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )
          AND usage.provider='dataforseo'
          AND usage.reservation_key=request.budget_reservation_id
          AND usage.status='reserved'
         JOIN provider_fetch_leases AS lease
           ON lease.artifact_fingerprint=request.normalized_request_hash
          AND lease.owner_request_id=request.request_id
        WHERE (
          refill.organization_id,refill.workspace_id,
          refill.website_project_id,
          refill.recommendation_context_version_id
        )=($1,$2,$3,$4)
          AND refill.visible_pool_generation=$5
          AND job.status='failed'
          AND job.retry_count<6
          AND request.provider_task_id IS NOT NULL
          AND (
            (
              request.status='running'
              AND provider_request.status='running'
              AND lease.status='acquired'
              AND lease.lease_expires_at<=now()
            )
            OR (
              request.status='unknown_charge'
              AND provider_request.status='unknown_charge'
              AND lease.status='unknown_charge'
            )
          )
     ),
     completed_provider_checkpoint AS MATERIALIZED (
       SELECT DISTINCT refill.id::text AS "operationId"
         FROM backlink_recommendation_refills AS refill
         JOIN backlink_jobs AS job
           ON (
             job.organization_id,job.workspace_id,
             job.website_project_id,job.id
           )=(
             refill.organization_id,refill.workspace_id,
             refill.website_project_id,refill.job_id
           )
         JOIN backlink_commercial_discovery_batches AS batch
           ON (
             batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.refill_job_id
           )=(
             job.organization_id,job.workspace_id,
             job.website_project_id,job.id
           )
          AND batch.project_context_version_id=$4
          AND batch.visible_pool_generation=$5
         JOIN provider_batch_requests AS request
           ON (
             request.organization_id,request.workspace_id,
             request.website_project_id
           )=(
             batch.organization_id,batch.workspace_id,
             batch.website_project_id
           )
          AND request.request_id LIKE
              regexp_replace(
                batch.idempotency_key,
                '^commercial-discovery:',
                ''
              )||':%'
         JOIN backlink_provider_requests AS provider_request
           ON (
             provider_request.organization_id,
             provider_request.workspace_id,
             provider_request.website_project_id,
             provider_request.id
           )=(
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )
         JOIN backlink_provider_usage_ledger AS usage
           ON (
             usage.organization_id,usage.workspace_id,
             usage.website_project_id,usage.provider_request_id
           )=(
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )
          AND usage.provider='dataforseo'
          AND usage.reservation_key=request.budget_reservation_id
         JOIN provider_fetch_leases AS lease
           ON lease.artifact_fingerprint=request.normalized_request_hash
          AND lease.owner_request_id=request.request_id
        WHERE (
          refill.organization_id,refill.workspace_id,
          refill.website_project_id,
          refill.recommendation_context_version_id
        )=($1,$2,$3,$4)
          AND refill.visible_pool_generation=$5
          AND job.status='failed'
          AND job.retry_count=6
          AND COALESCE((
            job.result_summary
              ->>'completedProviderCheckpointRecoveryAttempted'
          )::boolean,false)=false
          AND request.status='succeeded'
          AND provider_request.status='succeeded'
          AND request.provider_task_id IS NOT NULL
          AND request.actual_cost_micros IS NOT NULL
          AND usage.status='settled'
          AND lease.status='completed'
     ),
     accepted_summary AS (
       SELECT count(DISTINCT "operationId")::integer AS operation_count,
              min("operationId") AS "operationId"
         FROM accepted_recovery
     ),
     unowned_provider AS (
       SELECT (
         EXISTS (
           SELECT 1
             FROM provider_batch_requests AS request
            WHERE (request.organization_id,request.workspace_id,
                   request.website_project_id)=($1,$2,$3)
              AND request.request_id LIKE
                  'commercial-refill:'||$3::text||':'||$4::text||
                  ':g'||$5::text||':%'
              AND request.status IN ('running','unknown_charge')
              AND NOT EXISTS (
                SELECT 1
                  FROM accepted_recovery AS accepted
                 WHERE accepted."providerRequestId"=request.id
              )
         )
         OR EXISTS (
           SELECT 1
             FROM backlink_provider_usage_ledger AS usage
            WHERE (usage.organization_id,usage.workspace_id,
                   usage.website_project_id)=($1,$2,$3)
              AND usage.provider='dataforseo'
              AND usage.reservation_key LIKE
                  'commercial-refill:'||$3::text||':'||$4::text||
                  ':g'||$5::text||':%'
              AND usage.status='reserved'
              AND NOT EXISTS (
                SELECT 1
                  FROM accepted_recovery AS accepted
                 WHERE accepted."providerRequestId"=
                       usage.provider_request_id
              )
         )
         OR EXISTS (
           SELECT 1
             FROM provider_fetch_leases AS lease
            WHERE lease.owner_request_id LIKE
                  'commercial-refill:'||$3::text||':'||$4::text||
                  ':g'||$5::text||':%'
              AND lease.status IN ('acquired','unknown_charge')
              AND NOT EXISTS (
                SELECT 1
                  FROM accepted_recovery AS accepted
                 WHERE accepted."ownerRequestId"=lease.owner_request_id
                   AND accepted."artifactFingerprint"=
                       lease.artifact_fingerprint
              )
         )
       ) AS value
     ),
     exact_recovery AS (
       SELECT count(*)::integer AS operation_count,
              min(refill.id::text) AS "operationId"
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
        AND job.status='failed'
        AND (
          job.retry_count<6
          OR (
            job.retry_count=6
            AND COALESCE((
              job.result_summary
                ->>'completedProviderCheckpointRecoveryAttempted'
            )::boolean,false)=false
            AND EXISTS (
              SELECT 1
                FROM completed_provider_checkpoint AS completed
               WHERE completed."operationId"=refill.id::text
            )
          )
        )
     )
     SELECT CASE
              WHEN accepted.operation_count=1
                AND unowned.value=false
                THEN accepted."operationId"
              WHEN accepted.operation_count=0
                AND unowned.value=false
                AND exact.operation_count=1
                THEN exact."operationId"
              ELSE NULL
            END AS "operationId",
            accepted.operation_count AS "acceptedOperationCount",
            unowned.value AS "hasUnownedProvider"
       FROM accepted_summary AS accepted
       CROSS JOIN unowned_provider AS unowned
       CROSS JOIN exact_recovery AS exact`,
    [
      ...scopeValues,
      visiblePoolGeneration,
      refillWindowKey,
    ],
  );
  const recoveryRow = recovery.rows[0];
  const acceptedOperationCount = integer(
    recoveryRow?.acceptedOperationCount,
  );
  if (
    acceptedOperationCount > 1
    || recoveryRow?.hasUnownedProvider === true
  ) {
    throw new Error("BACKLINK_PROVIDER_RECOVERY_LINEAGE_AMBIGUOUS");
  }
  const operationId = recoveryRow?.operationId;
  if (
    acceptedProviderRecoveryAvailable
    && typeof operationId !== "string"
  ) {
    throw new Error("BACKLINK_PROVIDER_RECOVERY_STATE_CHANGED");
  }
  const command = await createRecommendationCommands(client, {
    persistentProviderBudgetGrant: input.providerBudgetGrant,
  }).requestRefill({
    context: {
      actor: createActorContext({
        userId: input.actorId,
        sessionId: "product-commercial-inventory",
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
    ...(typeof operationId === "string" ? { operationId } : {}),
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
