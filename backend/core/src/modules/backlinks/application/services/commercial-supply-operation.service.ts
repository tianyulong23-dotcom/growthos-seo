import { commercialRecommendationFitRuleVersion } from "../../domain/recommendations/commercial-score-v4.js";
import { commercialDiscoveryBlueprintVersion } from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  buildCommercialRefillWindowKey,
  isCommercialPaidRefillTier,
  parseCommercialRefillAttempts,
  parseCommercialRefillWindowKey,
  planCommercialSupplyOperation,
  recordCommercialRefillAttemptOutcome,
  type CommercialPaidRefillTier,
  type CommercialRefillAttempt,
  type CommercialSupplyOutcome,
  type CommercialSupplyPlan,
  type CommercialSupplyProviderState,
} from "../../domain/recommendations/commercial-refill-cycle.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
} from "../../ports/recommendation-contract.port.js";
import {
  commercialSemanticDiscoveryPaidCallReserve,
  resolveProviderOperationBudgetWindow,
  type ProviderOperationBudgetAuthorization,
  type ProviderOperationBudgetWindow,
} from "../../domain/recommendations/provider-operation-budget.js";
import { reassessCurrentCommercialCandidates } from "./current-commercial-candidate-reassessment.service.js";
import { prepareCurrentCommercialCandidateEnrichment } from "./current-commercial-candidate-enrichment.service.js";
import { commercialQualificationBulkEndpoints } from "./commercial-qualification-bulk.service.js";
import {
  currentCommercialStaticAssessmentRecoveryContractVersion,
  maximumCurrentCommercialStaticAssessmentRecoveryAttempts,
} from "./current-commercial-static-assessment-recovery.service.js";

export type CommercialSupplyOperationClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type CommercialSupplyOperationStep =
  | Readonly<{
      status: "execute";
      source: "paid" | "resource" | "existing";
      refillWindowKey: string;
      refillTier: string;
      refillRound: number;
      refillWindow: number;
      requestedCandidateCount: number;
    }>
  | Readonly<{
      status: "wait";
      outcome: Exclude<
        CommercialSupplyOutcome,
        "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED"
      > | null;
      reason: "budget" | "provider" | "project_context";
      retryAfterMs: number;
      publishedCount: number;
    }>
  | Readonly<{
      status: "complete";
      outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED";
      publishedCount: number;
    }>;

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function paidTier(value: unknown): CommercialPaidRefillTier {
  return isCommercialPaidRefillTier(value)
    ? value
    : "exact_product_target_market";
}

const semanticDiscoveryNotPlannedReason =
  "semantic_discovery_not_planned_endpoint_allowlist";

function semanticDiscoveryNotPlanned(
  row: Readonly<Record<string, unknown>>,
): boolean {
  return String(row.pauseReason) === semanticDiscoveryNotPlannedReason;
}

function enrichAttempts(
  attempts: readonly CommercialRefillAttempt[],
  rows: readonly Record<string, unknown>[],
): readonly CommercialRefillAttempt[] {
  return rows.reduce((current, row) => {
    const key = String(row.idempotencyKey ?? "").replace(
      /^commercial-discovery:/u,
      "",
    );
    const parsed = parseCommercialRefillWindowKey(key);
    const status = String(row.status);
    const sourceTypes = Array.isArray(row.sourceTypes)
      ? row.sourceTypes.map(String)
      : [];
    const semanticDiscoveryCompleted =
      sourceTypes.includes("BLUEPRINT_SERP_STANDARD_QUEUE");
    const reconciledWithoutResult =
      ["paused", "unavailable"].includes(status) &&
      String(row.pauseReason) === "DATAFORSEO_RECONCILED_NO_RESULT";
    const settledWithoutSemanticProviderCall =
      ["completed", "paused"].includes(status)
      && semanticDiscoveryNotPlanned(row);
    if (
      parsed === null ||
      (
        status !== "completed"
        && !reconciledWithoutResult
        && !settledWithoutSemanticProviderCall
      ) ||
      (
        isCommercialPaidRefillTier(parsed.tier) &&
        !semanticDiscoveryCompleted &&
        !settledWithoutSemanticProviderCall
      )
    ) {
      return current;
    }
    return recordCommercialRefillAttemptOutcome(current, {
      tier: parsed.tier,
      round: parsed.round,
      window: parsed.window,
      rawCandidateCount: nonNegativeInteger(row.rawCandidateCount),
      eligibleCandidateCount: nonNegativeInteger(row.eligibleCandidateCount),
    });
  }, attempts);
}

const providerRetryDelayMs = 60_000;
const commercialQualificationPaidCallCount = Object.keys(
  commercialQualificationBulkEndpoints,
).length;

function completedSemanticDiscoveryBatch(
  row: Readonly<Record<string, unknown>>,
): boolean {
  if (String(row.status) !== "completed") return false;
  const parsed = parseCommercialRefillWindowKey(
    String(row.idempotencyKey ?? "").replace(/^commercial-discovery:/u, ""),
  );
  return parsed !== null
    && isCommercialPaidRefillTier(parsed.tier)
    && Array.isArray(row.sourceTypes)
    && row.sourceTypes.map(String).includes(
      "BLUEPRINT_SERP_STANDARD_QUEUE",
    );
}

function pausedForBudget(reason: unknown): boolean {
  const normalized = String(reason ?? "").toLowerCase();
  return ["budget", "quota", "max_paid", "paid_call", "call_limit"].some(
    (marker) => normalized.includes(marker),
  );
}

