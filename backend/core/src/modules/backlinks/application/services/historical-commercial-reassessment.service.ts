import { randomUUID } from "node:crypto";

import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";
import {
  commercialFitWeights,
  commercialRecommendationFitModelVersion,
  type CommercialFitDecision,
} from "../../domain/recommendations/commercial-score-v4.js";
import {
  reassessHistoricalCommercialCandidate,
  type HistoricalCommercialReassessment,
} from "../../domain/recommendations/historical-commercial-reassessment.js";
import {
  queueHistoricalContactEnrichmentJobs,
  type HistoricalContactEnrichmentQueueSummary,
} from "../commands/contact-enrichment.command.js";
import {
  synchronizeRecommendationContactState,
} from "./recommendation-contact-synchronization.service.js";

type HistoricalCandidateRow = Readonly<{
  id: string;
  blueprintId: string;
  discoveryBatchId: string;
  recommendationId: string | null;
  prospectId: string | null;
  projectContextVersionId: string;
  visiblePoolGeneration: number;
  canonicalDomain: string;
  sourceTypes: unknown;
  staticAssessment: unknown;
  gateDecision: unknown;
  commercialScore: unknown;
  providerCollectedAt: string | null;
  createdAt: string;
  locale: string;
  countryCode: string;
  hasReusableContactEvidence: boolean;
}>;

type RefillPolicyRow = Readonly<{
  organizationId: string;
  workspaceId: string;
  projectContextVersionId: string;
  refillState: string;
  currentRefillTier: string;
  currentRefillRound: number;
  paidRefillTier: string | null;
  paidRefillRound: number | null;
  resourceRefillTier: string | null;
  resourceRefillRound: number | null;
  terminationReason: string | null;
  nextRefillAt: string | null;
  updatedAt: string;
  version: number;
  budgetPeriodStart: string | null;
  budgetRemainingMicros: number | null;
  activeJob: boolean;
  activeBatch: boolean;
  pendingRefillOutbox: boolean;
}>;

export type HistoricalReassessmentMode = "dry-run" | "apply";

export type HistoricalReassessmentSummary = Readonly<{
  mode: HistoricalReassessmentMode;
  scannedProjectCount: number;
  projectCount: number;
  candidateCount: number;
  directReassessmentCount: number;
  decisionCounts: Readonly<Record<CommercialFitDecision["decision"], number>>;
  promotedCandidateCount: number;
  reusableContactEvidenceCount: number;
  evidencePathRequiredCount: number;
  estimatedRecoverablePublicationCount: number;
  policyCounts: Readonly<{
    budgetRecoverable: number;
    providerRecoverable: number;
    activeWorkSkipped: number;
    tiersExhaustedPreserved: number;
  }>;
  applied: Readonly<{
    candidatesInserted: number;
    scoresInserted: number;
    publicationSynchronizations: number;
    policiesRecovered: number;
    contactQueue: HistoricalContactEnrichmentQueueSummary;
  }>;
  estimatedChanges: number;
}>;

export type RefillRecoveryDecision = Readonly<{
  recover: boolean;
  reason:
    | "NEW_BUDGET_PERIOD"
    | "PROVIDER_RECOVERY_DUE"
    | "ACTIVE_WORK"
    | "NO_PAID_CURSOR"
    | "SAME_BUDGET_PERIOD"
    | "RECOVERY_NOT_DUE"
    | "TIERS_EXHAUSTED_PRESERVED"
    | "NOT_RECOVERABLE";
}>;

