import type {
  ResolvedProjectContext,
} from "../../ports/project-context.port.js";
import {
  calculateProjectAuthority,
  resourceAuthorityMatch,
  type ProjectAuthority,
} from "../../domain/recommendations/resource-library-authority.js";

export const resourceLibraryQualityBuckets = [
  "recommend",
  "review",
  "avoid",
  "unclassified",
] as const;

export type ResourceLibraryQualityBucket =
  (typeof resourceLibraryQualityBuckets)[number];

export type ResourceLibraryItem = Readonly<{
  key: string;
  domain: string;
  url: string;
  websiteName: string;
  resourceType: "free" | "paid";
  categories: readonly string[];
  tags: readonly string[];
  countryLanguage: string | null;
  domainAuthority: number | null;
  monthlyOrganicTraffic: number | null;
  dataForSeoRank: number | null;
  spamScore: number | null;
  profileHealthScore: number | null;
  authorityScore: number;
  authorityMatch: "stronger" | "matched" | "below";
  qualityBucket: ResourceLibraryQualityBucket;
  qualityReviewed: boolean;
  riskLevel: string | null;
  recommendation: string | null;
  referringDomains: number | null;
  backlinks: number | null;
  autoSupplementEligible: boolean;
  sourceGeneratedAt: string;
}>;

export type ResourceLibraryPage = Readonly<{
  projectAuthority: ProjectAuthority;
  summary: Readonly<{
    total: number;
    free: number;
    paid: number;
    recommend: number;
    review: number;
    avoid: number;
    unclassified: number;
    autoEligible: number;
    authorityMatchedAutoEligible: number;
  }>;
  items: readonly ResourceLibraryItem[];
}>;

export type ResourceLibraryListInput = Readonly<{
  search?: string | undefined;
  qualityBucket?: ResourceLibraryQualityBucket | undefined;
  resourceType?: "free" | "paid" | undefined;
  limit: number;
}>;

export type ResourceLibraryQuery = Readonly<{
  listResourceLibrary(
    context: ResolvedProjectContext,
    input: ResourceLibraryListInput,
  ): Promise<ResourceLibraryPage>;
}>;

export type ResourceLibraryQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.map(String) : [];

const isoString = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date(0).toISOString();
};