export function resolveCommercialSupplyProviderState(
  input: Readonly<{
    budgetAvailable: boolean;
    operationAuthorized?: boolean;
    operationBudgetAvailable?: boolean;
    acceptedProviderRecoveryPending: boolean;
    batches: readonly Record<string, unknown>[];
    now: Date;
  }>,
): CommercialSupplyProviderState {
  if (input.acceptedProviderRecoveryPending) {
    return "available";
  }
  if (
    input.operationAuthorized === true
    && input.operationBudgetAvailable === false
  ) {
    return "budget_paused";
  }
  if (!input.budgetAvailable && input.operationAuthorized !== true) {
    return "budget_paused";
  }
  for (let index = input.batches.length - 1; index >= 0; index -= 1) {
    const batch = input.batches[index];
    if (batch === undefined) continue;
    const parsed = parseCommercialRefillWindowKey(
      String(batch.idempotencyKey ?? "").replace(/^commercial-discovery:/u, ""),
    );
    if (
      parsed === null ||
      !isCommercialPaidRefillTier(parsed.tier) ||
      !["paused", "unavailable"].includes(String(batch.status)) ||
      semanticDiscoveryNotPlanned(batch)
    ) {
      continue;
    }
    const finishedAt = new Date(String(batch.finishedAt ?? "")).getTime();
    if (
      Number.isFinite(finishedAt) &&
      input.now.getTime() - finishedAt >= providerRetryDelayMs
    ) {
      return "available";
    }
    return pausedForBudget(batch.pauseReason)
      ? "budget_paused"
      : "provider_paused";
  }
  return "available";
}

function providerState(
  row: Readonly<Record<string, unknown>>,
  batches: readonly Record<string, unknown>[],
  now: Date,
  operationAuthorized: boolean,
  operationBudgetAvailable: boolean,
): CommercialSupplyProviderState {
  return resolveCommercialSupplyProviderState({
    budgetAvailable: row.budgetAvailable === true,
    operationAuthorized,
    operationBudgetAvailable,
    acceptedProviderRecoveryPending: batches.some(
      (batch) => batch.acceptedProviderRecoveryPending === true,
    ),
    batches,
    now,
  });
}

function operationBudgetWindow(
  row: Readonly<Record<string, unknown>>,
  input: Readonly<{
    providerBudgetAuthorization:
      | ProviderOperationBudgetAuthorization
      | undefined;
    estimatedCostMicros: number;
    requiredPaidCalls: number;
  }>,
): ProviderOperationBudgetWindow | null {
  const authorization = input.providerBudgetAuthorization;
  if (
    authorization === undefined
    || nonNegativeInteger(row.operationUnknownChargeCount) > 0
  ) {
    return null;
  }
  return resolveProviderOperationBudgetWindow({
    authorization,
    paidCallCount: nonNegativeInteger(row.operationPaidCallCount),
    exposureMicros: nonNegativeInteger(row.operationExposureMicros),
    requiredPaidCalls: input.requiredPaidCalls,
    requiredCostMicros:
      input.requiredPaidCalls * input.estimatedCostMicros,
  });
}

function operationBudgetSupportsPaidCalls(
  row: Readonly<Record<string, unknown>>,
  input: Readonly<{
    providerBudgetAuthorization:
      | ProviderOperationBudgetAuthorization
      | undefined;
    estimatedCostMicros: number;
    requiredPaidCalls: number;
  }>,
): boolean {
  const window = operationBudgetWindow(row, input);
  return window !== null
    && nonNegativeInteger(row.operationPaidCallCount)
      + input.requiredPaidCalls <= window.maxPaidCalls
    && nonNegativeInteger(row.operationExposureMicros)
      + input.requiredPaidCalls * input.estimatedCostMicros
      <= window.maxCostMicros;
}

