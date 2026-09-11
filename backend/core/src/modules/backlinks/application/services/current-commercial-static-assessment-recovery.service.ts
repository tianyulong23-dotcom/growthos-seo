import { z } from "zod";

import { commercialPageParser } from "../../adapters/html/commercial-page-parser.adapter.js";
import {
  commercialRecommendationFitModelVersion,
} from "../../domain/recommendations/commercial-score-v4.js";
import {
  assessCommercialCandidateSite,
} from "../../domain/recommendations/commercial-static-assessment.js";
import type { CommercialPageParserPort } from "../../ports/commercial-page-parser.port.js";
import type { SafeFetchPort } from "../../ports/safe-fetch.port.js";
import {
  evaluateStoredCurrentCommercialCandidate,
} from "./current-commercial-candidate-reassessment.service.js";

export type CurrentCommercialStaticAssessmentRecoveryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export const maximumCurrentCommercialStaticAssessmentRecoveryAttempts = 3;
export const currentCommercialStaticAssessmentRecoveryContractVersion =
  "commercial-static-assessment-recovery.v4";
const recoveryLeaseMs = 5 * 60 * 1_000;
const recoveryRetryDelayMs = 60 * 1_000;
const recoveryConcurrency = 4;

const recoverySchema = z
  .object({
    attemptCount: z.number().int().min(1).max(
      maximumCurrentCommercialStaticAssessmentRecoveryAttempts,
    ),
    contractVersion: z.literal(
      currentCommercialStaticAssessmentRecoveryContractVersion,
    ),
    operationId: z.string().trim().min(1),
  })
  .passthrough();
const claimedStaticAssessmentSchema = z
  .object({
    failedUrls: z.array(z.string().url()).min(1),
    recovery: recoverySchema,
  })
  .passthrough();
const claimedCandidateSchema = z
  .object({
    candidateId: z.string().uuid(),
    canonicalDomain: z.string().trim().min(1),
    staticAssessment: claimedStaticAssessmentSchema,
    gateDecision: z.unknown(),
    commercialScore: z.unknown(),
    refillTier: z.string().trim().min(1),
    locale: z.string().trim().min(1),
    countryCode: z.string().trim().min(1),
  })
  .strict();

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const output: R[] = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) output[index] = await mapper(value);
      }
    }),
  );
  return Object.freeze(output);
}

