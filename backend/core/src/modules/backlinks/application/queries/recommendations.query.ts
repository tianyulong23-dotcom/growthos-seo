import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import {
  toPublicAssessment,
  type PublicAssessment,
} from "../../domain/assessments/public-assessment.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export const recommendationInventoryStatuses = [
  "ready",
  "claimed",
  "shown",
  "rejected",
  "stale_context",
  "accepted",
] as const;
export type RecommendationInventoryStatus =
  (typeof recommendationInventoryStatuses)[number];

export type RecommendationContactEvidence = {
  id: string;
  sourceUrl: string;
  observedAt: string;
  extractionMethod:
    | "mailto"
    | "visible_text"
    | "obfuscated_text"
    | "json_ld"
    | "manual";
  evidenceSnippet: string;
  confidence: number;
};
export type RecommendationContactCandidate = {
  id: string;
  normalizedEmail: string;
  domainRelation: string;
  confidence: number;
  inferredPurpose: string;
  purposeConfidence: number;
  guessed: boolean;
  version: number;
  eligible: boolean;
  contactReviewRequired: boolean;
  evidence: RecommendationContactEvidence[];
};
export type RecommendationContactJob = {
  id: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "partially_completed"
    | "no_contact_found"
    | "retry_scheduled";
  candidateCount: number;
  evidenceCount: number;
  pagesVisited: number;
  lastErrorCode: string | null;
  retryAfter: string | null;
};
export type RecommendationListItem = {
  id: string;
  hostname: string;
  score: number;
  status: RecommendationInventoryStatus;
  recommendationContextVersionId: string;
  version: number;
  scoreModelVersion: string;
  ruleVersion: string;
  assessment: PublicAssessment;
  rootUrl: string;
  faviconUrl: string;
  acquiredAt: string;
  matchReasons: string[];
  dataSources: string[];
  seoMetrics: {
    authority: number | null;
    editorialQuality: number | null;
    technicalHealth: number | null;
  };
  contactStatus: "contactable" | "running" | "review" | "not_found";
  contactJob: RecommendationContactJob | null;
  contacts: RecommendationContactCandidate[];
  recommendedContactCandidateId: string | null;
  existingOpportunityId: string | null;
  canCreateOpportunity: boolean;
  createBlockReason:
    | "existing_opportunity"
    | "no_eligible_contact"
    | null;
};
export type RecommendationsListInput = Readonly<{
  status?: RecommendationListItem["status"] | undefined;
  minScore?: number | undefined;
  limit: number;
  cursor?: string | undefined;
}>;
export type RecommendationPage = Readonly<{
  items: RecommendationListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}>;
export type RecommendationsQuery = Readonly<{
  listRecommendations(
    context: ResolvedProjectContext,
    input: RecommendationsListInput,
  ): Promise<RecommendationPage>;
}>;
export type RecommendationsQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
type Cursor = readonly [number, string, string];

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest,
  message: "Recommendation cursor is invalid.",
  fieldErrors: [{ field: "cursor", message: "Use a cursor returned by this API." }],
});

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || typeof parsed[0] !== "number"
      || !Number.isFinite(parsed[0])
      || typeof parsed[1] !== "string"
      || parsed[1].length === 0
      || typeof parsed[2] !== "string"
      || parsed[2].length === 0
    ) {
      throw invalidCursor();
    }
    return parsed as unknown as Cursor;
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

const encodeCursor = (item: RecommendationListItem) =>
  Buffer.from(JSON.stringify([item.score, item.hostname, item.id]))
    .toString("base64url");

const toIsoString = (value: unknown) => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date(0).toISOString();
};
const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const arrayValue = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];
const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toContactEvidence(value: unknown): RecommendationContactEvidence {
  const item = objectValue(value);
  return {
    id: String(item.id),
    sourceUrl: String(item.sourceUrl),
    observedAt: toIsoString(item.observedAt),
    extractionMethod:
      item.extractionMethod as RecommendationContactEvidence["extractionMethod"],
    evidenceSnippet: String(item.evidenceSnippet),
    confidence: Number(item.confidence),
  };
}

function toContactCandidate(value: unknown): RecommendationContactCandidate {
  const item = objectValue(value);
  return {
    id: String(item.id),
    normalizedEmail: String(item.normalizedEmail),
    domainRelation: String(item.domainRelation),
    confidence: Number(item.confidence),
    inferredPurpose: String(item.inferredPurpose),
    purposeConfidence: Number(item.purposeConfidence),
    guessed: item.guessed === true,
    version: Number(item.version),
    eligible: item.eligible === true,
    contactReviewRequired: item.contactReviewRequired === true,
    evidence: arrayValue(item.evidence).map(toContactEvidence),
  };
}

