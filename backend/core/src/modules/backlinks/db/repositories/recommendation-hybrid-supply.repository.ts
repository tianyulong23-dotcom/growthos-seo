import type { RecommendationHybridSupplyFacts } from "../../application/services/recommendation-hybrid-supply.service.js";
import type { ProjectDomainRatingCache } from "../../application/services/project-domain-rating.service.js";
import type { RecommendationPoolV2CandidateLineage } from "./recommendation-pool-v2-candidate.repository.js";
import type { BacklinkTenantContext, BacklinkTransactionClient } from "../tenant-transaction.js";

const scopeValues = (scope: BacklinkTenantContext) =>
  [scope.organizationId, scope.workspaceId, scope.websiteProjectId];
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];

export function createRecommendationHybridSupplyRepository(client: BacklinkTransactionClient) {
  return Object.freeze({
    async load(input: RecommendationPoolV2CandidateLineage): Promise<RecommendationHybridSupplyFacts> {
      const result = await client.query(`
        SELECT g.effective_unique_candidate_count AS "effectiveCount",
               (EXISTS (
                 SELECT 1 FROM backlinks.backlink_recommendation_discovery_request_intents intent
                 WHERE (intent.organization_id,intent.workspace_id,intent.website_project_id,
                        intent.generation_contract_id)=
                       (g.organization_id,g.workspace_id,g.website_project_id,g.id)
               ) OR EXISTS (
                 SELECT 1 FROM backlinks.backlink_recommendation_discovery_round_facts round_fact
                 WHERE (round_fact.organization_id,round_fact.workspace_id,round_fact.website_project_id,
                        round_fact.generation_contract_id)=
                       (g.organization_id,g.workspace_id,g.website_project_id,g.id)
               )) AS "discoveryStarted",
               context.canonical_domain AS "projectDomain", profile.language,
               profile.keywords_and_topics AS keywords, profile.products_and_services AS products,
               profile.partnership_goals AS categories
        FROM backlinks.backlink_recommendation_generation_contracts g
        JOIN backlinks.backlink_project_context_snapshots context
          ON (context.organization_id,context.workspace_id,context.website_project_id,context.id)=
             (g.organization_id,g.workspace_id,g.website_project_id,g.recommendation_context_version_id)
        JOIN backlinks.backlink_generation_input_pins pin
          ON (pin.organization_id,pin.workspace_id,pin.website_project_id,pin.id)=
             (g.organization_id,g.workspace_id,g.website_project_id,g.input_pin_id)
        JOIN backlinks.backlink_outreach_profile_versions profile
          ON (profile.organization_id,profile.workspace_id,profile.website_project_id,profile.id)=
             (pin.organization_id,pin.workspace_id,pin.website_project_id,pin.outreach_profile_version_id)
        WHERE g.organization_id=$1 AND g.workspace_id=$2 AND g.website_project_id=$3
          AND g.id=$4 AND g.recommendation_context_version_id=$5
          AND g.visible_pool_generation=$6 AND g.input_pin_id=$7
          AND g.pool_contract_version='recommendation-pool.v2'
        FOR UPDATE OF g`,
      [...scopeValues(input), input.generationContractId, input.recommendationContextVersionId,
        input.visiblePoolGeneration, input.inputPinId]);
      const row = result.rows[0];
      if (row === undefined) throw new Error("RECOMMENDATION_POOL_V2_GENERATION_CONTRACT_MISSING");
      const finalized = row.effectiveCount !== null;
      if (finalized) return {
        finalized: true, projectDomain: String(row.projectDomain), language: String(row.language),
        topics: [], excludedDomains: [], admittedCount: 0, dataForSeoCount: 0,
      };
      const counts = await client.query(`
        SELECT count(*)::int AS admitted,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM backlinks.backlink_recommendation_generation_candidate_sources source
            WHERE source.organization_id=c.organization_id AND source.workspace_id=c.workspace_id
              AND source.website_project_id=c.website_project_id AND source.generation_candidate_id=c.id
              AND source.source_type<>'CURATED_RESOURCE_LIBRARY'
          ))::int AS dfs
        FROM backlinks.backlink_recommendation_generation_candidates c
        WHERE c.organization_id=$1 AND c.workspace_id=$2 AND c.website_project_id=$3
          AND c.generation_contract_id=$4 AND c.admission_state='ADMITTED'`,
      [...scopeValues(input), input.generationContractId]);
      const libraryCounts = await client.query(`
        SELECT (source.evidence_payload->'resourceLibrary'->>'releaseBatchOrdinal')::int AS ordinal,
               count(DISTINCT c.id)::int AS count
        FROM backlinks.backlink_recommendation_generation_candidates c
        JOIN backlinks.backlink_recommendation_generation_candidate_sources source
          ON (source.organization_id,source.workspace_id,source.website_project_id,source.generation_candidate_id)=
             (c.organization_id,c.workspace_id,c.website_project_id,c.id)
        WHERE c.organization_id=$1 AND c.workspace_id=$2 AND c.website_project_id=$3
          AND c.generation_contract_id=$4 AND c.admission_state='ADMITTED'
          AND source.source_type='CURATED_RESOURCE_LIBRARY'
        GROUP BY 1`, [...scopeValues(input), input.generationContractId]);
      const history = await client.query(`
        SELECT canonical_domain AS domain FROM backlinks.backlink_recommendation_generation_candidates
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
        UNION SELECT canonical_domain FROM backlinks.backlink_recommendation_release_batch_items
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
        UNION SELECT target_site_key FROM backlinks.backlink_opportunities
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
        UNION SELECT canonical_domain FROM backlinks.backlink_project_context_snapshots
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3`,
      scopeValues(input));
      return {
        finalized, projectDomain: String(row.projectDomain), language: String(row.language),
        topics: [...strings(row.keywords), ...strings(row.products), ...strings(row.categories)],
        excludedDomains: history.rows.map((item) => String(item.domain)),
        admittedCount: Number(counts.rows[0]?.admitted ?? 0),
        dataForSeoCount: Number(counts.rows[0]?.dfs ?? 0),
        libraryBatchCounts: Object.fromEntries(
          libraryCounts.rows.map((item) => [Number(item.ordinal), Number(item.count)]),
        ),
        discoveryStarted: row.discoveryStarted === true,
      };
    },
    async lockProject(input: BacklinkTenantContext): Promise<void> {
      // Use existing project rows to serialize cache misses; no separate distributed lock.
      const result = await client.query(`
        SELECT id FROM backlinks.backlink_project_context_snapshots
        WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
        ORDER BY id FOR UPDATE`, scopeValues(input));
      if (result.rows.length === 0) throw new Error("PROJECT_DOMAIN_RATING_PROJECT_MISSING");
    },
    async readRating(input: BacklinkTenantContext, target: string): Promise<ProjectDomainRatingCache | null> {
      const result = await client.query(`
        SELECT target,domain_rating AS value,observed_at AS "observedAt",
               expires_at AS "expiresAt",failure_code AS "failureCode"
        FROM backlinks.backlink_project_domain_ratings
        WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3 AND target=$4`,
      [...scopeValues(input), target]);
      const row = result.rows[0];
      return row === undefined ? null : {
        target: String(row.target), value: row.value === null ? null : Number(row.value),
        observedAt: new Date(String(row.observedAt)).toISOString(),
        expiresAt: new Date(String(row.expiresAt)).toISOString(),
        failureCode: row.failureCode === null ? null : String(row.failureCode),
      };
    },
    async saveRating(input: BacklinkTenantContext, value: ProjectDomainRatingCache): Promise<void> {
      await client.query(`
        INSERT INTO backlinks.backlink_project_domain_ratings
          (organization_id,workspace_id,website_project_id,target,domain_rating,observed_at,expires_at,failure_code)
        VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8)
        ON CONFLICT (organization_id,workspace_id,website_project_id,target) DO UPDATE
        SET domain_rating=EXCLUDED.domain_rating, observed_at=EXCLUDED.observed_at,
            expires_at=EXCLUDED.expires_at,failure_code=EXCLUDED.failure_code`,
      [...scopeValues(input), value.target, value.value, value.observedAt, value.expiresAt, value.failureCode]);
    },
  });
}
