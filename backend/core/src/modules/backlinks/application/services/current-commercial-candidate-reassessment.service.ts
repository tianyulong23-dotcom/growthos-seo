import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  applyProgressiveCommercialCandidateAdmission,
  evaluateCommercialCandidate,
} from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  commercialFitWeights,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
  hasUnresolvedCommercialFitHardGate,
} from "../../domain/recommendations/commercial-score-v4.js";
import {
  commercialStaticAssessmentRuleVersion,
  type CommercialStaticAssessment,
} from "../../domain/recommendations/commercial-static-assessment.js";
import {
  synchronizeRecommendationContactState,
} from "./recommendation-contact-synchronization.service.js";

type CommercialCandidateReassessmentClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const stringArraySchema = z.array(z.string());
const nullableScoreSchema = z.number().min(0).max(1).nullable();
const staticAssessmentSchema = z
  .object({
    canonicalDomain: z.string(),
    decision: z.enum(["ready", "insufficient_data", "manual_review"]),
    language: z.string().nullable(),
    topics: stringArraySchema,
    matchedProducts: stringArraySchema,
    matchedTopics: stringArraySchema,
    matchedKeywords: stringArraySchema,
    matchedTargetPages: stringArraySchema,
    matchedAudiences: stringArraySchema,
    matchedPartnershipGoals: stringArraySchema,
    relatedContentPages: stringArraySchema,
    productRelevance: nullableScoreSchema,
    editorialQuality: nullableScoreSchema,
    siteType: z.string().nullable(),
    monetizationMethods: stringArraySchema,
    cooperationPages: stringArraySchema,
    outboundLinkDensity: nullableScoreSchema,
    technicalAccessibility: nullableScoreSchema,
    unsafeOrMalicious: z.boolean().nullable(),
    highConfidenceLinkFarm: z.boolean().nullable(),
    unrelatedIndustry: z.boolean().nullable(),
    evidenceUrls: stringArraySchema,
    evidenceRefs: stringArraySchema,
    failedUrls: stringArraySchema,
    collectedAt: z.string(),
    ruleVersion: z.literal(commercialStaticAssessmentRuleVersion),
  })
  .passthrough();
const gateDecisionSchema = z
  .object({
    hitGates: stringArraySchema,
  })
  .passthrough();
