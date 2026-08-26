import { z } from "zod";

import {
  selectCommercialCandidateEnrichment,
  commercialCandidateEnrichmentMaximumCandidates,
} from "../../domain/recommendations/commercial-candidate-enrichment.js";
import type { CommercialCandidateFitDecision } from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  commercialDiscoverySourceTypes,
} from "../../domain/recommendations/commercial-discovery-source.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialFitComponentIds,
  commercialFitHardGateIds,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../../domain/recommendations/commercial-score-v4.js";
import {
  commercialStaticAssessmentRuleVersion,
  type CommercialStaticAssessment,
} from "../../domain/recommendations/commercial-static-assessment.js";
import type { CommercialReadyCandidate } from "./commercial-recommendation-discovery.service.js";

export type CurrentCommercialCandidateEnrichmentClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type CurrentCommercialCandidateEnrichment = CommercialReadyCandidate &
  Readonly<{ candidateId: string }>;

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
    hitGates: z.array(z.enum(commercialFitHardGateIds)),
  })
  .passthrough();
const commercialScoreSchema = z
  .object({
    decision: z.enum([
      "eligible",
      "ineligible",
      "insufficient_data",
      "manual_review",
    ]),
    scoreModelVersion: z.literal(commercialRecommendationFitModelVersion),
    ruleVersion: z.literal(commercialRecommendationFitRuleVersion),
    total: z.number().min(0).max(100).nullable(),
    components: z.array(
      z
        .object({
          id: z.enum(commercialFitComponentIds),
          points: z.number().min(0).max(100).nullable(),
        })
        .passthrough(),
    ),
    hitGates: z.array(z.enum(commercialFitHardGateIds)),
    missingEvidence: stringArraySchema,
    admission: z.object({}).passthrough(),
    details: z
      .object({
        authority: z
          .object({
            projectAuthority: z.number().min(0).max(100),
          })
          .passthrough(),
        market: z
          .object({
            candidateCountry: z.string().nullable(),
            tier: z.enum([
              "target_market",
              "same_language_expansion",
              "market_language_mismatch",
            ]),
          })
          .passthrough(),
        dataForSeo: z
          .object({
            rank: z.number().nullable(),
            traffic: z.number().nullable(),
            backlinks: z.number().nullable(),
            referringDomains: z.number().nullable(),
            spamScore: z.number().nullable(),
            backlinkPageEvidence: z.array(z.unknown()).default([]),
            evidenceRefs: stringArraySchema.default([]),
            collectedAt: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
const sourceTypesSchema = z.array(z.enum(commercialDiscoverySourceTypes));

const targetMarketScopedTiers = new Set([
  "exact_product_target_market",
  "same_topic_target_market",
  "adjacent_industry_same_audience",
  "resource_media_review_partner_ecosystem",
]);

function storedCandidate(
  row: Readonly<Record<string, unknown>>,
): CurrentCommercialCandidateEnrichment {
  const assessment = staticAssessmentSchema.parse(
    row.staticAssessment,
  ) as CommercialStaticAssessment;
  const gate = gateDecisionSchema.parse(row.gateDecision);
  const score = commercialScoreSchema.parse(
    row.commercialScore,
  ) as unknown as CommercialCandidateFitDecision;
  const refillTier = z.string().parse(row.refillTier);
  const provider = score.details.dataForSeo;
  return Object.freeze({
    candidateId: z.string().uuid().parse(row.candidateId),
    hostnameAscii: z.string().parse(row.canonicalDomain),
    sourceTypes: Object.freeze(sourceTypesSchema.parse(row.sourceTypes)),
    business: Object.freeze({
      selfOrRelatedDomain: gate.hitGates.includes("self_or_related_domain"),
      existingBacklinkOrOpportunity: gate.hitGates.includes(
        "existing_backlink_or_opportunity",
      ),
      permanentlyRejectedOrSuppressed: gate.hitGates.includes(
        "permanently_rejected_or_suppressed",
      ),
      unsafeOrDisallowedIndustry: gate.hitGates.includes(
        "unsafe_or_disallowed",
      ),
      projectAuthorityScore: score.details.authority.projectAuthority,
      targetCountryCode: z.string().parse(row.countryCode),
      candidateCountryCode: score.details.market.candidateCountry,
      targetLanguages: Object.freeze([z.string().parse(row.locale)]),
      allowSameLanguageExpansion: [
        "same_language_expansion",
        "curated_resource_library",
      ].includes(refillTier),
      targetMarketScopedDiscovery: targetMarketScopedTiers.has(refillTier),
    }),
    provider: Object.freeze({
      rank: provider.rank,
      traffic: provider.traffic,
      backlinkCount: provider.backlinks,
      referringDomainCount: provider.referringDomains,
      spamScore: provider.spamScore,
      countryCode: score.details.market.candidateCountry,
      backlinkPageEvidence: Object.freeze([
        ...provider.backlinkPageEvidence,
      ]) as CommercialReadyCandidate["provider"]["backlinkPageEvidence"],
      evidenceRefs: Object.freeze([...provider.evidenceRefs]),
      collectedAt: provider.collectedAt,
    }),
    staticAssessment: assessment,
    commercialScore: score,
  });
}

export async function prepareCurrentCommercialCandidateEnrichment(
  client: CurrentCommercialCandidateEnrichmentClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    actorId: string;
    now: Date;
    generationInputFingerprint?: string;
    maximumCandidates?: number;
    apply: boolean;
  }>,
): Promise<Readonly<{
  candidates: readonly CurrentCommercialCandidateEnrichment[];
  publishableCandidates: readonly CurrentCommercialCandidateEnrichment[];
  decisions: ReturnType<
    typeof selectCommercialCandidateEnrichment
  >["decisions"];
  preparedCount: number;
}>> {
  const maximumCandidates = input.maximumCandidates
    ?? commercialCandidateEnrichmentMaximumCandidates;
  const result = await client.query(
    `SELECT candidate.id::text AS "candidateId",
            candidate.canonical_domain "canonicalDomain",
            candidate.source_types "sourceTypes",
            candidate.static_assessment "staticAssessment",
            candidate.gate_decision "gateDecision",
            candidate.commercial_score "commercialScore",
            candidate.state,
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
        AND candidate.commercial_score->>'ruleVersion'=$6
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_project_context_snapshots AS newer_context
           WHERE (
             newer_context.organization_id,newer_context.workspace_id,
             newer_context.website_project_id
           )=(
             context.organization_id,context.workspace_id,
             context.website_project_id
           )
             AND newer_context.snapshot_version>context.snapshot_version
        )
        AND 1=(
          SELECT count(*)
            FROM backlink_generation_input_pins AS input_pin
           WHERE (
             input_pin.organization_id,input_pin.workspace_id,
             input_pin.website_project_id
           )=(
             context.organization_id,context.workspace_id,
             context.website_project_id
           )
             AND input_pin.project_context_version=context.snapshot_version
             AND input_pin.site_profile_version_id=
                 context.profile_version_id
             AND input_pin.promotion_target_version_id=
                 context.promotion_target_version_id
             AND input_pin.market=context.country_code
             AND (
               $8::text IS NULL
               OR input_pin.immutable_fingerprint=$8
             )
        )
        AND candidate.state NOT IN ('published','stale_context','excluded')
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
                 AND inventory.publication_status='NOT_PUBLISHED'
            )
          )
        )
      ORDER BY (candidate.commercial_score->>'total')::numeric DESC NULLS LAST,
               candidate.canonical_domain,candidate.id`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
      commercialRecommendationFitModelVersion,
      commercialRecommendationFitRuleVersion,
      input.visiblePoolGeneration,
      input.generationInputFingerprint ?? null,
    ],
  );
  const candidates = result.rows.map(storedCandidate);
  const publishableCandidates = candidates.filter((candidate) =>
    candidate.commercialScore.decision === "eligible"
    && candidate.commercialScore.hitGates.length === 0
    && candidate.commercialScore.total !== null
    && candidate.commercialScore.total
      >= commercialFitBaselineAdmissionThreshold
  );
  const publishableDomains = new Set(
    publishableCandidates.map(({ hostnameAscii }) => hostnameAscii),
  );
  const selected = selectCommercialCandidateEnrichment(
    candidates.filter(({ hostnameAscii }) =>
      !publishableDomains.has(hostnameAscii)
    ),
    {
    maximumCandidates,
    },
  );
  let preparedCount = 0;
  if (input.apply) {
    const decisions = new Map(
      selected.decisions.map((decision) => [
        decision.hostnameAscii,
        decision,
      ]),
    );
    for (const candidate of selected.candidates) {
      const decision = decisions.get(candidate.hostnameAscii);
      const updated = await client.query(
        `UPDATE backlink_commercial_candidates
            SET state='enrichment_eligible',
                gate_decision=
                  COALESCE(gate_decision,'{}'::jsonb)
                  || $6::jsonb,
                updated_at=$7,updated_by=$8,version=version+1
          WHERE (
            organization_id,workspace_id,website_project_id,
            project_context_version_id,id
          )=($1,$2,$3,$4,$5)
            AND score_model_version=$9
            AND visible_pool_generation=$11
            AND commercial_score->>'ruleVersion'=$10
            AND EXISTS (
              SELECT 1
                FROM backlink_project_context_snapshots AS context
               WHERE (
                 context.organization_id,context.workspace_id,
                 context.website_project_id,context.id
               )=(
                 backlink_commercial_candidates.organization_id,
                 backlink_commercial_candidates.workspace_id,
                 backlink_commercial_candidates.website_project_id,
                 backlink_commercial_candidates.project_context_version_id
               )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM backlink_project_context_snapshots AS newer_context
                    WHERE (
                      newer_context.organization_id,
                      newer_context.workspace_id,
                      newer_context.website_project_id
                    )=(
                      context.organization_id,context.workspace_id,
                      context.website_project_id
                    )
                      AND newer_context.snapshot_version>
                          context.snapshot_version
                 )
                 AND 1=(
                   SELECT count(*)
                     FROM backlink_generation_input_pins AS input_pin
                    WHERE (
                      input_pin.organization_id,input_pin.workspace_id,
                      input_pin.website_project_id
                    )=(
                      context.organization_id,context.workspace_id,
                      context.website_project_id
                    )
                      AND input_pin.project_context_version=
                          context.snapshot_version
                      AND input_pin.site_profile_version_id=
                          context.profile_version_id
                      AND input_pin.promotion_target_version_id=
                          context.promotion_target_version_id
                      AND input_pin.market=context.country_code
                      AND (
                        $12::text IS NULL
                        OR input_pin.immutable_fingerprint=$12
                      )
                 )
            )
            AND state NOT IN (
              'published','stale_context','excluded','enrichment_eligible'
            )
        RETURNING id::text AS "candidateId"`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.projectContextVersionId,
          candidate.candidateId,
          JSON.stringify({
            enrichment: {
              decision: "selected",
              currentScore: decision?.currentScore ?? null,
              maximumReachableScore:
                decision?.maximumReachableScore ?? null,
              maximumCandidates,
            },
          }),
          input.now,
          input.actorId,
          commercialRecommendationFitModelVersion,
          commercialRecommendationFitRuleVersion,
          input.visiblePoolGeneration,
          input.generationInputFingerprint ?? null,
        ],
      );
      preparedCount += updated.rows.length;
    }
  }
  return Object.freeze({
    candidates: Object.freeze([...selected.candidates]),
    publishableCandidates: Object.freeze([...publishableCandidates]),
    decisions: selected.decisions,
    preparedCount,
  });
}