export function createResourceLibraryQuery(
  client: ResourceLibraryQueryClient,
): ResourceLibraryQuery {
  return Object.freeze({
    async listResourceLibrary(context, input) {
      const authorityResult = await client.query(
        `SELECT referring_domains "referringDomains"
           FROM backlink_profile_snapshots
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
            AND completeness<>'unavailable'
          ORDER BY observed_at DESC,id DESC
          LIMIT 1`,
        [
          context.tenant.organizationId,
          context.tenant.workspaceId,
          context.project.websiteProjectId,
        ],
      );
      const projectAuthority = calculateProjectAuthority(
        optionalNumber(authorityResult.rows[0]?.referringDomains),
      );
      const search = input.search?.trim() ?? "";
      const result = await client.query(
        `WITH filtered AS (
           SELECT *
             FROM backlink_resource_library_items
            WHERE organization_id=$1 AND workspace_id=$2
              AND active=true
              AND ($3='' OR website_name ILIKE '%' || $3 || '%'
                   OR canonical_domain ILIKE '%' || $3 || '%'
                   OR categories::text ILIKE '%' || $3 || '%')
              AND ($4::text IS NULL OR quality_bucket=$4)
              AND ($5::text IS NULL OR resource_type=$5)
         ),
         summary AS (
           SELECT count(*)::integer total,
                  count(*) FILTER (WHERE resource_type='free')::integer free,
                  count(*) FILTER (WHERE resource_type='paid')::integer paid,
                  count(*) FILTER (
                    WHERE quality_bucket='recommend'
                  )::integer recommend,
                  count(*) FILTER (
                    WHERE quality_bucket='review'
                  )::integer review,
                  count(*) FILTER (
                    WHERE quality_bucket='avoid'
                  )::integer avoid,
                  count(*) FILTER (
                    WHERE quality_bucket='unclassified'
                  )::integer unclassified,
                  count(*) FILTER (
                    WHERE quality_bucket='recommend'
                      AND quality_reviewed=true AND risk_level='low'
                  )::integer auto_eligible,
                  count(*) FILTER (
                    WHERE quality_bucket='recommend'
                      AND quality_reviewed=true AND risk_level='low'
                      AND authority_score >= $6
                  )::integer authority_matched
             FROM filtered
         )
         SELECT item.resource_key "key",
                item.canonical_domain domain,
                item.canonical_url url,
                item.website_name "websiteName",
                item.resource_type "resourceType",
                item.categories,item.tags,
                item.country_language "countryLanguage",
                item.domain_authority "domainAuthority",
                item.monthly_organic_traffic "monthlyOrganicTraffic",
                item.dataforseo_rank "dataForSeoRank",
                item.spam_score "spamScore",
                item.profile_health_score "profileHealthScore",
                item.authority_score "authorityScore",
                item.quality_bucket "qualityBucket",
                item.quality_reviewed "qualityReviewed",
                item.risk_level "riskLevel",
                item.recommendation,
                item.referring_domains "referringDomains",
                item.backlinks,
                item.source_generated_at "sourceGeneratedAt",
                summary.*
           FROM summary
           LEFT JOIN LATERAL (
             SELECT *
               FROM filtered
              ORDER BY authority_score DESC,canonical_domain
              LIMIT $7
           ) AS item ON true
          ORDER BY item.authority_score DESC NULLS LAST,
                   item.canonical_domain NULLS LAST`,
        [
          context.tenant.organizationId,
          context.tenant.workspaceId,
          search,
          input.qualityBucket ?? null,
          input.resourceType ?? null,
          projectAuthority.minimumResourceAuthorityScore,
          input.limit,
        ],
      );
      const first = result.rows[0] ?? {};
      const items = result.rows.filter((row) => row.key !== null).map((row) => {
        const authorityScore = Number(row.authorityScore);
        const qualityBucket =
          row.qualityBucket as ResourceLibraryQualityBucket;
        const qualityReviewed = row.qualityReviewed === true;
        const riskLevel = row.riskLevel === null
          ? null
          : String(row.riskLevel);
        return Object.freeze({
          key: String(row.key),
          domain: String(row.domain),
          url: String(row.url),
          websiteName: String(row.websiteName),
          resourceType: row.resourceType as "free" | "paid",
          categories: stringArray(row.categories),
          tags: stringArray(row.tags),
          countryLanguage: row.countryLanguage === null
            ? null
            : String(row.countryLanguage),
          domainAuthority: optionalNumber(row.domainAuthority),
          monthlyOrganicTraffic: optionalNumber(row.monthlyOrganicTraffic),
          dataForSeoRank: optionalNumber(row.dataForSeoRank),
          spamScore: optionalNumber(row.spamScore),
          profileHealthScore: optionalNumber(row.profileHealthScore),
          authorityScore,
          authorityMatch: resourceAuthorityMatch(
            authorityScore,
            projectAuthority,
          ),
          qualityBucket,
          qualityReviewed,
          riskLevel,
          recommendation: row.recommendation === null
            ? null
            : String(row.recommendation),
          referringDomains: optionalNumber(row.referringDomains),
          backlinks: optionalNumber(row.backlinks),
          autoSupplementEligible: qualityBucket === "recommend"
            && qualityReviewed
            && riskLevel === "low"
            && authorityScore
              >= projectAuthority.minimumResourceAuthorityScore,
          sourceGeneratedAt: isoString(row.sourceGeneratedAt),
        } satisfies ResourceLibraryItem);
      });
      return Object.freeze({
        projectAuthority,
        summary: Object.freeze({
          total: Number(first.total ?? 0),
          free: Number(first.free ?? 0),
          paid: Number(first.paid ?? 0),
          recommend: Number(first.recommend ?? 0),
          review: Number(first.review ?? 0),
          avoid: Number(first.avoid ?? 0),
          unclassified: Number(first.unclassified ?? 0),
          autoEligible: Number(first.auto_eligible ?? 0),
          authorityMatchedAutoEligible: Number(first.authority_matched ?? 0),
        }),
        items: Object.freeze(items),
      });
    },
  });
}
