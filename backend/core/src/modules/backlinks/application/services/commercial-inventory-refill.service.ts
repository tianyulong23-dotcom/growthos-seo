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

export type CommercialInventoryRefillClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type CommercialInventoryRefillResult =
  | Readonly<{
    status: "idle" | "paused";
    pauseReason: "inflight" | "cooldown" | "budget" | null;
    requestedCandidateCount: number;
    effectiveEmailHitRate: number;
  }>
  | Readonly<{
    status: "queued";
    jobId: string;
    requestedCandidateCount: number;
    effectiveEmailHitRate: number;
  }>;

const automaticRefillWindowMs = 15 * 60_000;

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  const state = await client.query(
    `WITH candidate_counts AS (
       SELECT
         count(*) FILTER (
           WHERE state IN ('candidate_ready','contact_enrichment')
         )::integer candidate_ready_count,
         count(*) FILTER (
           WHERE state<>'stale_context'
         )::integer historical_candidate_count
       FROM backlink_commercial_candidates
       WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
         AND project_context_version_id=$4
     ),
     publication_counts AS (
       SELECT count(*) FILTER (
                WHERE publication_status='PUBLISHED'
                  AND verified_public_email_count>=1
                  AND status IN ('ready','shown')
              )::integer published_count,
              count(*) FILTER (
                WHERE verified_public_email_count>=1
              )::integer historical_verified_email_count,
              count(*) FILTER (
                WHERE status IN ('ready','shown')
              )::integer workflow_ready_count
       FROM backlink_recommendation_inventory
       WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
         AND recommendation_context_version_id=$4
     ),
     inflight AS (
       SELECT (
         EXISTS (
           SELECT 1
           FROM backlink_jobs
           WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
             AND source_object_type='recommendation_context'
             AND source_object_id=$4
             AND status IN ('queued','running','waiting_provider')
         )
         OR EXISTS (
           SELECT 1
           FROM backlink_commercial_discovery_batches
           WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
             AND project_context_version_id=$4
             AND status='running'
         )
       ) value
     ),
     budget AS (
       SELECT COALESCE(bool_or(
         limit_micros-spent_micros-reserved_micros >= $6
       ),false) value
       FROM backlink_provider_budgets
       WHERE organization_id=$1 AND workspace_id=$2
         AND provider='dataforseo'
         AND period_start<=$5 AND period_end>$5
     )
     SELECT
       context.canonical_domain "canonicalDomain",
       context.locale,
       context.country_code "countryCode",
       context.profile_version_id "profileVersionId",
       context.promotion_target_version_id "promotionTargetVersionId",
       policy.candidate_low_watermark "candidateLowWatermark",
       policy.candidate_high_watermark "candidateHighWatermark",
       policy.published_low_watermark "publishedLowWatermark",
       policy.published_high_watermark "publishedHighWatermark",
       policy.minimum_email_hit_rate::double precision
         "minimumEmailHitRate",
       policy.maximum_email_hit_rate::double precision
         "maximumEmailHitRate",
       COALESCE(candidate_counts.candidate_ready_count,0)
         "candidateReadyCount",
       COALESCE(candidate_counts.historical_candidate_count,0)
         "historicalCandidateCount",
       COALESCE(publication_counts.published_count,0)
         "publishedContactReadyCount",
       COALESCE(publication_counts.historical_verified_email_count,0)
         "historicalVerifiedEmailCount",
       COALESCE(publication_counts.workflow_ready_count,0)
         "workflowReadyCount",
       inflight.value "inflight",
       policy.next_refill_at>$5 "cooldownActive",
       budget.value "budgetAvailable"
     FROM backlink_project_context_snapshots AS context
     JOIN backlink_commercial_inventory_policies AS policy
       ON (policy.organization_id,policy.workspace_id,
           policy.website_project_id,policy.project_context_version_id)=
          (context.organization_id,context.workspace_id,
           context.website_project_id,context.id)
     CROSS JOIN candidate_counts
     CROSS JOIN publication_counts
     CROSS JOIN inflight
     CROSS JOIN budget
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
  const decision = decideCommercialInventoryRefill({
    policy: {
      candidateLowWatermark: integer(row.candidateLowWatermark),
      candidateHighWatermark: integer(row.candidateHighWatermark),
      publishedLowWatermark: integer(row.publishedLowWatermark),
      publishedHighWatermark: integer(row.publishedHighWatermark),
      minimumEmailHitRate: number(row.minimumEmailHitRate, 0.1),
      maximumEmailHitRate: number(row.maximumEmailHitRate, 0.8),
    },
    candidateReadyCount: integer(row.candidateReadyCount),
    publishedContactReadyCount: integer(row.publishedContactReadyCount),
    historicalVerifiedEmailCount: integer(row.historicalVerifiedEmailCount),
    historicalCandidateCount: integer(row.historicalCandidateCount),
    inflight: row.inflight === true,
    cooldownActive: row.cooldownActive === true,
    budgetAvailable: row.budgetAvailable === true,
  });
  const requestedCandidateCount = Math.min(
    input.candidateLimit,
    decision.requestedCandidateCount,
  );
  if (!decision.shouldRefill || requestedCandidateCount === 0) {
    await client.query(
      `UPDATE backlink_commercial_inventory_policies
          SET pause_reason=$5,updated_at=$6,updated_by=$7,
              version=version+1
        WHERE (organization_id,workspace_id,website_project_id,
               project_context_version_id)=($1,$2,$3,$4)
          AND pause_reason IS DISTINCT FROM $5`,
      [
        ...scopeValues,
        decision.pauseReason,
        input.now,
        input.actorId,
      ],
    );
    return Object.freeze({
      status: decision.pauseReason === null ? "idle" : "paused",
      pauseReason: decision.pauseReason,
      requestedCandidateCount,
      effectiveEmailHitRate: decision.effectiveEmailHitRate,
    });
  }

  const boundedRequest = Math.max(2, requestedCandidateCount);
  const workflowReadyCount = integer(row.workflowReadyCount);
  const window = Math.floor(input.now.getTime() / automaticRefillWindowMs);
  const refillWindowKey =
    `commercial-auto:${input.projectContextVersionId}:${window}`;
  const idempotencyKey = `recommendation-refill:${refillWindowKey}`;
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
    idempotencyKey,
    requestId: idempotencyKey,
    expectedVersion: 0,
    recommendationContextVersionId: input.projectContextVersionId,
    lowWatermark: workflowReadyCount + 1,
    highWatermark: workflowReadyCount + boundedRequest,
    refillWindowKey,
    triggerReason: "inventory_low",
  });
  await client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET next_refill_at=$5,pause_reason=NULL,
            updated_at=$6,updated_by=$7,version=version+1
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)`,
    [
      ...scopeValues,
      new Date(input.now.getTime() + automaticRefillWindowMs),
      input.now,
      input.actorId,
    ],
  );
  return Object.freeze({
    status: "queued",
    jobId: command.jobId,
    requestedCandidateCount: boundedRequest,
    effectiveEmailHitRate: decision.effectiveEmailHitRate,
  });
}