export async function planCommercialSupplyOperationStep(
  client: CommercialSupplyOperationClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    jobId: string;
    actorId: string;
    targetPublishedCount: number;
    candidateLimit: number;
    estimatedCostMicros: number;
    providerOperationId?: string;
    providerBudgetAuthorization?: ProviderOperationBudgetAuthorization;
    supplyMode?: "existing_evidence";
    now: Date;
  }>,
): Promise<CommercialSupplyOperationStep> {
  const scope = [
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
    [...scope, input.actorId],
  );
  await reassessCurrentCommercialCandidates(client, input);
  const operationUsageCte = input.supplyMode === "existing_evidence"
    ? `SELECT 0::integer "operationPaidCallCount",
              0::bigint "operationExposureMicros",
              0::integer "operationUnknownChargeCount",
              false "operationAcceptedProviderRecoveryPending"`
    : `SELECT count(*) FILTER (
                WHERE usage.status IN ('reserved','settled')
              )::integer "operationPaidCallCount",
              COALESCE(sum(
                CASE
                  WHEN usage.status='settled'
                    THEN COALESCE(
                      usage.actual_cost_micros,
                      usage.estimated_cost_micros
                    )
                  WHEN usage.status='reserved'
                    THEN usage.estimated_cost_micros
                  ELSE 0
                END
              ),0)::bigint "operationExposureMicros",
              count(*) FILTER (
                WHERE request.status='unknown_charge'
              )::integer "operationUnknownChargeCount",
              COALESCE(bool_or(
                batch_request.endpoint=
                    '/v3/serp/google/organic/task_post'
                AND (
                  (
                    batch_request.status='running'
                    AND request.status='running'
                    AND lease.status='acquired'
                    AND lease.lease_expires_at<=$5
                  )
                  OR (
                    batch_request.status='unknown_charge'
                    AND request.status='unknown_charge'
                    AND lease.status='unknown_charge'
                  )
                )
              ),false) "operationAcceptedProviderRecoveryPending"
         FROM backlink_provider_usage_ledger AS usage
         JOIN backlink_provider_requests AS request
           ON (
             request.organization_id,request.workspace_id,
             request.website_project_id,request.id
           )=(
             usage.organization_id,usage.workspace_id,
             usage.website_project_id,usage.provider_request_id
           )
         LEFT JOIN provider_batch_requests AS batch_request
           ON (
             batch_request.organization_id,batch_request.workspace_id,
             batch_request.website_project_id,batch_request.id
           )=(
             usage.organization_id,usage.workspace_id,
             usage.website_project_id,usage.provider_request_id
           )
         LEFT JOIN provider_fetch_leases AS lease
           ON lease.artifact_fingerprint=
                batch_request.normalized_request_hash
          AND lease.owner_request_id=batch_request.request_id
        WHERE (
          usage.organization_id,usage.workspace_id,
          usage.website_project_id
        )=($1,$2,$3)
          AND usage.provider='dataforseo'
          AND usage.reservation_key LIKE $12 || ':%'`;
  const state = await client.query(
    `WITH candidate_counts AS (
       SELECT count(*) FILTER (
                WHERE score_model_version=
                  'recommendation-commercial-fit.v4'
              )::integer "rawCandidateCount",
              count(*) FILTER (
                WHERE score_model_version=
                    'recommendation-commercial-fit.v4'
                  AND commercial_score->>'decision'='eligible'
              )::integer "fitCandidateCount"
              ,count(*) FILTER (
                WHERE score_model_version=
                    'recommendation-commercial-fit.v4'
                  AND commercial_score->>'ruleVersion'=$8
                  AND (
                    (
                      commercial_score->>'decision'='eligible'
                      AND state='candidate_ready'
                    )
                    OR state='enrichment_eligible'
                  )
               )::integer "readyFitCandidateCount"
              ,count(*) FILTER (
                WHERE score_model_version=
                    'recommendation-commercial-fit.v4'
                  AND recommendation_id IS NULL
                  AND prospect_id IS NULL
                  AND state IN ('insufficient_data','manual_review')
                  AND static_assessment->>'decision'='insufficient_data'
                  AND jsonb_typeof(
                    static_assessment->'failedUrls'
                  )='array'
                  AND jsonb_array_length(
                    static_assessment->'failedUrls'
                  )>0
                  AND CASE
                        WHEN static_assessment
                               #>>'{recovery,contractVersion}'=$15
                         AND static_assessment
                               #>>'{recovery,attemptCount}' ~ '^[0-9]+$'
                          THEN (
                            static_assessment
                              #>>'{recovery,attemptCount}'
                          )::integer
                        ELSE 0
                      END < $14
                  AND (
                    static_assessment
                      #>>'{recovery,contractVersion}' IS DISTINCT FROM $15
                    OR (
                      static_assessment
                        #>>'{recovery,contractVersion}'=$15
                      AND (
                        COALESCE(
                          static_assessment#>>'{recovery,status}',
                          ''
                        ) NOT IN (
                          'running','retry_scheduled','completed',
                          'manual_review','exhausted'
                        )
                        OR (
                          static_assessment
                            #>>'{recovery,status}'='running'
                          AND NULLIF(
                                static_assessment
                                  #>>'{recovery,leaseExpiresAt}',
                                ''
                              )::timestamptz <= $5
                        )
                        OR (
                          static_assessment
                            #>>'{recovery,status}'='retry_scheduled'
                          AND NULLIF(
                                static_assessment
                                  #>>'{recovery,nextRetryAt}',
                                ''
                              )::timestamptz <= $5
                        )
                      )
                    )
                  )
              )::integer "recoverableStaticAssessmentCount"
         FROM backlink_commercial_candidates
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
          AND project_context_version_id=$4
          AND visible_pool_generation=$9
     ),
     publication_counts AS (
       SELECT count(*) FILTER (
                WHERE inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v4'
                  AND inventory.contact_decision='eligible'
                  AND inventory.verified_public_email_count>=1
              )::integer "contactReadyCount",
               count(*) FILTER (
                 WHERE inventory.fit_decision='eligible'
                   AND inventory.fit_score_model_version=
                     'recommendation-commercial-fit.v4'
                   AND inventory.status IN ('ready','shown','accepted')
                   AND recommendation.status IN ('ready','shown','accepted')
               )::integer "publishedCount"
         FROM backlink_recommendation_inventory AS inventory
         JOIN backlink_recommendations AS recommendation
           ON (
             recommendation.organization_id,recommendation.workspace_id,
             recommendation.website_project_id,recommendation.id
           )=(
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id,inventory.recommendation_id
           )
        WHERE (
          inventory.organization_id,inventory.workspace_id,
          inventory.website_project_id
        )=($1,$2,$3)
          AND inventory.recommendation_context_version_id=$4
          AND inventory.visible_pool_generation=$9
     ),
     budget AS (
       SELECT COALESCE(bool_or(
         limit_micros-spent_micros-reserved_micros >= $6
       ),false) "budgetAvailable"
         FROM backlink_provider_budgets
        WHERE organization_id=$1 AND workspace_id=$2
          AND provider='dataforseo'
          AND period_start<=$5 AND period_end>$5
     ),
     operation_usage AS (
       ${operationUsageCte}
     )
     SELECT (
              jsonb_array_length(context.products)>0
              OR jsonb_array_length(context.keywords)>0
            ) "projectContextReady",
            policy.current_refill_tier "currentRefillTier",
            policy.current_refill_round "currentRefillRound",
            policy.paid_refill_tier "paidRefillTier",
            policy.paid_refill_round "paidRefillRound",
            policy.resource_refill_tier "resourceRefillTier",
            policy.resource_refill_round "resourceRefillRound",
            policy.attempted_refill_tiers "attemptedRefillTiers",
            policy.termination_reason "terminationReason",
             policy.visible_pool_generation "visiblePoolGeneration",
             policy.visible_pool_state "visiblePoolState",
             input_pin.immutable_fingerprint "generationInputFingerprint",
             job.step "jobStep",
            COALESCE(
              (job.result_summary->>'existingCandidatesCompleted')::boolean,
              false
            ) "existingCandidatesCompleted",
            candidate_counts.*,publication_counts.*,budget.*,
            operation_usage.*
       FROM backlink_project_context_snapshots AS context
        JOIN backlink_commercial_inventory_policies AS policy
         ON (
           policy.organization_id,policy.workspace_id,
           policy.website_project_id,policy.project_context_version_id
          )=(
            context.organization_id,context.workspace_id,
            context.website_project_id,context.id
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
        AND input_pin.qualification_contract_version=$10
       CROSS JOIN candidate_counts
       CROSS JOIN publication_counts
       CROSS JOIN budget
       CROSS JOIN operation_usage
       JOIN backlink_jobs AS job
         ON (
           job.organization_id,job.workspace_id,
           job.website_project_id,job.id
         )=($1,$2,$3,$7)
      WHERE (context.organization_id,context.workspace_id,
             context.website_project_id,context.id)=($1,$2,$3,$4)
        AND context.project_status='ACTIVE'
        AND policy.visible_pool_generation=$9
        AND (
          (
            $11::text='existing_evidence'
            AND $12::text IS NULL
            AND $13::jsonb IS NULL
            AND policy.visible_pool_state IN (
              'idle','building','active','awaiting_refresh'
            )
            AND NOT (job.result_summary ? 'providerOperationId')
            AND NOT (job.result_summary ? 'providerBudgetAuthorization')
            AND job.result_summary->>'supplyMode'='existing_evidence'
          )
          OR (
            $11::text='full'
            AND $12::text IS NOT NULL
            AND $13::jsonb IS NOT NULL
            AND (
              policy.visible_pool_state='building'
              OR (
                policy.visible_pool_state='active'
                AND EXISTS (
                  SELECT 1
                    FROM backlink_recommendation_generation_contracts
                         AS contract
                   WHERE (
                     contract.organization_id,contract.workspace_id,
                     contract.website_project_id,
                     contract.recommendation_context_version_id,
                     contract.visible_pool_generation
                   )=(
                     policy.organization_id,policy.workspace_id,
                     policy.website_project_id,
                     policy.project_context_version_id,
                     policy.visible_pool_generation
                   )
                     AND contract.qualification_contract_version=
                       'recommendation-qualification.v1'
                     AND contract.visibility_contract_version=
                       'recommendation-visibility.v1'
                     AND contract.score_model_version=
                       'recommendation-commercial-fit.v4'
                )
              )
            )
            AND job.result_summary->>'providerOperationId'=$12
            AND job.result_summary->'providerBudgetAuthorization'=$13::jsonb
            AND EXISTS (
              SELECT 1
                FROM backlink_commercial_supply_operations AS operation
               WHERE (
                 operation.organization_id,operation.workspace_id,
                 operation.website_project_id
               )=($1,$2,$3)
                 AND operation.id=$12
                 AND operation.project_context_version_id=$4
                 AND operation.visible_pool_generation=$9
                 AND operation.job_id=$7
                 AND operation.provider='dataforseo'
                 AND operation.authorization_snapshot=$13::jsonb
                 AND operation.status='authorized'
            )
          )
        )
        AND job.source_object_id=$4
        AND job.job_type='recommendation_refill'`,
    [
      ...scope,
      input.now,
      input.estimatedCostMicros,
      input.jobId,
      commercialRecommendationFitRuleVersion,
      input.visiblePoolGeneration,
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      input.supplyMode ?? "full",
      input.providerOperationId ?? null,
      input.providerBudgetAuthorization === undefined
        ? null
        : JSON.stringify(input.providerBudgetAuthorization),
      maximumCurrentCommercialStaticAssessmentRecoveryAttempts,
      currentCommercialStaticAssessmentRecoveryContractVersion,
    ],
  );
  const row = state.rows[0];
  if (row === undefined) {
    throw new Error("COMMERCIAL_SUPPLY_OPERATION_NOT_FOUND");
  }
  const operationAuthorized =
    input.supplyMode !== "existing_evidence"
    && input.providerOperationId !== undefined
    && input.providerBudgetAuthorization !== undefined;
  const initialOperationBudgetWindow = operationBudgetWindow(row, {
    providerBudgetAuthorization: input.providerBudgetAuthorization,
    estimatedCostMicros: input.estimatedCostMicros,
    requiredPaidCalls: 1,
  });
  const operationBudgetAvailable =
    !operationAuthorized
    || initialOperationBudgetWindow !== null
      && nonNegativeInteger(row.operationPaidCallCount) + 1
        <= initialOperationBudgetWindow.maxPaidCalls
      && nonNegativeInteger(row.operationExposureMicros)
        + input.estimatedCostMicros
        <= initialOperationBudgetWindow.maxCostMicros;
  if (input.supplyMode === "existing_evidence") {
    const publishedCount = nonNegativeInteger(row.publishedCount);
    const currentCandidates =
      nonNegativeInteger(row.rawCandidateCount) === 0
        ? null
        : await prepareCurrentCommercialCandidateEnrichment(client, {
            ...input,
            generationInputFingerprint:
              String(row.generationInputFingerprint),
            maximumCandidates: Math.min(input.candidateLimit, 25),
              apply: true,
            });
    const recoverableStaticAssessmentCount = nonNegativeInteger(
      row.recoverableStaticAssessmentCount,
    );
    const requestedCandidateCount =
      Math.min(
        input.candidateLimit,
        (currentCandidates?.publishableCandidates.length ?? 0)
          + recoverableStaticAssessmentCount,
      );
    await client.query(
      `UPDATE backlink_jobs
          SET status='running',
              step=CASE
                WHEN $5::integer>0 THEN 'existing_candidates_ready'
                ELSE 'existing_evidence_reassessed'
              END,
              progress=20,error=NULL,finished_at=NULL,updated_at=$6,
              updated_by=$7,version=version+1
        WHERE (organization_id,workspace_id,website_project_id,id)=
              ($1,$2,$3,$4)
          AND status IN ('queued','running','waiting_provider')`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.jobId,
        requestedCandidateCount,
        input.now,
        input.actorId,
      ],
    );
    if (requestedCandidateCount > 0) {
      return Object.freeze({
        status: "execute",
        source: "existing",
        refillWindowKey: [
          "commercial-existing",
          input.websiteProjectId,
          input.projectContextVersionId,
          `g${input.visiblePoolGeneration}`,
          commercialRecommendationFitRuleVersion,
        ].join(":"),
        refillTier: "existing_evidence",
        refillRound: 1,
        refillWindow: 1,
        requestedCandidateCount,
      });
    }
    return Object.freeze({
      status: "complete",
      outcome: "SUPPLY_FLOOR_REACHED",
      publishedCount,
    });
  }
  const batchResult = await client.query(
    `SELECT batch.idempotency_key "idempotencyKey",
             batch.status,batch.pause_reason "pauseReason",
             batch.source_types "sourceTypes",
             batch.finished_at "finishedAt",
             batch.raw_candidate_count "rawCandidateCount",
             batch.eligible_candidate_count "eligibleCandidateCount",
             EXISTS (
               SELECT 1
                 FROM provider_batch_requests AS request
                 JOIN backlink_provider_requests AS provider_request
                   ON (
                     provider_request.organization_id,
                     provider_request.workspace_id,
                     provider_request.website_project_id,
                     provider_request.id
                   )=(
                     request.organization_id,
                     request.workspace_id,
                     request.website_project_id,
                     request.id
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
                   ON lease.artifact_fingerprint=
                        request.normalized_request_hash
                  AND lease.owner_request_id=request.request_id
                WHERE batch.refill_job_id=$6
                  AND (
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
                   AND (
                    (
                      request.status='running'
                      AND provider_request.status='running'
                      AND lease.status='acquired'
                      AND lease.lease_expires_at<=$7
                    )
                    OR (
                      request.status='unknown_charge'
                      AND provider_request.status='unknown_charge'
                      AND lease.status='unknown_charge'
                    )
                  )
             ) "acceptedProviderRecoveryPending"
        FROM backlink_commercial_discovery_batches AS batch
        JOIN backlink_commercial_discovery_blueprints AS blueprint
         ON (
           blueprint.organization_id,blueprint.workspace_id,
           blueprint.website_project_id,blueprint.id
         )=(
           batch.organization_id,batch.workspace_id,
           batch.website_project_id,batch.blueprint_id
         )
      WHERE (batch.organization_id,batch.workspace_id,
             batch.website_project_id)=($1,$2,$3)
        AND batch.project_context_version_id=$4
        AND batch.visible_pool_generation=$5
        AND blueprint.blueprint_version=${commercialDiscoveryBlueprintVersion}
       ORDER BY batch.started_at,batch.id`,
    [
      ...scope,
      input.visiblePoolGeneration,
      input.jobId,
      input.now,
    ],
  );
  let attempts = enrichAttempts(
    parseCommercialRefillAttempts(row.attemptedRefillTiers),
    batchResult.rows,
  );
  const semanticDiscoveryCompleted = batchResult.rows.some(
    completedSemanticDiscoveryBatch,
  );
  const acceptedProviderRecoveryPending = batchResult.rows.some(
    (batch) => batch.acceptedProviderRecoveryPending === true,
  ) || row.operationAcceptedProviderRecoveryPending === true;
  const paidCursor = Object.freeze({
    tier: paidTier(
      row.paidRefillTier ??
        (isCommercialPaidRefillTier(row.currentRefillTier)
          ? row.currentRefillTier
          : undefined),
    ),
    round: positiveInteger(
      row.paidRefillRound,
      positiveInteger(row.currentRefillRound, 1),
    ),
  });
  const resourceCursor = Object.freeze({
    tier: "curated_resource_library" as const,
    round: positiveInteger(row.resourceRefillRound, paidCursor.round),
  });
  const publishedCount = nonNegativeInteger(row.publishedCount);
  const currentCandidates =
    !semanticDiscoveryCompleted
    || (
      row.existingCandidatesCompleted === true
      && nonNegativeInteger(row.readyFitCandidateCount) === 0
    )
    || nonNegativeInteger(row.rawCandidateCount) === 0
      ? null
      : await prepareCurrentCommercialCandidateEnrichment(client, {
          ...input,
          generationInputFingerprint:
            String(row.generationInputFingerprint),
          maximumCandidates: Math.min(input.candidateLimit, 25),
          apply: true,
        });
  const readyFitCandidateCount =
    !semanticDiscoveryCompleted
      ? 0
      : Math.max(
          nonNegativeInteger(row.readyFitCandidateCount),
          currentCandidates?.candidates.length ?? 0,
        );
  const resolvedProviderState = providerState(
    row,
    batchResult.rows,
    input.now,
    operationAuthorized,
    operationBudgetAvailable,
  );
  const supplyPlanInput = {
    projectContextReady: row.projectContextReady === true,
    targetPublishedCount: input.targetPublishedCount,
    publishedCount,
    rawCandidateCount: nonNegativeInteger(row.rawCandidateCount),
    fitCandidateCount: nonNegativeInteger(row.fitCandidateCount),
    contactReadyCount: nonNegativeInteger(row.contactReadyCount),
    providerState: resolvedProviderState,
    paidCursor,
    resourceCursor,
    attempts,
    candidateLimit: input.candidateLimit,
  } as const;
  const candidateProducingPlan = planCommercialSupplyOperation({
    ...supplyPlanInput,
    providerState:
      resolvedProviderState === "budget_paused"
        ? "available"
        : resolvedProviderState,
    readyFitCandidateCount: 0,
  });
  const semanticDiscoveryRequired =
    !semanticDiscoveryCompleted
    && candidateProducingPlan.kind === "execute"
    && candidateProducingPlan.source === "paid";
  const semanticDiscoveryBudgetWindow = operationBudgetWindow(row, {
    providerBudgetAuthorization: input.providerBudgetAuthorization,
    estimatedCostMicros: input.estimatedCostMicros,
    requiredPaidCalls: commercialSemanticDiscoveryPaidCallReserve,
  });
  const semanticDiscoveryBudgetAvailable =
    acceptedProviderRecoveryPending
    || semanticDiscoveryBudgetWindow !== null
      && operationBudgetSupportsPaidCalls(row, {
        providerBudgetAuthorization: input.providerBudgetAuthorization,
        estimatedCostMicros: input.estimatedCostMicros,
        requiredPaidCalls: commercialSemanticDiscoveryPaidCallReserve,
      });
  const existingQualificationRequiresProvider =
    semanticDiscoveryCompleted
    &&
    readyFitCandidateCount > 0
    && (currentCandidates?.publishableCandidates.length ?? 0) === 0;
  const existingQualificationBudgetWindow = operationBudgetWindow(row, {
    providerBudgetAuthorization: input.providerBudgetAuthorization,
    estimatedCostMicros: input.estimatedCostMicros,
    requiredPaidCalls: commercialQualificationPaidCallCount,
  });
  const existingQualificationBudgetAvailable =
    !existingQualificationRequiresProvider
    || existingQualificationBudgetWindow !== null
      && operationBudgetSupportsPaidCalls(row, {
        providerBudgetAuthorization: input.providerBudgetAuthorization,
        estimatedCostMicros: input.estimatedCostMicros,
        requiredPaidCalls: commercialQualificationPaidCallCount,
      });
  const replenishedBudgetWindow =
    semanticDiscoveryRequired
    && semanticDiscoveryBudgetWindow?.replenished === true
      ? Object.freeze({
          stage: "semantic_discovery",
          window: semanticDiscoveryBudgetWindow,
        })
      : existingQualificationRequiresProvider
        && existingQualificationBudgetWindow?.replenished === true
        ? Object.freeze({
            stage: "qualification_evidence",
            window: existingQualificationBudgetWindow,
          })
        : null;
  let stagePauseReason: string | null = null;
  let plan: CommercialSupplyPlan;
  if (semanticDiscoveryRequired && !semanticDiscoveryBudgetAvailable) {
    stagePauseReason = "semantic_discovery_budget_insufficient";
    plan = Object.freeze({
      kind: "wait",
      outcome: "PAUSED_BUDGET",
      reason: "budget",
    });
  } else if (semanticDiscoveryRequired) {
    plan = candidateProducingPlan;
  } else if (
    existingQualificationRequiresProvider
    && !existingQualificationBudgetAvailable
  ) {
    stagePauseReason = "qualification_evidence_budget_insufficient";
    plan = Object.freeze({
      kind: "wait",
      outcome: "PAUSED_BUDGET",
      reason: "budget",
    });
  } else {
    plan = planCommercialSupplyOperation({
      ...supplyPlanInput,
      readyFitCandidateCount,
    });
  }
  if (plan.kind === "execute" && plan.source !== "existing") {
    const executePlan = plan;
    const refillRows = await client.query(
      `SELECT job_id::text AS "jobId",
              refill_window_key AS "refillWindowKey"
         FROM backlink_recommendation_refills
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
          AND recommendation_context_version_id=$4
          AND visible_pool_generation=$5
        ORDER BY id
        FOR UPDATE`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.projectContextVersionId,
        input.visiblePoolGeneration,
      ],
    );
    const currentRefill = refillRows.rows.find(
      (refill) => String(refill.jobId) === input.jobId,
    );
    if (currentRefill === undefined) {
      throw new Error("COMMERCIAL_SUPPLY_REFILL_BINDING_NOT_FOUND");
    }
    const matchesPlannedScope = (refillWindowKey: unknown) => {
      const parsed = parseCommercialRefillWindowKey(
        String(refillWindowKey ?? ""),
      );
      return parsed !== null
        && parsed.websiteProjectId === input.websiteProjectId
        && parsed.projectContextVersionId === input.projectContextVersionId
        && parsed.visiblePoolGeneration === input.visiblePoolGeneration
        && parsed.tier === executePlan.cursor.tier
        && parsed.round === executePlan.cursor.round
        ? parsed
        : null;
    };
    const ownedCursor = matchesPlannedScope(currentRefill.refillWindowKey);
    const ownedAttempt =
      ownedCursor === null
        ? undefined
        : attempts.find(
            (attempt) =>
              attempt.tier === ownedCursor.tier
              && attempt.round === ownedCursor.round
              && attempt.window === ownedCursor.window,
          );
    const ownedWindow =
      ownedCursor !== null
      && ownedAttempt?.eligibleCandidateCount === undefined
        ? ownedCursor.window
        : undefined;
    let refillWindow = ownedWindow ?? executePlan.cursor.window;
    if (ownedWindow === undefined) {
      const occupiedWindows = new Set(
        [
          ...refillRows.rows.map((refill) => refill.refillWindowKey),
          ...batchResult.rows
            .filter((batch) => batch.status === "completed")
            .map((batch) =>
              String(batch.idempotencyKey ?? "").replace(
                /^commercial-discovery:/u,
                "",
              )
            ),
        ].flatMap((refillWindowKey) => {
          const parsed = matchesPlannedScope(refillWindowKey);
          return parsed === null ? [] : [parsed.window];
        }),
      );
      while (occupiedWindows.has(refillWindow)) {
        refillWindow += 1;
        if (!Number.isSafeInteger(refillWindow)) {
          throw new Error("COMMERCIAL_SUPPLY_REFILL_WINDOW_EXHAUSTED");
        }
      }
    }
    if (refillWindow !== executePlan.cursor.window) {
      plan = Object.freeze({
        ...executePlan,
        cursor: Object.freeze({
          ...executePlan.cursor,
          window: refillWindow,
        }),
      });
    }
  }

  let currentTier = String(row.currentRefillTier);
  let currentRound = positiveInteger(row.currentRefillRound, 1);
  let refillState = "running";
  let terminationReason: string | null = null;
  let pauseReason: string | null = null;
  let paid = paidCursor;
  let resource = resourceCursor;
  if (plan.kind === "execute") {
    if (plan.source !== "existing") {
      currentTier = plan.cursor.tier;
      currentRound = plan.cursor.round;
      attempts = attempts.some(
        (attempt) =>
          attempt.tier === plan.cursor.tier &&
          attempt.round === plan.cursor.round &&
          attempt.window === plan.cursor.window,
      )
        ? attempts
        : Object.freeze([
            ...attempts,
            Object.freeze({
              tier: plan.cursor.tier,
              round: plan.cursor.round,
              window: plan.cursor.window,
            }),
          ]);
      if (plan.source === "paid") {
        paid = Object.freeze({
          tier: plan.cursor.tier as CommercialPaidRefillTier,
          round: plan.cursor.round,
        });
        if (plan.cursor.round > resource.round) {
          resource = Object.freeze({
            tier: "curated_resource_library",
            round: plan.cursor.round,
          });
        }
      } else {
        resource = Object.freeze({
          tier: "curated_resource_library",
          round: plan.cursor.round,
        });
      }
    }
  } else if (plan.kind === "wait") {
    refillState = "paused";
    terminationReason =
      plan.outcome === "PAUSED_BUDGET"
        ? "BUDGET"
        : plan.outcome === "PAUSED_PROVIDER"
          ? "PROVIDER_UNAVAILABLE"
          : plan.outcome === "PROJECT_CONTEXT_REQUIRED"
            ? "PROJECT_CONTEXT"
            : null;
    pauseReason = stagePauseReason ?? plan.reason;
  } else {
    refillState = plan.outcome === "TARGET_REACHED" ? "completed" : "exhausted";
    terminationReason =
      plan.outcome === "TARGET_REACHED" ? "HIGH_WATERMARK" : "TIERS_EXHAUSTED";
    pauseReason =
      plan.outcome === "SUPPLY_FLOOR_REACHED" ? "tiers_exhausted" : null;
  }
  await client.query(
    `UPDATE backlink_commercial_inventory_policies AS policy
        SET refill_state=$5,current_refill_tier=$6,current_refill_round=$7,
            paid_refill_tier=$8,paid_refill_round=$9,
            resource_refill_tier=$10,resource_refill_round=$11,
            attempted_refill_tiers=$12::jsonb,termination_reason=$13,
            pause_reason=$14,next_refill_at=NULL,updated_at=$15,
            updated_by=$16,version=version+1
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)
        AND visible_pool_generation=$17
        AND (
          policy.visible_pool_state='building'
          OR (
            policy.visible_pool_state='active'
            AND EXISTS (
              SELECT 1
                FROM backlink_recommendation_generation_contracts AS contract
               WHERE (
                 contract.organization_id,contract.workspace_id,
                 contract.website_project_id,
                 contract.recommendation_context_version_id,
                 contract.visible_pool_generation
               )=(
                 policy.organization_id,policy.workspace_id,
                 policy.website_project_id,
                 policy.project_context_version_id,
                 policy.visible_pool_generation
               )
                 AND contract.qualification_contract_version=
                   'recommendation-qualification.v1'
                 AND contract.visibility_contract_version=
                   'recommendation-visibility.v1'
                 AND contract.score_model_version=
                   'recommendation-commercial-fit.v4'
            )
          )
        )`,
    [
      ...scope,
      refillState,
      currentTier,
      currentRound,
      paid.tier,
      paid.round,
      resource.tier,
      resource.round,
      JSON.stringify(attempts),
      terminationReason,
      pauseReason,
      input.now,
      input.actorId,
      input.visiblePoolGeneration,
    ],
  );
  if (plan.kind === "execute" && plan.source !== "existing") {
    const refillWindowKey = buildCommercialRefillWindowKey({
      websiteProjectId: input.websiteProjectId,
      projectContextVersionId: input.projectContextVersionId,
      visiblePoolGeneration: input.visiblePoolGeneration,
      tier: plan.cursor.tier,
      round: plan.cursor.round,
      window: plan.cursor.window,
    });
    await client.query(
      `UPDATE backlink_recommendation_refills
          SET refill_window_key=$6,updated_at=$7,updated_by=$8,
              version=version+1
        WHERE (organization_id,workspace_id,website_project_id,job_id)=
              ($1,$2,$3,$4)
          AND recommendation_context_version_id=$5
          AND visible_pool_generation=$9
          AND refill_window_key<>$6`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.jobId,
        input.projectContextVersionId,
        refillWindowKey,
        input.now,
        input.actorId,
        input.visiblePoolGeneration,
      ],
    );
  }
  const providerBudgetWindowAudit =
    replenishedBudgetWindow === null
      ? null
      : JSON.stringify({
          reasonCode: input.providerBudgetAuthorization?.reasonCode,
          stage: replenishedBudgetWindow.stage,
          maxPaidCalls: replenishedBudgetWindow.window.maxPaidCalls,
          maxCostMicros: replenishedBudgetWindow.window.maxCostMicros,
          observedPaidCallCount:
            nonNegativeInteger(row.operationPaidCallCount),
          observedExposureMicros:
            nonNegativeInteger(row.operationExposureMicros),
          replenishedAt: input.now.toISOString(),
        });
  await client.query(
    `UPDATE backlink_jobs
        SET status=CASE
              WHEN $5 IN ('budget','provider','project_context')
                THEN 'waiting_provider'
              ELSE 'running'
            END,
            step=CASE
              WHEN $5='existing' THEN 'existing_candidates_ready'
              WHEN $5='budget' THEN 'paused_budget'
              WHEN $5='provider' THEN 'paused_provider'
              WHEN $5='project_context' THEN 'paused_project_context'
              ELSE 'supply_planned'
            END,
            progress=20,
            result_summary=COALESCE(result_summary,'{}'::jsonb)
              || CASE
                   WHEN $6::text IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object(
                     'outcome',$6::text,'reason',$5::text
                   )
                 END
              || CASE
                   WHEN $9::text IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('stageReason',$9::text)
                 END
              || CASE
                   WHEN $10::jsonb IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object(
                     'providerBudgetWindow',$10::jsonb
                   )
                 END,
            error=NULL,finished_at=NULL,updated_at=$7,updated_by=$8,
            version=version+1
      WHERE (organization_id,workspace_id,website_project_id,id)=
            ($1,$2,$3,$4)
        AND status IN ('queued','running','waiting_provider')`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.jobId,
      plan.kind === "execute"
        ? plan.source
        : plan.kind === "wait"
          ? plan.reason
          : "complete",
      plan.kind === "wait" ? plan.outcome : null,
      input.now,
      input.actorId,
      stagePauseReason,
      providerBudgetWindowAudit,
    ],
  );
  if (plan.kind === "execute") {
    return Object.freeze({
      status: "execute",
      source: plan.source,
      refillWindowKey:
        plan.source === "existing"
          ? [
              "commercial-existing",
              input.websiteProjectId,
              input.projectContextVersionId,
              `g${input.visiblePoolGeneration}`,
              commercialRecommendationFitRuleVersion,
            ].join(":")
          : buildCommercialRefillWindowKey({
              websiteProjectId: input.websiteProjectId,
              projectContextVersionId: input.projectContextVersionId,
              visiblePoolGeneration: input.visiblePoolGeneration,
              tier: plan.cursor.tier,
              round: plan.cursor.round,
              window: plan.cursor.window,
            }),
      refillTier: plan.cursor.tier,
      refillRound: plan.cursor.round,
      refillWindow: plan.cursor.window,
      requestedCandidateCount: plan.requestedCandidateCount,
    });
  }
  return plan.kind === "wait"
    ? Object.freeze({
        status: "wait",
        outcome: plan.outcome,
        reason: plan.reason,
        retryAfterMs: 60_000,
        publishedCount,
      })
    : Object.freeze({
        status: "complete",
        outcome: plan.outcome,
        publishedCount,
      });
}

