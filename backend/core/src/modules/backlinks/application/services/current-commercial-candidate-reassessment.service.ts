import { z } from "zod";

import { evaluateCommercialCandidate } from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../../domain/recommendations/commercial-score-v3.js";
import { commercialStaticAssessmentRuleVersion } from "../../domain/recommendations/commercial-static-assessment.js";

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

function stateFor(decision: string): string {
  switch (decision) {
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
            candidate.static_assessment "staticAssessment",
            candidate.gate_decision "gateDecision",
            candidate.commercial_score "commercialScore",
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
        AND candidate.score_model_version=$5
        AND candidate.commercial_score->>'ruleVersion'
              IS DISTINCT FROM $6
        AND candidate.recommendation_id IS NULL
        AND candidate.prospect_id IS NULL
        AND candidate.state NOT IN (
          'published','stale_context','contact_enrichment'
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
    const assessment = staticAssessmentSchema.parse(row.staticAssessment);
    const previousGate = gateDecisionSchema.parse(row.gateDecision);
    const previousScore = commercialScoreSchema.parse(row.commercialScore);
    const previousHitGates = new Set(previousGate.hitGates);
    const refillTier = String(row.refillTier);
    const score = evaluateCommercialCandidate({
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
        targetCountryCode: String(row.countryCode),
        candidateCountryCode: previousScore.details.market.candidateCountry,
        targetLanguages: [String(row.locale)],
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
        evidenceRefs: previousScore.details.dataForSeo.evidenceRefs,
        collectedAt: previousScore.details.dataForSeo.collectedAt,
      },
      staticAssessment: assessment,
    });
    const updated = await client.query(
      `UPDATE backlink_commercial_candidates
          SET gate_decision=$6::jsonb,commercial_score=$7::jsonb,
              state=CASE
                WHEN state='contact_enrichment' AND $8='candidate_ready'
                  THEN state
                ELSE $8
              END,
              updated_at=$9,updated_by=$10,version=version+1
        WHERE (
          organization_id,workspace_id,website_project_id,
          project_context_version_id,id
        )=($1,$2,$3,$4,$5)
          AND score_model_version=$11
          AND commercial_score->>'ruleVersion' IS DISTINCT FROM $12
          AND visible_pool_generation=$13
        RETURNING id`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.projectContextVersionId,
        String(row.id),
        JSON.stringify({
          decision: score.decision,
          hitGates: score.hitGates,
          missingEvidence: score.missingEvidence,
        }),
        JSON.stringify(score),
        stateFor(score.decision),
        input.now,
        input.actorId,
        commercialRecommendationFitModelVersion,
        commercialRecommendationFitRuleVersion,
        input.visiblePoolGeneration,
      ],
    );
    reassessedCount += updated.rows.length;
  }
  return Object.freeze({ reassessedCount });
}