export function decideRefillPolicyRecovery(
  policy: RefillPolicyRow,
  now: Date,
): RefillRecoveryDecision {
  if (policy.terminationReason === "TIERS_EXHAUSTED") {
    return Object.freeze({
      recover: false,
      reason: "TIERS_EXHAUSTED_PRESERVED",
    });
  }
  if (
    policy.activeJob
    || policy.activeBatch
    || policy.pendingRefillOutbox
  ) {
    return Object.freeze({ recover: false, reason: "ACTIVE_WORK" });
  }
  if (
    policy.paidRefillTier === null
    || policy.paidRefillRound === null
  ) {
    return Object.freeze({ recover: false, reason: "NO_PAID_CURSOR" });
  }
  if (policy.terminationReason === "BUDGET") {
    const newBudgetPeriod = policy.budgetPeriodStart !== null
      && Date.parse(policy.budgetPeriodStart) > Date.parse(policy.updatedAt);
    const remaining = policy.budgetRemainingMicros ?? 0;
    return newBudgetPeriod && remaining > 0
      ? Object.freeze({ recover: true, reason: "NEW_BUDGET_PERIOD" })
      : Object.freeze({ recover: false, reason: "SAME_BUDGET_PERIOD" });
  }
  if (policy.terminationReason === "PROVIDER_UNAVAILABLE") {
    const recoveryDue = policy.nextRefillAt !== null
      && Date.parse(policy.nextRefillAt) <= now.getTime();
    return recoveryDue
      ? Object.freeze({ recover: true, reason: "PROVIDER_RECOVERY_DUE" })
      : Object.freeze({ recover: false, reason: "RECOVERY_NOT_DUE" });
  }
  return Object.freeze({ recover: false, reason: "NOT_RECOVERABLE" });
}

function candidateState(
  score: HistoricalCommercialReassessment,
): string {
  if (score.decision === "ineligible") return "excluded";
  if (score.decision === "insufficient_data") return "insufficient_data";
  if (score.decision === "manual_review") return "manual_review";
  return "candidate_ready";
}

function requiredText(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = row[key];
  if (value === null || value === undefined || String(value).length === 0) {
    throw new TypeError(`Historical reassessment row is missing ${key}`);
  }
  return String(value);
}