export async function completeCommercialSupplyOperation(
  client: CommercialSupplyOperationClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    jobId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    actorId: string;
    outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED" | "PAUSED_BUDGET";
    terminalReason?:
      | "EXISTING_EVIDENCE_WINDOW_COMPLETED"
      | "EXISTING_EVIDENCE_NO_PROGRESS";
    targetPublishedCount: number;
    publishedCount: number;
    addedCount: number;
    evaluatedCount: number;
    excludedCount: number;
    insufficientDataCount: number;
    now: Date;
  }>,
): Promise<void> {
  const targetReached =
    input.outcome === "TARGET_REACHED" &&
    input.publishedCount >= input.targetPublishedCount;
  const existingEvidenceTerminal = input.terminalReason !== undefined;
  const activateVisiblePool =
    targetReached
    || (existingEvidenceTerminal && input.publishedCount > 0);
  const result = await client.query(
    `UPDATE backlink_jobs
        SET status=$5,step=$6,progress=$7,error=NULL,
            result_summary=COALESCE(result_summary,'{}'::jsonb)
              || $8::jsonb,finished_at=$9,updated_at=$9,
            updated_by=$10,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4
        AND status IN ('queued','running','waiting_provider')
      RETURNING id`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.jobId,
      targetReached ? "success" : "partial_success",
      targetReached
        ? "target_reached"
        : input.terminalReason === "EXISTING_EVIDENCE_WINDOW_COMPLETED"
          ? "existing_evidence_completed"
          : input.terminalReason === "EXISTING_EVIDENCE_NO_PROGRESS"
            ? "existing_evidence_no_progress"
        : input.outcome === "PAUSED_BUDGET"
          ? "paused_budget"
          : "supply_below_target",
      targetReached ? 100 : 99,
      JSON.stringify({
        outcome: input.outcome,
        ...(input.terminalReason === undefined
          ? {}
          : { terminalReason: input.terminalReason }),
        targetPublishedCount: input.targetPublishedCount,
        publishedCount: input.publishedCount,
        addedCount: input.addedCount,
        evaluatedCount: input.evaluatedCount,
        excludedCount: input.excludedCount,
        insufficientDataCount: input.insufficientDataCount,
      }),
      input.now,
      input.actorId,
    ],
  );
  if (result.rows[0] === undefined) {
    throw new Error("COMMERCIAL_SUPPLY_OPERATION_JOB_STATE_CONFLICT");
  }
  await client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET visible_pool_state=CASE
              WHEN $6::boolean THEN 'active'
              WHEN $7::boolean THEN 'idle'
              ELSE visible_pool_state
            END,
            refill_state=CASE
              WHEN $7::boolean THEN 'completed'
              WHEN $8::boolean THEN 'idle'
              ELSE refill_state
            END,
            termination_reason=CASE
              WHEN $7::boolean THEN 'HIGH_WATERMARK'
              WHEN $8::boolean THEN NULL
              ELSE termination_reason
            END,
            pause_reason=CASE
              WHEN $8::boolean THEN NULL
              ELSE pause_reason
            END,
            updated_at=$9,updated_by=$10,version=version+1
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)
        AND visible_pool_generation=$5
        AND visible_pool_state='building'`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
      input.visiblePoolGeneration,
      activateVisiblePool,
      targetReached,
      existingEvidenceTerminal,
      input.now,
      input.actorId,
    ],
  );
}