export async function recoverCurrentCommercialStaticAssessments(
  client: CurrentCommercialStaticAssessmentRecoveryClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    operationId: string;
    actorId: string;
    maximumCandidates: number;
    project: Readonly<{
      products: readonly string[];
      topics: readonly string[];
      keywords: readonly string[];
      targetPages: readonly string[];
      targetAudiences: readonly string[];
      partnershipGoals: readonly string[];
    }>;
    safeFetch: Pick<SafeFetchPort, "fetch">;
    pageParser?: CommercialPageParserPort;
    now: Date;
  }>,
): Promise<Readonly<{
  claimedCount: number;
  readyCount: number;
  retryScheduledCount: number;
  manualReviewCount: number;
  exhaustedCount: number;
}>> {
  const maximumCandidates = Math.max(
    1,
    Math.min(25, Math.trunc(input.maximumCandidates)),
  );
  const nowIso = input.now.toISOString();
  const leaseExpiresAt = new Date(
    input.now.getTime() + recoveryLeaseMs,
  ).toISOString();
  const claimed = await client.query(
    `WITH recoverable AS (
       SELECT candidate.id,batch.refill_tier,context.locale,
              context.country_code,
              CASE
                WHEN candidate.static_assessment
                       #>>'{recovery,contractVersion}'=$13
                 AND candidate.static_assessment
                       #>>'{recovery,attemptCount}' ~ '^[0-9]+$'
                  THEN (
                    candidate.static_assessment
                      #>>'{recovery,attemptCount}'
                  )::integer
                ELSE 0
              END AS recovery_attempt_count
         FROM backlink_commercial_candidates AS candidate
         JOIN backlink_commercial_discovery_batches AS batch
           ON (
             batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.id
           )=(
             candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id,candidate.discovery_batch_id
           )
          AND batch.visible_pool_generation=
              candidate.visible_pool_generation
         JOIN backlink_project_context_snapshots AS context
           ON (
             context.organization_id,context.workspace_id,
             context.website_project_id,context.id
           )=(
             candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id,
             candidate.project_context_version_id
           )
        WHERE (
          candidate.organization_id,candidate.workspace_id,
          candidate.website_project_id,
          candidate.project_context_version_id
        )=($1,$2,$3,$4)
          AND candidate.visible_pool_generation=$5
          AND candidate.score_model_version=$6
          AND candidate.recommendation_id IS NULL
          AND candidate.prospect_id IS NULL
          AND candidate.state IN ('insufficient_data','manual_review')
          AND candidate.static_assessment->>'decision'='insufficient_data'
          AND jsonb_typeof(candidate.static_assessment->'failedUrls')='array'
          AND jsonb_array_length(
            candidate.static_assessment->'failedUrls'
          )>0
          AND CASE
                WHEN candidate.static_assessment
                       #>>'{recovery,contractVersion}'=$13
                 AND candidate.static_assessment
                       #>>'{recovery,attemptCount}' ~ '^[0-9]+$'
                  THEN (
                    candidate.static_assessment
                      #>>'{recovery,attemptCount}'
                  )::integer
                ELSE 0
              END < $11
          AND (
            candidate.static_assessment
              #>>'{recovery,contractVersion}' IS DISTINCT FROM $13
            OR (
              candidate.static_assessment
                #>>'{recovery,contractVersion}'=$13
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
                      )::timestamptz <= $8::timestamptz
                )
                OR (
                  candidate.static_assessment
                    #>>'{recovery,status}'='retry_scheduled'
                  AND NULLIF(
                        candidate.static_assessment
                          #>>'{recovery,nextRetryAt}',
                        ''
                      )::timestamptz <= $8::timestamptz
                )
              )
            )
          )
        ORDER BY candidate.updated_at,candidate.id
        FOR UPDATE OF candidate SKIP LOCKED
        LIMIT $10
     )
     UPDATE backlink_commercial_candidates AS candidate
        SET static_assessment=jsonb_set(
              candidate.static_assessment,
              '{recovery}',
              jsonb_build_object(
                'attemptCount',recoverable.recovery_attempt_count+1,
                'contractVersion',$13::text,
                'status','running',
                'operationId',$7::text,
                'lastAttemptAt',$8,
                'leaseExpiresAt',$9::text
              ),
              true
            ),
            updated_at=$8::timestamptz,updated_by=$12,version=version+1
       FROM recoverable
      WHERE candidate.id=recoverable.id
        AND candidate.organization_id=$1
        AND candidate.workspace_id=$2
        AND candidate.website_project_id=$3
        AND candidate.project_context_version_id=$4
        AND candidate.visible_pool_generation=$5
     RETURNING candidate.id::text AS "candidateId",
               candidate.canonical_domain AS "canonicalDomain",
               candidate.static_assessment AS "staticAssessment",
               candidate.gate_decision AS "gateDecision",
               candidate.commercial_score AS "commercialScore",
               recoverable.refill_tier AS "refillTier",
               recoverable.locale,
               recoverable.country_code AS "countryCode"`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
      input.visiblePoolGeneration,
      commercialRecommendationFitModelVersion,
      input.operationId,
      nowIso,
      leaseExpiresAt,
      maximumCandidates,
      maximumCurrentCommercialStaticAssessmentRecoveryAttempts,
      input.actorId,
      currentCommercialStaticAssessmentRecoveryContractVersion,
    ],
  );
  const candidates = claimed.rows.map((row) =>
    claimedCandidateSchema.parse(row)
  );
  const outcomes = await mapConcurrent(
    candidates,
    recoveryConcurrency,
    async (candidate) => {
      const assessment = await assessCommercialCandidateSite({
        canonicalDomain: candidate.canonicalDomain,
        discoveryUrls: candidate.staticAssessment.failedUrls,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        project: input.project,
        safeFetch: input.safeFetch,
        pageParser: input.pageParser ?? commercialPageParser,
        now: () => nowIso,
      });
      const attemptCount = candidate.staticAssessment.recovery.attemptCount;
      const status = assessment.decision === "ready"
        ? "completed"
        : assessment.decision === "manual_review"
        ? "manual_review"
        : attemptCount
            >= maximumCurrentCommercialStaticAssessmentRecoveryAttempts
        ? "exhausted"
        : "retry_scheduled";
      const recoveredAssessment = Object.freeze({
        ...assessment,
        recovery: Object.freeze({
          attemptCount,
          contractVersion:
            currentCommercialStaticAssessmentRecoveryContractVersion,
          status,
          operationId: input.operationId,
          lastAttemptAt: nowIso,
          ...(status === "retry_scheduled"
            ? {
                nextRetryAt: new Date(
                  input.now.getTime() + recoveryRetryDelayMs,
                ).toISOString(),
              }
            : {}),
        }),
      });
      const evaluated = evaluateStoredCurrentCommercialCandidate({
        staticAssessment: recoveredAssessment,
        gateDecision: candidate.gateDecision,
        commercialScore: candidate.commercialScore,
        refillTier: candidate.refillTier,
        locale: candidate.locale,
        countryCode: candidate.countryCode,
        visiblePoolGeneration: input.visiblePoolGeneration,
      });
      const persisted = await client.query(
        `UPDATE backlink_commercial_candidates AS candidate
            SET static_assessment=$7::jsonb,
                gate_decision=$8::jsonb,
                commercial_score=$9::jsonb,
                state=$10,
                updated_at=$11,updated_by=$12,version=version+1
          WHERE (
            candidate.organization_id,candidate.workspace_id,
            candidate.website_project_id,
            candidate.project_context_version_id,candidate.id
          )=($1,$2,$3,$4,$6)
            AND candidate.visible_pool_generation=$5
            AND candidate.score_model_version=$13
            AND candidate.static_assessment
                  #>>'{recovery,operationId}'=$14
            AND candidate.static_assessment
                  #>>'{recovery,attemptCount}'=$15
            AND candidate.static_assessment
                  #>>'{recovery,contractVersion}'=$16
        RETURNING candidate.id`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.projectContextVersionId,
          input.visiblePoolGeneration,
          candidate.candidateId,
          JSON.stringify(recoveredAssessment),
          JSON.stringify(evaluated.gateDecision),
          JSON.stringify(evaluated.score),
          evaluated.state,
          input.now,
          input.actorId,
          commercialRecommendationFitModelVersion,
          input.operationId,
          String(attemptCount),
          currentCommercialStaticAssessmentRecoveryContractVersion,
        ],
      );
      return persisted.rows.length === 0 ? "not_persisted" : status;
    },
  );
  return Object.freeze({
    claimedCount: candidates.length,
    readyCount: outcomes.filter((status) => status === "completed").length,
    retryScheduledCount:
      outcomes.filter((status) => status === "retry_scheduled").length,
    manualReviewCount:
      outcomes.filter((status) => status === "manual_review").length,
    exhaustedCount: outcomes.filter((status) => status === "exhausted").length,
  });
}