function nullableText(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

async function loadHistoricalCandidates(
  client: BacklinkTransactionClient,
): Promise<readonly HistoricalCandidateRow[]> {
  const result = await client.query(
    `SELECT source.id,
            source.blueprint_id AS "blueprintId",
            source.discovery_batch_id AS "discoveryBatchId",
            source.recommendation_id AS "recommendationId",
            source.prospect_id AS "prospectId",
            source.project_context_version_id AS "projectContextVersionId",
            source.visible_pool_generation AS "visiblePoolGeneration",
            source.canonical_domain AS "canonicalDomain",
            source.source_types AS "sourceTypes",
            source.static_assessment AS "staticAssessment",
            source.gate_decision AS "gateDecision",
            source.commercial_score AS "commercialScore",
            source.provider_collected_at::text AS "providerCollectedAt",
            source.created_at::text AS "createdAt",
            context.locale,
            context.country_code AS "countryCode",
            EXISTS (
              SELECT 1
                FROM backlink_contact_candidates AS contact
                JOIN backlink_contact_evidence AS evidence ON
                  (evidence.organization_id,evidence.workspace_id,
                   evidence.website_project_id,evidence.candidate_id)=
                  (contact.organization_id,contact.workspace_id,
                   contact.website_project_id,contact.id)
               WHERE contact.prospect_id=source.prospect_id
                 AND contact.recommendation_context_version_id=
                       source.project_context_version_id
                 AND contact.status IN ('candidate','promoted')
                 AND contact.invalidated_at IS NULL
                 AND contact.guessed=false
                 AND contact.confidence>=80
                 AND contact.purpose_confidence>=70
                 AND contact.inferred_purpose IN (
                   'press','editorial','partnerships','advertising','business',
                   'marketing','site_owner','general'
                 )
                 AND lower(contact.normalized_email) ~
                   '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
                 AND split_part(
                   lower(contact.normalized_email),'@',1
                 ) !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
                 AND contact.email_domain_ascii NOT IN (
                   'example.com','example.org','example.net'
                 )
                 AND contact.email_domain_ascii NOT LIKE '%.invalid'
                 AND evidence.invalidated_at IS NULL
                 AND evidence.expires_at>now()
                 AND evidence.extraction_method IN (
                   'mailto','visible_text','obfuscated_text','json_ld'
                 )
                 AND evidence.confidence>=80
            ) AS "hasReusableContactEvidence"
       FROM backlink_commercial_candidates AS source
       JOIN backlink_project_context_snapshots AS context ON
         (context.organization_id,context.workspace_id,
          context.website_project_id,context.id)=
         (source.organization_id,source.workspace_id,
          source.website_project_id,source.project_context_version_id)
      WHERE source.score_model_version='recommendation-commercial-fit.v2'
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_commercial_candidates AS target
           WHERE (
              target.organization_id,target.workspace_id,
              target.website_project_id,target.project_context_version_id,
              target.visible_pool_generation,target.canonical_domain
            )=(
              source.organization_id,source.workspace_id,
              source.website_project_id,source.project_context_version_id,
              source.visible_pool_generation,source.canonical_domain
            )
             AND target.score_model_version=$1
        )
      ORDER BY source.project_context_version_id,
               source.canonical_domain,source.id`,
    [commercialRecommendationFitModelVersion],
  );
  return result.rows.map((row) => Object.freeze({
    id: requiredText(row, "id"),
    blueprintId: requiredText(row, "blueprintId"),
    discoveryBatchId: requiredText(row, "discoveryBatchId"),
    recommendationId: nullableText(row, "recommendationId"),
    prospectId: nullableText(row, "prospectId"),
    projectContextVersionId: requiredText(row, "projectContextVersionId"),
    visiblePoolGeneration: Number(row.visiblePoolGeneration),
    canonicalDomain: requiredText(row, "canonicalDomain"),
    sourceTypes: row.sourceTypes,
    staticAssessment: row.staticAssessment,
    gateDecision: row.gateDecision,
    commercialScore: row.commercialScore,
    providerCollectedAt: nullableText(row, "providerCollectedAt"),
    createdAt: requiredText(row, "createdAt"),
    locale: requiredText(row, "locale"),
    countryCode: requiredText(row, "countryCode"),
    hasReusableContactEvidence: row.hasReusableContactEvidence === true,
  }));
}

async function loadRefillPolicies(
  client: BacklinkTransactionClient,
): Promise<readonly RefillPolicyRow[]> {
  const result = await client.query(
    `SELECT policy.project_context_version_id AS "projectContextVersionId",
            policy.organization_id AS "organizationId",
            policy.workspace_id AS "workspaceId",
            policy.refill_state AS "refillState",
            policy.current_refill_tier AS "currentRefillTier",
            policy.current_refill_round AS "currentRefillRound",
            policy.paid_refill_tier AS "paidRefillTier",
            policy.paid_refill_round AS "paidRefillRound",
            policy.resource_refill_tier AS "resourceRefillTier",
            policy.resource_refill_round AS "resourceRefillRound",
            policy.termination_reason AS "terminationReason",
            policy.next_refill_at::text AS "nextRefillAt",
            policy.updated_at::text AS "updatedAt",
            policy.version,
            budget.period_start::text AS "budgetPeriodStart",
            CASE
              WHEN budget.id IS NULL THEN NULL
              ELSE budget.limit_micros-budget.spent_micros-
                   budget.reserved_micros
            END AS "budgetRemainingMicros",
            EXISTS (
              SELECT 1 FROM backlink_jobs AS job
               WHERE job.source_object_type='recommendation_context'
                 AND job.source_object_id=policy.project_context_version_id
                 AND job.status IN (
                   'queued','running','waiting_provider'
                 )
            ) AS "activeJob",
            EXISTS (
              SELECT 1 FROM backlink_commercial_discovery_batches AS batch
               WHERE batch.project_context_version_id=
                     policy.project_context_version_id
                 AND batch.status='running'
            ) AS "activeBatch",
            EXISTS (
              SELECT 1 FROM backlink_outbox_events AS outbox
               WHERE outbox.aggregate_id=policy.project_context_version_id
                 AND outbox.event_type=
                     'backlinks.recommendation-refill.requested.v1'
                 AND outbox.status IN ('pending','processing')
            ) AS "pendingRefillOutbox"
       FROM backlink_commercial_inventory_policies AS policy
       LEFT JOIN LATERAL (
         SELECT id,period_start,limit_micros,spent_micros,reserved_micros
           FROM backlink_provider_budgets AS budget
          WHERE budget.organization_id=policy.organization_id
            AND budget.workspace_id=policy.workspace_id
            AND budget.provider='dataforseo'
          ORDER BY budget.period_start DESC
          LIMIT 1
       ) AS budget ON true
      WHERE policy.termination_reason IN (
        'BUDGET','PROVIDER_UNAVAILABLE','TIERS_EXHAUSTED'
      )
      ORDER BY policy.project_context_version_id`,
  );
  return result.rows.map((row) => Object.freeze({
    organizationId: requiredText(row, "organizationId"),
    workspaceId: requiredText(row, "workspaceId"),
    projectContextVersionId:
      requiredText(row, "projectContextVersionId"),
    refillState: requiredText(row, "refillState"),
    currentRefillTier: requiredText(row, "currentRefillTier"),
    currentRefillRound: Number(row.currentRefillRound),
    paidRefillTier: nullableText(row, "paidRefillTier"),
    paidRefillRound: row.paidRefillRound === null
      ? null
      : Number(row.paidRefillRound),
    resourceRefillTier: nullableText(row, "resourceRefillTier"),
    resourceRefillRound: row.resourceRefillRound === null
      ? null
      : Number(row.resourceRefillRound),
    terminationReason: nullableText(row, "terminationReason"),
    nextRefillAt: nullableText(row, "nextRefillAt"),
    updatedAt: requiredText(row, "updatedAt"),
    version: Number(row.version),
    budgetPeriodStart: nullableText(row, "budgetPeriodStart"),
    budgetRemainingMicros: row.budgetRemainingMicros === null
      ? null
      : Number(row.budgetRemainingMicros),
    activeJob: row.activeJob === true,
    activeBatch: row.activeBatch === true,
    pendingRefillOutbox: row.pendingRefillOutbox === true,
  }));
}

async function insertReassessment(
  client: BacklinkTransactionClient,
  scope: BacklinkTenantContext,
  row: HistoricalCandidateRow,
  score: HistoricalCommercialReassessment,
  actorId: string,
  generatedAt: Date,
): Promise<Readonly<{
  candidateInserted: number;
  scoreInserted: number;
  publicationSynchronized: number;
}>> {
  const promoted = row.recommendationId !== null && row.prospectId !== null;
  const inserted = await client.query(
    `INSERT INTO backlink_commercial_candidates (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       discovery_batch_id,recommendation_id,prospect_id,
       project_context_version_id,visible_pool_generation,
       canonical_domain,source_types,
       static_assessment,gate_decision,commercial_score,
       score_model_version,state,provider_collected_at,
       created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,
       $14::jsonb,$15::jsonb,$16,$17,$18,$19,$19
     )
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,visible_pool_generation,
       canonical_domain,score_model_version
     ) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      row.blueprintId,
      row.discoveryBatchId,
      row.recommendationId,
      row.prospectId,
      row.projectContextVersionId,
      row.visiblePoolGeneration,
      row.canonicalDomain,
      JSON.stringify(row.sourceTypes),
      JSON.stringify(row.staticAssessment),
      JSON.stringify({
        decision: score.decision,
        hitGates: score.hitGates,
        missingEvidence: score.missingEvidence,
      }),
      JSON.stringify(score),
      commercialRecommendationFitModelVersion,
      candidateState(score),
      row.providerCollectedAt,
      actorId,
    ],
  );
  if (inserted.rowCount !== 1) {
    return Object.freeze({
      candidateInserted: 0,
      scoreInserted: 0,
      publicationSynchronized: 0,
    });
  }

  let scoreInserted = 0;
  if (
    promoted
    && row.recommendationId !== null
    && row.prospectId !== null
    && score.total !== null
  ) {
    const result = await client.query(
      `INSERT INTO backlink_recommendation_scores (
         id,organization_id,workspace_id,website_project_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         score_model_version,rule_version,total_score,components,weights,
         evidence,generated_at,created_by
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,
              $13::jsonb,$14,$15
        WHERE NOT EXISTS (
          SELECT 1 FROM backlink_recommendation_scores
           WHERE organization_id=$2 AND workspace_id=$3
             AND website_project_id=$4 AND recommendation_id=$5
             AND score_model_version=$8
             AND evidence->>'historicalV2CandidateId'=$16
        )`,
      [
        randomUUID(),
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        row.recommendationId,
        row.prospectId,
        row.projectContextVersionId,
        score.scoreModelVersion,
        score.ruleVersion,
        score.total,
        JSON.stringify(score.components),
        JSON.stringify(commercialFitWeights),
        JSON.stringify({
          reassessmentReason: "HISTORICAL_V2_REASSESSED",
          historicalV2CandidateId: row.id,
          sourceScoreModelVersion: "recommendation-commercial-fit.v2",
          sourceEvidenceCollectedAt:
            row.providerCollectedAt ?? row.createdAt,
          projectContextVersionId: row.projectContextVersionId,
        }),
        generatedAt,
        actorId,
        row.id,
      ],
    );
    scoreInserted = result.rowCount ?? 0;
  }

  if (!promoted || row.prospectId === null) {
    return Object.freeze({
      candidateInserted: 1,
      scoreInserted,
      publicationSynchronized: 0,
    });
  }
  await synchronizeRecommendationContactState(client, {
    ...scope,
    prospectId: row.prospectId,
    recommendationContextVersionId: row.projectContextVersionId,
    actorId,
  });
  return Object.freeze({
    candidateInserted: 1,
    scoreInserted,
    publicationSynchronized: 1,
  });
}

async function recoverPolicy(
  client: BacklinkTransactionClient,
  policy: RefillPolicyRow,
  actorId: string,
  now: Date,
): Promise<number> {
  const result = await client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET current_refill_tier=paid_refill_tier,
            current_refill_round=paid_refill_round,
            refill_state='idle',
            termination_reason=NULL,
            pause_reason=NULL,
            updated_at=now(),updated_by=$3,version=version+1
      WHERE project_context_version_id=$1
        AND version=$2
        AND paid_refill_tier IS NOT NULL
        AND paid_refill_round IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM backlink_jobs AS job
           WHERE job.source_object_type='recommendation_context'
             AND job.source_object_id=
                   backlink_commercial_inventory_policies
                     .project_context_version_id
             AND job.status IN ('queued','running','waiting_provider')
        )
        AND NOT EXISTS (
          SELECT 1 FROM backlink_commercial_discovery_batches AS batch
           WHERE batch.project_context_version_id=
                 backlink_commercial_inventory_policies
                   .project_context_version_id
             AND batch.status='running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM backlink_outbox_events AS outbox
           WHERE outbox.aggregate_id=
                 backlink_commercial_inventory_policies
                   .project_context_version_id
             AND outbox.event_type=
                 'backlinks.recommendation-refill.requested.v1'
             AND outbox.status IN ('pending','processing')
        )
        AND (
          (
            termination_reason='BUDGET'
            AND EXISTS (
              SELECT 1
               FROM backlink_provider_budgets AS budget
               WHERE budget.organization_id=
                     backlink_commercial_inventory_policies.organization_id
                 AND budget.workspace_id=
                     backlink_commercial_inventory_policies.workspace_id
                 AND budget.provider='dataforseo'
                 AND budget.period_start>
                       backlink_commercial_inventory_policies.updated_at
                 AND budget.limit_micros-budget.spent_micros-
                     budget.reserved_micros>0
            )
          )
          OR (
            termination_reason='PROVIDER_UNAVAILABLE'
            AND next_refill_at<=$4
          )
        )`,
    [policy.projectContextVersionId, policy.version, actorId, now],
  );
  return result.rowCount ?? 0;
}

export async function runHistoricalCommercialReassessment(input: Readonly<{
  pool: BacklinkTenantPool;
  scopes: readonly BacklinkTenantContext[];
  mode: HistoricalReassessmentMode;
  actorId: string;
  now: Date;
  contactOptions: Readonly<{
    maxPages: number;
    maxDepth: number;
    maxAttempts: number;
    browserAllowed: boolean;
  }>;
}>): Promise<HistoricalReassessmentSummary> {
  const decisionCounts = {
    eligible: 0,
    ineligible: 0,
    insufficient_data: 0,
    manual_review: 0,
  };
  const policyCounts = {
    budgetRecoverable: 0,
    providerRecoverable: 0,
    activeWorkSkipped: 0,
    tiersExhaustedPreserved: 0,
  };
  const applied = {
    candidatesInserted: 0,
    scoresInserted: 0,
    publicationSynchronizations: 0,
    policiesRecovered: 0,
    contactQueue: {
      eligibleRecommendationCount: 0,
      jobsCreated: 0,
      jobsRetried: 0,
      activeJobsPreserved: 0,
      staleContextsSkipped: 0,
      attemptLimitsSkipped: 0,
      outboxEventsCreated: 0,
    },
  };
  let projectCount = 0;
  let candidateCount = 0;
  let directReassessmentCount = 0;
  let promotedCandidateCount = 0;
  let reusableContactEvidenceCount = 0;
  let evidencePathRequiredCount = 0;
  let estimatedRecoverablePublicationCount = 0;

  for (const scope of input.scopes) {
    await withBacklinkTenantTransaction(input.pool, scope, async (client) => {
      const rows = await loadHistoricalCandidates(client);
      const policies = await loadRefillPolicies(client);
      const assessments = rows.map((row) => ({
        row,
        score: reassessHistoricalCommercialCandidate({
          candidateId: row.id,
          staticAssessment: row.staticAssessment,
          gateDecision: row.gateDecision,
          commercialScore: row.commercialScore,
          fallbackCollectedAt: row.providerCollectedAt ?? row.createdAt,
          locale: row.locale,
          countryCode: row.countryCode,
        }),
      }));
      const policyRecoveries = policies.map((policy) => ({
        policy,
        recovery: decideRefillPolicyRecovery(policy, input.now),
      }));
      if (
        assessments.length > 0
        || policyRecoveries.some(({ recovery }) => recovery.recover)
      ) {
        projectCount += 1;
      }
      candidateCount += assessments.length;
      const eligibleRecommendationIds: string[] = [];
      for (const { row, score } of assessments) {
        decisionCounts[score.decision] += 1;
        if (score.total !== null) directReassessmentCount += 1;
        const promoted =
          row.recommendationId !== null && row.prospectId !== null;
        if (promoted) promotedCandidateCount += 1;
        if (
          promoted
          && row.recommendationId !== null
          && score.decision === "eligible"
        ) {
          eligibleRecommendationIds.push(row.recommendationId);
          if (row.hasReusableContactEvidence) {
            reusableContactEvidenceCount += 1;
            estimatedRecoverablePublicationCount += 1;
          } else {
            evidencePathRequiredCount += 1;
          }
        }
        if (input.mode === "apply") {
          const result = await insertReassessment(
            client,
            scope,
            row,
            score,
            input.actorId,
            input.now,
          );
          applied.candidatesInserted += result.candidateInserted;
          applied.scoresInserted += result.scoreInserted;
          applied.publicationSynchronizations +=
            result.publicationSynchronized;
        }
      }
      if (input.mode === "apply") {
        const contactQueue = await queueHistoricalContactEnrichmentJobs(
          client,
          {
            scope,
            actorId: input.actorId,
            recommendationIds: eligibleRecommendationIds,
            options: input.contactOptions,
          },
        );
        for (const key of Object.keys(
          contactQueue,
        ) as (keyof HistoricalContactEnrichmentQueueSummary)[]) {
          applied.contactQueue[key] += contactQueue[key];
        }
      }
      for (const { policy, recovery } of policyRecoveries) {
        if (recovery.reason === "ACTIVE_WORK") {
          policyCounts.activeWorkSkipped += 1;
        }
        if (recovery.reason === "TIERS_EXHAUSTED_PRESERVED") {
          policyCounts.tiersExhaustedPreserved += 1;
        }
        if (recovery.reason === "NEW_BUDGET_PERIOD") {
          policyCounts.budgetRecoverable += 1;
        }
        if (recovery.reason === "PROVIDER_RECOVERY_DUE") {
          policyCounts.providerRecoverable += 1;
        }
        if (input.mode === "apply" && recovery.recover) {
          applied.policiesRecovered += await recoverPolicy(
            client,
            policy,
            input.actorId,
            input.now,
          );
        }
      }
    });
  }

  const recoverablePolicies = policyCounts.budgetRecoverable
    + policyCounts.providerRecoverable;
  return Object.freeze({
    mode: input.mode,
    scannedProjectCount: input.scopes.length,
    projectCount,
    candidateCount,
    directReassessmentCount,
    decisionCounts: Object.freeze(decisionCounts),
    promotedCandidateCount,
    reusableContactEvidenceCount,
    evidencePathRequiredCount,
    estimatedRecoverablePublicationCount,
    policyCounts: Object.freeze(policyCounts),
    applied: Object.freeze({
      ...applied,
      contactQueue: Object.freeze(applied.contactQueue),
    }),
    estimatedChanges:
      candidateCount + evidencePathRequiredCount + recoverablePolicies,
  });
}