function toContactJob(value: unknown): RecommendationContactJob | null {
  if (value === null || value === undefined) return null;
  const item = objectValue(value);
  return {
    id: String(item.id),
    status: item.status as RecommendationContactJob["status"],
    candidateCount: Number(item.candidateCount),
    evidenceCount: Number(item.evidenceCount),
    pagesVisited: Number(item.pagesVisited),
    lastErrorCode: nullableString(item.lastErrorCode),
    retryAfter: item.retryAfter === null || item.retryAfter === undefined
      ? null
      : toIsoString(item.retryAfter),
  };
}

function metric(
  assessment: PublicAssessment,
  id: PublicAssessment["components"][number]["id"],
): number | null {
  return assessment.components.find((component) => component.id === id)?.points
    ?? null;
}

function toWebsiteUrl(hostname: string, value: unknown): string {
  try {
    return new URL(String(value)).toString();
  } catch {
    return `https://${hostname}/`;
  }
}

export function createRecommendationsQuery(
  client: RecommendationsQueryClient,
): RecommendationsQuery {
  return Object.freeze({
    async listRecommendations(context, input) {
      const after = decodeCursor(input.cursor);
      const result = await client.query(`
        SELECT r.id,p.hostname_ascii "hostname",
               s.total_score::double precision "score",
               i.status,
               i.recommendation_context_version_id
                 "recommendationContextVersionId",
               i.version,i.created_at "acquiredAt",
               s.id "scoreId",s.score_model_version "scoreModelVersion",
               s.rule_version "ruleVersion",s.components "scoreComponents",
               s.evidence "scoreEvidence",s.generated_at "scoreGeneratedAt",
               COALESCE(
                 j.root_url,'https://' || p.hostname_ascii || '/'
               ) "rootUrl",
               CASE
                 WHEN o.id IS NOT NULL THEN 'existing_opportunity'
                 WHEN COALESCE(c.has_eligible,false)=false
                   THEN 'no_eligible_contact'
                 ELSE NULL
               END "createBlockReason",
               COALESCE(c.has_eligible,false)
                 AND o.id IS NULL "canCreateOpportunity",
               c.contacts,
               c.recommended_candidate_id "recommendedContactCandidateId",
               CASE
                 WHEN COALESCE(c.has_eligible_without_review,false)
                   THEN 'contactable'
                 WHEN COALESCE(c.has_eligible,false) THEN 'review'
                 WHEN j.status IN ('pending','running','retry_scheduled')
                   THEN 'running'
                 ELSE 'not_found'
               END "contactStatus",
               CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
                 'id',j.id,
                 'status',j.status,
                 'candidateCount',j.candidate_count,
                 'evidenceCount',j.evidence_count,
                 'pagesVisited',j.pages_visited,
                 'lastErrorCode',j.last_error_code,
                 'retryAfter',j.retry_after
               ) END "contactJob",
               o.id "existingOpportunityId"
          FROM backlink_recommendation_inventory i
          JOIN backlink_recommendations r ON
            (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             i.recommendation_id)
          JOIN backlink_prospects p ON
            (p.organization_id,p.workspace_id,p.website_project_id,p.id)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             i.prospect_id)
          JOIN LATERAL (
            SELECT id,total_score,score_model_version,rule_version,
                   components,evidence,generated_at
              FROM backlink_recommendation_scores s
             WHERE (s.organization_id,s.workspace_id,
                    s.website_project_id,s.recommendation_id)=
                   (i.organization_id,i.workspace_id,
                    i.website_project_id,i.recommendation_id)
             ORDER BY s.generated_at DESC,s.id DESC
             LIMIT 1
          ) s ON true
          LEFT JOIN backlink_contact_enrichment_jobs j ON
            (j.organization_id,j.workspace_id,j.website_project_id,
             j.recommendation_id,j.recommendation_context_version_id)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             i.recommendation_id,i.recommendation_context_version_id)
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(bool_or(candidate.eligible),false) has_eligible,
              COALESCE(bool_or(
                candidate.eligible
                AND NOT candidate.contact_review_required
              ),false) has_eligible_without_review,
              (array_agg(candidate.id ORDER BY
                candidate.eligible DESC,
                candidate.contact_review_required ASC,
                candidate.confidence DESC,
                candidate.id
              ) FILTER (WHERE candidate.eligible))[1]
                recommended_candidate_id,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id',candidate.id,
                'normalizedEmail',candidate.normalized_email,
                'domainRelation',candidate.domain_relation,
                'confidence',candidate.confidence,
                'inferredPurpose',candidate.inferred_purpose,
                'purposeConfidence',candidate.purpose_confidence,
                'guessed',candidate.guessed,
                'version',candidate.version,
                'eligible',candidate.eligible,
                'contactReviewRequired',
                  candidate.contact_review_required,
                'evidence',candidate.evidence
              ) ORDER BY
                candidate.eligible DESC,
                candidate.contact_review_required ASC,
                candidate.confidence DESC,
                candidate.normalized_email
              ),'[]'::jsonb) contacts
            FROM (
              SELECT c.*,
                (
                  lower(c.normalized_email) ~
                    '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
                  AND split_part(
                    lower(c.normalized_email),'@',1
                  ) !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
                  AND c.email_domain_ascii NOT IN (
                    'example.com','example.org','example.net'
                  )
                  AND c.email_domain_ascii NOT LIKE '%.invalid'
                  AND evidence.has_valid_evidence
                ) eligible,
                (
                  c.domain_relation <> 'same_registrable_domain'
                  OR c.inferred_purpose = 'unknown'
                  OR c.confidence < 80
                  OR c.purpose_confidence < 70
                  OR c.guessed
                ) contact_review_required,
                evidence.items evidence
              FROM backlink_contact_candidates c
              CROSS JOIN LATERAL (
                SELECT
                  COALESCE(bool_or(
                    e.invalidated_at IS NULL
                    AND e.expires_at > now()
                    AND e.extraction_method IN (
                      'mailto','visible_text','obfuscated_text',
                      'json_ld','manual'
                    )
                  ),false) has_valid_evidence,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'id',e.id,
                    'sourceUrl',e.source_url,
                    'observedAt',e.observed_at,
                    'extractionMethod',e.extraction_method,
                    'evidenceSnippet',e.evidence_snippet,
                    'confidence',e.confidence
                  ) ORDER BY e.observed_at DESC,e.id)
                  FILTER (
                    WHERE e.invalidated_at IS NULL
                  ),'[]'::jsonb) items
                FROM backlink_contact_evidence e
                WHERE (e.organization_id,e.workspace_id,
                       e.website_project_id,e.candidate_id)=
                      (c.organization_id,c.workspace_id,
                       c.website_project_id,c.id)
              ) evidence
              WHERE (c.organization_id,c.workspace_id,
                     c.website_project_id,c.prospect_id,
                     c.recommendation_context_version_id)=
                    (i.organization_id,i.workspace_id,
                     i.website_project_id,i.prospect_id,
                     i.recommendation_context_version_id)
                AND c.status IN ('candidate','promoted')
                AND c.invalidated_at IS NULL
            ) candidate
          ) c ON true
          LEFT JOIN backlink_opportunities o ON
            (o.organization_id,o.workspace_id,o.website_project_id,
             o.target_site_key)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             p.registrable_domain)
         WHERE (i.organization_id,i.workspace_id,i.website_project_id)=
               ($1,$2,$3)
           AND ($4::text IS NULL OR i.status=$4)
           AND ($5::numeric IS NULL OR s.total_score >= $5)
           AND ($6::numeric IS NULL OR s.total_score < $6
             OR (s.total_score=$6 AND p.hostname_ascii > $7)
             OR (
               s.total_score=$6
               AND p.hostname_ascii=$7
               AND r.id > $8::uuid
             ))
         ORDER BY s.total_score DESC,p.hostname_ascii,r.id
         LIMIT $9
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
        input.status ?? null,
        input.minScore ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        input.limit + 1,
      ]);
      const items = result.rows.slice(0, input.limit).map((row) => {
        const hostname = String(row.hostname);
        const rootUrl = toWebsiteUrl(hostname, row.rootUrl);
        const assessment = toPublicAssessment({
          scoreId: row.scoreId,
          totalScore: row.score,
          scoreModelVersion: row.scoreModelVersion,
          ruleVersion: row.ruleVersion,
          components: row.scoreComponents,
          evidence: row.scoreEvidence,
          generatedAt: row.scoreGeneratedAt,
        });
        return {
          id: String(row.id),
          hostname,
          score: Number(row.score),
          status: row.status as RecommendationListItem["status"],
          recommendationContextVersionId:
            String(row.recommendationContextVersionId),
          version: Number(row.version),
          scoreModelVersion: String(row.scoreModelVersion),
          ruleVersion: String(row.ruleVersion),
          assessment,
          rootUrl,
          faviconUrl: new URL("/favicon.ico", rootUrl).toString(),
          acquiredAt: toIsoString(row.acquiredAt ?? row.scoreGeneratedAt),
          matchReasons: assessment.components
            .filter((component) => component.points !== null)
            .sort((left, right) => (right.points ?? 0) - (left.points ?? 0))
            .slice(0, 3)
            .map((component) => component.id),
          dataSources: [...new Set(
            assessment.components.map((component) => component.sourceType),
          )],
          seoMetrics: {
            authority: metric(assessment, "graph_authority_diversity"),
            editorialQuality: metric(
              assessment,
              "topic_content_editorial_quality",
            ),
            technicalHealth: metric(assessment, "technical_health"),
          },
          contactStatus: (row.contactStatus ?? "not_found") as
            RecommendationListItem["contactStatus"],
          contactJob: toContactJob(row.contactJob),
          contacts: arrayValue(row.contacts).map(toContactCandidate),
          recommendedContactCandidateId:
            nullableString(row.recommendedContactCandidateId),
          existingOpportunityId: nullableString(row.existingOpportunityId),
          canCreateOpportunity: row.canCreateOpportunity === true,
          createBlockReason: nullableString(row.createBlockReason) as
            RecommendationListItem["createBlockReason"],
        };
      });
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? encodeCursor(last)
          : null,
      };
    },
  });
}