const commercialScoreSchema = z
  .object({
    details: z
      .object({
        authority: z
          .object({
            projectAuthority: z.number().min(0).max(100),
          })
          .passthrough()
          .optional(),
        market: z
          .object({
            candidateCountry: z.string().nullable(),
          })
          .passthrough(),
        dataForSeo: z
          .object({
            rank: z.number().nullable(),
            traffic: z.number().nullable(),
            backlinks: z.number().nullable(),
            referringDomains: z.number().nullable(),
            spamScore: z.number().nullable(),
            backlinkPageEvidence: z.array(z.object({
              sourceUrl: z.string(),
              targetUrl: z.string(),
              anchorText: z.string().nullable(),
              linkStatus: z.enum(["active", "lost"]),
              firstSeenAt: z.string().nullable(),
              lastSeenAt: z.string().nullable(),
              sourceHttpStatus: z.number().nullable(),
              targetHttpStatus: z.number().nullable(),
            }).passthrough()).optional(),
            evidenceRefs: stringArraySchema,
            collectedAt: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const targetMarketScopedTiers = new Set([
  "exact_product_target_market",
  "same_topic_target_market",
  "adjacent_industry_same_audience",
  "resource_media_review_partner_ecosystem",
]);

function stateFor(
  score: ReturnType<typeof evaluateCommercialCandidate>,
): string {
  if (hasUnresolvedCommercialFitHardGate(score)) return "insufficient_data";
  switch (score.decision) {
    case "eligible":
      return "candidate_ready";
    case "ineligible":
      return "excluded";
    case "insufficient_data":
      return "insufficient_data";
    default:
      return "manual_review";
  }
}

export function evaluateStoredCurrentCommercialCandidate(
  input: Readonly<{
    staticAssessment: unknown;
    gateDecision: unknown;
    commercialScore: unknown;
    refillTier: unknown;
    locale: unknown;
    countryCode: unknown;
    visiblePoolGeneration: number;
  }>,
): Readonly<{
  staticAssessment: CommercialStaticAssessment;
  score: ReturnType<typeof evaluateCommercialCandidate>;
  state: string;
  gateDecision: Readonly<{
    decision: ReturnType<typeof evaluateCommercialCandidate>["decision"];
    hitGates: ReturnType<typeof evaluateCommercialCandidate>["hitGates"];
    missingEvidence: ReturnType<
      typeof evaluateCommercialCandidate
    >["missingEvidence"];
  }>;
}> {
  const assessment = staticAssessmentSchema.parse(
    input.staticAssessment,
  ) as CommercialStaticAssessment;
  const previousGate = gateDecisionSchema.parse(input.gateDecision);
  const previousScore = commercialScoreSchema.parse(input.commercialScore);
  const previousHitGates = new Set(previousGate.hitGates);
  const refillTier = String(input.refillTier);
  const baselineScore = evaluateCommercialCandidate({
    business: {
      selfOrRelatedDomain: previousHitGates.has("self_or_related_domain"),
      existingBacklinkOrOpportunity: previousHitGates.has(
        "existing_backlink_or_opportunity",
      ),
      permanentlyRejectedOrSuppressed: previousHitGates.has(
        "permanently_rejected_or_suppressed",
      ),
      unsafeOrDisallowedIndustry: previousHitGates.has(
        "unsafe_or_disallowed",
      ),
      projectAuthorityScore:
        previousScore.details.authority?.projectAuthority ?? null,
      targetCountryCode: String(input.countryCode),
      candidateCountryCode: previousScore.details.market.candidateCountry,
      targetLanguages: [String(input.locale)],
      allowSameLanguageExpansion: [
        "same_language_expansion",
        "curated_resource_library",
      ].includes(refillTier),
      targetMarketScopedDiscovery: targetMarketScopedTiers.has(refillTier),
    },
    provider: {
      rank: previousScore.details.dataForSeo.rank,
      traffic: previousScore.details.dataForSeo.traffic,
      backlinkCount: previousScore.details.dataForSeo.backlinks,
      referringDomainCount: previousScore.details.dataForSeo.referringDomains,
      spamScore: previousScore.details.dataForSeo.spamScore,
      ...(previousScore.details.dataForSeo.backlinkPageEvidence === undefined
        ? {}
        : {
            backlinkPageEvidence:
              previousScore.details.dataForSeo.backlinkPageEvidence,
          }),
      evidenceRefs: previousScore.details.dataForSeo.evidenceRefs,
      collectedAt: previousScore.details.dataForSeo.collectedAt,
    },
    staticAssessment: assessment,
  });
  const score = applyProgressiveCommercialCandidateAdmission(
    [baselineScore],
    { visiblePoolGeneration: input.visiblePoolGeneration },
  ).scores[0];
  if (score === undefined) {
    throw new Error("COMMERCIAL_REASSESSMENT_SCORE_MISSING");
  }
  return Object.freeze({
    staticAssessment: assessment,
    score,
    state: stateFor(score),
    gateDecision: Object.freeze({
      decision: score.decision,
      hitGates: score.hitGates,
      missingEvidence: score.missingEvidence,
    }),
  });
}

async function insertRecommendationScore(
  client: CommercialCandidateReassessmentClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    recommendationId: string;
    prospectId: string;
    projectContextVersionId: string;
    sourceCandidateId: string;
    effectiveCandidateId: string;
    score: ReturnType<typeof evaluateCommercialCandidate>;
    generatedAt: Date;
    actorId: string;
  }>,
): Promise<void> {
  if (input.score.total === null) return;
  await client.query(
    `INSERT INTO backlink_recommendation_scores (
       id,organization_id,workspace_id,website_project_id,
       recommendation_id,prospect_id,recommendation_context_version_id,
       score_model_version,rule_version,total_score,components,weights,
       evidence,generated_at,created_by
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,
            $13::jsonb,$14,$15
      WHERE NOT EXISTS (
        SELECT 1
          FROM backlink_recommendation_scores
         WHERE organization_id=$2 AND workspace_id=$3
           AND website_project_id=$4 AND recommendation_id=$5
           AND score_model_version=$8 AND rule_version=$9
           AND evidence->>'effectiveCommercialCandidateId'=$16
      )`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationId,
      input.prospectId,
      input.projectContextVersionId,
      input.score.scoreModelVersion,
      input.score.ruleVersion,
      input.score.total,
      JSON.stringify(input.score.components),
      JSON.stringify(commercialFitWeights),
      JSON.stringify({
        reassessmentReason: "CURRENT_COMMERCIAL_V4_REASSESSED",
        sourceCommercialCandidateId: input.sourceCandidateId,
        effectiveCommercialCandidateId: input.effectiveCandidateId,
        sourceScoreModelVersion:
          input.sourceCandidateId === input.effectiveCandidateId
            ? commercialRecommendationFitModelVersion
            : "recommendation-commercial-fit.v3",
        projectContextVersionId: input.projectContextVersionId,
      }),
      input.generatedAt,
      input.actorId,
      input.effectiveCandidateId,
    ],
  );
}

export async function reassessCurrentCommercialCandidates(
  client: CommercialCandidateReassessmentClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    actorId: string;
    now: Date;
  }>,
): Promise<Readonly<{ reassessedCount: number }>> {
  const rows = await client.query(
    `SELECT candidate.id,
            candidate.score_model_version "sourceScoreModelVersion",
            candidate.blueprint_id "blueprintId",
            candidate.discovery_batch_id "discoveryBatchId",
            candidate.recommendation_id "recommendationId",
            candidate.prospect_id "prospectId",
            candidate.canonical_domain "canonicalDomain",
            candidate.source_types "sourceTypes",
            candidate.static_assessment "staticAssessment",
            candidate.gate_decision "gateDecision",
            candidate.commercial_score "commercialScore",
            candidate.provider_collected_at "providerCollectedAt",
            batch.refill_tier "refillTier",
            context.locale,
            context.country_code "countryCode"
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
        candidate.website_project_id,candidate.project_context_version_id
      )=($1,$2,$3,$4)
        AND candidate.visible_pool_generation=$7
        AND (
          (
            candidate.score_model_version='recommendation-commercial-fit.v3'
            AND NOT EXISTS (
              SELECT 1
                FROM backlink_commercial_candidates AS current_candidate
               WHERE (
                 current_candidate.organization_id,
                 current_candidate.workspace_id,
                 current_candidate.website_project_id,
                 current_candidate.project_context_version_id,
                 current_candidate.visible_pool_generation,
                 current_candidate.canonical_domain
               )=(
                 candidate.organization_id,candidate.workspace_id,
                 candidate.website_project_id,
                 candidate.project_context_version_id,
                 candidate.visible_pool_generation,
                 candidate.canonical_domain
               )
                 AND current_candidate.score_model_version=$5
            )
          )
          OR (
            candidate.score_model_version=$5
            AND (
              candidate.commercial_score->>'ruleVersion' IS DISTINCT FROM $6
              OR (
                candidate.commercial_score->>'decision'='eligible'
                AND (
                  candidate.static_assessment->>'decision'='manual_review'
                  OR EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(
                        CASE
                          WHEN jsonb_typeof(
                            candidate.commercial_score->'components'
                          )='array'
                            THEN candidate.commercial_score->'components'
                          ELSE '[]'::jsonb
                        END
                      ) AS component
                     WHERE component->>'state'='manual_review'
                    )
                )
              )
              OR (
                candidate.recommendation_id IS NULL
                AND candidate.prospect_id IS NULL
                AND candidate.state IN (
                  'excluded','insufficient_data','manual_review',
                  'candidate_ready'
                )
                AND candidate.state IS DISTINCT FROM
                  CASE candidate.commercial_score->>'decision'
                    WHEN 'eligible' THEN
                      CASE
                        WHEN EXISTS (
                          SELECT 1
                            FROM jsonb_array_elements_text(
                              CASE
                                WHEN jsonb_typeof(
                                  candidate.commercial_score
                                    ->'missingEvidence'
                                )='array'
                                  THEN candidate.commercial_score
                                    ->'missingEvidence'
                                ELSE '[]'::jsonb
                              END
                            ) AS evidence(value)
                           WHERE evidence.value LIKE 'gate.%'
                        ) THEN 'insufficient_data'
                        ELSE 'candidate_ready'
                      END
                    WHEN 'ineligible' THEN 'excluded'
                    WHEN 'insufficient_data' THEN 'insufficient_data'
                    ELSE 'manual_review'
                  END
              )
            )
          )
        )
        AND candidate.state<>'stale_context'
        AND (
          (
            candidate.recommendation_id IS NULL
            AND candidate.prospect_id IS NULL
          )
          OR (
            candidate.recommendation_id IS NOT NULL
            AND candidate.prospect_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM backlink_recommendation_inventory AS inventory
               WHERE (
                 inventory.organization_id,inventory.workspace_id,
                 inventory.website_project_id,inventory.recommendation_id,
                 inventory.prospect_id,
                 inventory.recommendation_context_version_id
               )=(
                 candidate.organization_id,candidate.workspace_id,
                 candidate.website_project_id,candidate.recommendation_id,
                 candidate.prospect_id,
                 candidate.project_context_version_id
               )
                 AND inventory.visible_pool_generation=
                     candidate.visible_pool_generation
            )
          )
        )
      ORDER BY candidate.created_at,candidate.id`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
      commercialRecommendationFitModelVersion,
      commercialRecommendationFitRuleVersion,
      input.visiblePoolGeneration,
    ],
  );

  let reassessedCount = 0;
  for (const row of rows.rows) {
    const evaluated = evaluateStoredCurrentCommercialCandidate({
      staticAssessment: row.staticAssessment,
      gateDecision: row.gateDecision,
      commercialScore: row.commercialScore,
      refillTier: row.refillTier,
      locale: row.locale,
      countryCode: row.countryCode,
      visiblePoolGeneration: input.visiblePoolGeneration,
    });
    const assessment = evaluated.staticAssessment;
    const score = evaluated.score;
    const gateDecision = JSON.stringify(evaluated.gateDecision);
    const sourceCandidateId = String(row.id);
    const sourceScoreModelVersion = String(row.sourceScoreModelVersion);
    const changed = sourceScoreModelVersion ===
        commercialRecommendationFitModelVersion
      ? await client.query(
        `UPDATE backlink_commercial_candidates AS candidate
            SET gate_decision=$6::jsonb,commercial_score=$7::jsonb,
                state=$8,updated_at=$9,updated_by=$10,version=version+1
          WHERE (
            candidate.organization_id,candidate.workspace_id,
            candidate.website_project_id,
            candidate.project_context_version_id,candidate.id
          )=($1,$2,$3,$4,$5)
            AND candidate.score_model_version=$11
            AND candidate.visible_pool_generation=$13
            AND candidate.state<>'stale_context'
            AND (
              candidate.commercial_score->>'ruleVersion'
                IS DISTINCT FROM $12
              OR candidate.gate_decision IS DISTINCT FROM $6::jsonb
              OR candidate.commercial_score IS DISTINCT FROM $7::jsonb
              OR (
                candidate.state IN (
                  'excluded','insufficient_data','manual_review',
                  'candidate_ready'
                )
                AND candidate.state IS DISTINCT FROM $8
              )
            )
        RETURNING candidate.id`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.projectContextVersionId,
          sourceCandidateId,
          gateDecision,
          JSON.stringify(score),
          evaluated.state,
          input.now,
          input.actorId,
          commercialRecommendationFitModelVersion,
          commercialRecommendationFitRuleVersion,
          input.visiblePoolGeneration,
        ],
      )
      : await client.query(
        `INSERT INTO backlink_commercial_candidates (
           id,organization_id,workspace_id,website_project_id,blueprint_id,
           discovery_batch_id,recommendation_id,prospect_id,
           project_context_version_id,visible_pool_generation,
           canonical_domain,source_types,static_assessment,gate_decision,
           commercial_score,score_model_version,state,provider_collected_at,
           created_by,updated_by
         )
         VALUES (
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
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          String(row.blueprintId),
          String(row.discoveryBatchId),
          row.recommendationId === null ? null : String(row.recommendationId),
          row.prospectId === null ? null : String(row.prospectId),
          input.projectContextVersionId,
          input.visiblePoolGeneration,
          String(row.canonicalDomain),
          JSON.stringify(row.sourceTypes),
          JSON.stringify(assessment),
          gateDecision,
          JSON.stringify(score),
          commercialRecommendationFitModelVersion,
          evaluated.state,
          row.providerCollectedAt ?? null,
          input.actorId,
        ],
      );
    const effectiveCandidateId = changed.rows[0]?.id;
    if (effectiveCandidateId === undefined) continue;
    reassessedCount += 1;

    if (
      row.recommendationId !== null &&
      row.prospectId !== null
    ) {
      await insertRecommendationScore(client, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        recommendationId: String(row.recommendationId),
        prospectId: String(row.prospectId),
        projectContextVersionId: input.projectContextVersionId,
        sourceCandidateId,
        effectiveCandidateId: String(effectiveCandidateId),
        score,
        generatedAt: input.now,
        actorId: input.actorId,
      });
      await synchronizeRecommendationContactState(client, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        prospectId: String(row.prospectId),
        recommendationContextVersionId: input.projectContextVersionId,
        actorId: input.actorId,
      });
    }
  }
  return Object.freeze({ reassessedCount });
}
