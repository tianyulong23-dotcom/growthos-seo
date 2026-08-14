import { commercialRecommendationFitRuleVersion } from "../../domain/recommendations/commercial-score-v3.js";
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
  type CommercialSupplyProviderState,
} from "../../domain/recommendations/commercial-refill-cycle.js";
import { reassessCurrentCommercialCandidates } from "./current-commercial-candidate-reassessment.service.js";

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
      reason: "contact_processing" | "budget" | "provider" | "project_context";
      retryAfterMs: number;
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
    const reconciledWithoutResult =
      ["paused", "unavailable"].includes(status) &&
      String(row.pauseReason) === "DATAFORSEO_RECONCILED_NO_RESULT";
    if (
      parsed === null ||
      (status !== "completed" && !reconciledWithoutResult)
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

function pausedForBudget(reason: unknown): boolean {
  const normalized = String(reason ?? "").toLowerCase();
  return ["budget", "quota", "max_paid", "paid_call", "call_limit"].some(
    (marker) => normalized.includes(marker),
  );
}

export function resolveCommercialSupplyProviderState(
  input: Readonly<{
    budgetAvailable: boolean;
    batches: readonly Record<string, unknown>[];
    now: Date;
  }>,
): CommercialSupplyProviderState {
  if (!input.budgetAvailable) {
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
      !["paused", "unavailable"].includes(String(batch.status))
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
): CommercialSupplyProviderState {
  return resolveCommercialSupplyProviderState({
    budgetAvailable: row.budgetAvailable === true,
    batches,
    now,
  });
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
  const state = await client.query(
    `WITH candidate_counts AS (
       SELECT count(*) FILTER (
                WHERE score_model_version=
                  'recommendation-commercial-fit.v3'
              )::integer "rawCandidateCount",
              count(*) FILTER (
                WHERE score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND commercial_score->>'decision'='eligible'
              )::integer "fitCandidateCount"
              ,count(*) FILTER (
                WHERE score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND commercial_score->>'ruleVersion'=$8
                  AND commercial_score->>'decision'='eligible'
                  AND state='candidate_ready'
              )::integer "readyFitCandidateCount"
         FROM backlink_commercial_candidates
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
          AND project_context_version_id=$4
          AND visible_pool_generation=$9
     ),
     publication_counts AS (
       SELECT count(*) FILTER (
                WHERE inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND inventory.contact_decision='eligible'
                  AND inventory.verified_public_email_count>=1
              )::integer "contactReadyCount",
              count(*) FILTER (
                WHERE inventory.publication_status='PUBLISHED'
                  AND inventory.fit_decision='eligible'
                  AND inventory.fit_score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND inventory.contact_decision='eligible'
                  AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
                  AND inventory.verified_public_email_count>=1
                  AND inventory.status IN ('ready','shown','accepted')
                  AND recommendation.status IN ('ready','shown','accepted')
              )::integer "publishedCount",
              bool_or(
                inventory.publication_status IN (
                  'CONTACT_PENDING','CONTACT_REVIEW'
                )
                AND inventory.status IN ('ready','shown')
              ) "contactWorkPending"
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
     )
     SELECT (
              jsonb_array_length(context.products)>0
              AND jsonb_array_length(context.target_urls)>0
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
            job.step "jobStep",
            COALESCE(
              (job.result_summary->>'existingCandidatesAttempted')::boolean,
              false
            ) "existingCandidatesAttempted",
            candidate_counts.*,publication_counts.*,budget.*
       FROM backlink_project_context_snapshots AS context
       JOIN backlink_commercial_inventory_policies AS policy
         ON (
           policy.organization_id,policy.workspace_id,
           policy.website_project_id,policy.project_context_version_id
         )=(
           context.organization_id,context.workspace_id,
           context.website_project_id,context.id
         )
       CROSS JOIN candidate_counts
       CROSS JOIN publication_counts
       CROSS JOIN budget
       JOIN backlink_jobs AS job
         ON (
           job.organization_id,job.workspace_id,
           job.website_project_id,job.id
         )=($1,$2,$3,$7)
      WHERE (context.organization_id,context.workspace_id,
             context.website_project_id,context.id)=($1,$2,$3,$4)
        AND context.project_status='ACTIVE'
        AND policy.visible_pool_generation=$9
        AND policy.visible_pool_state='building'
        AND job.source_object_id=$4
        AND job.job_type='recommendation_refill'`,
    [
      ...scope,
      input.now,
      input.estimatedCostMicros,
      input.jobId,
      commercialRecommendationFitRuleVersion,
      input.visiblePoolGeneration,
    ],
  );
  const row = state.rows[0];
  if (row === undefined) {
    throw new Error("COMMERCIAL_SUPPLY_OPERATION_NOT_FOUND");
  }
  const batchResult = await client.query(
    `SELECT batch.idempotency_key "idempotencyKey",
            batch.status,batch.pause_reason "pauseReason",
            batch.finished_at "finishedAt",
            batch.raw_candidate_count "rawCandidateCount",
            batch.eligible_candidate_count "eligibleCandidateCount"
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
    [...scope, input.visiblePoolGeneration],
  );
  let attempts = enrichAttempts(
    parseCommercialRefillAttempts(row.attemptedRefillTiers),
    batchResult.rows,
  );
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
  const plan = planCommercialSupplyOperation({
    projectContextReady: row.projectContextReady === true,
    targetPublishedCount: input.targetPublishedCount,
    publishedCount,
    rawCandidateCount: nonNegativeInteger(row.rawCandidateCount),
    fitCandidateCount: nonNegativeInteger(row.fitCandidateCount),
    readyFitCandidateCount:
      row.existingCandidatesAttempted === true
        ? 0
        : nonNegativeInteger(row.readyFitCandidateCount),
    contactReadyCount: nonNegativeInteger(row.contactReadyCount),
    contactWorkPending: row.contactWorkPending === true,
    providerState: providerState(row, batchResult.rows, input.now),
    paidCursor,
    resourceCursor,
    attempts,
    candidateLimit: input.candidateLimit,
  });

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
    refillState =
      plan.reason === "contact_processing" ? "waiting_contact" : "paused";
    terminationReason =
      plan.outcome === "PAUSED_BUDGET"
        ? "BUDGET"
        : plan.outcome === "PAUSED_PROVIDER"
          ? "PROVIDER_UNAVAILABLE"
          : plan.outcome === "PROJECT_CONTEXT_REQUIRED"
            ? "PROJECT_CONTEXT"
            : null;
    pauseReason = plan.reason;
  } else {
    refillState = plan.outcome === "TARGET_REACHED" ? "completed" : "exhausted";
    terminationReason =
      plan.outcome === "TARGET_REACHED" ? "HIGH_WATERMARK" : "TIERS_EXHAUSTED";
    pauseReason =
      plan.outcome === "SUPPLY_FLOOR_REACHED" ? "tiers_exhausted" : null;
  }
  await client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET refill_state=$5,current_refill_tier=$6,current_refill_round=$7,
            paid_refill_tier=$8,paid_refill_round=$9,
            resource_refill_tier=$10,resource_refill_round=$11,
            attempted_refill_tiers=$12::jsonb,termination_reason=$13,
            pause_reason=$14,next_refill_at=NULL,updated_at=$15,
            updated_by=$16,version=version+1
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)
        AND visible_pool_generation=$17
        AND visible_pool_state='building'`,
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
  await client.query(
    `UPDATE backlink_jobs
        SET status=CASE
              WHEN $5 IN ('budget','provider','project_context')
                THEN 'waiting_provider'
              ELSE 'running'
            END,
            step=CASE
              WHEN $5='existing' THEN 'existing_candidates_ready'
              WHEN $5='contact_processing' THEN 'contact_processing'
              WHEN $5='budget' THEN 'paused_budget'
              WHEN $5='provider' THEN 'paused_provider'
              WHEN $5='project_context' THEN 'paused_project_context'
              ELSE 'supply_planned'
            END,
            progress=CASE WHEN $5='contact_processing' THEN 70 ELSE 20 END,
            result_summary=CASE
              WHEN $5='existing' THEN
                COALESCE(result_summary,'{}'::jsonb)
                || jsonb_build_object('existingCandidatesAttempted',true)
              WHEN $6::text IS NULL THEN result_summary
              ELSE COALESCE(result_summary,'{}'::jsonb)
                || jsonb_build_object('outcome',$6::text,'reason',$5::text)
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
        retryAfterMs: plan.reason === "contact_processing" ? 30_000 : 60_000,
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
    outcome: "TARGET_REACHED" | "SUPPLY_FLOOR_REACHED";
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
  const result = await client.query(
    `UPDATE backlink_jobs
        SET status=$5,step=$6,progress=$7,error=NULL,
            result_summary=$8::jsonb,finished_at=$9,updated_at=$9,
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
        : "supply_below_target",
      targetReached ? 100 : 99,
      JSON.stringify({
        outcome: input.outcome,
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
              ELSE visible_pool_state
            END,
            refill_state=CASE
              WHEN $6::boolean THEN 'completed'
              ELSE refill_state
            END,
            termination_reason=CASE
              WHEN $6::boolean THEN 'HIGH_WATERMARK'
              ELSE termination_reason
            END,
            updated_at=$7,updated_by=$8,version=version+1
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
      targetReached,
      input.now,
      input.actorId,
    ],
  );
}
