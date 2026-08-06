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
  batchId: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "partially_completed"
    | "no_contact_found"
    | "retry_scheduled"
    | "stale_context";
  candidateCount: number;
  evidenceCount: number;
  pagesVisited: number;
  lastErrorCode: string | null;
  terminalReasonCode:
    | "PUBLIC_EMAIL_FOUND"
    | "CONTACT_FORM_ONLY"
    | "LOGIN_REQUIRED"
    | "CAPTCHA_OR_BOT_CHALLENGE"
    | "ROBOTS_DISALLOWED"
    | "ACCESS_DENIED"
    | "NO_PUBLIC_EMAIL"
    | "SITE_UNREACHABLE"
    | "UNSUPPORTED_CONTENT"
    | "MANUAL_REVIEW_REQUIRED"
    | "COMPLETED_PARTIAL"
    | null;
  method: "none" | "static" | "browser" | "static_and_browser";
  lastErrorCategory: string | null;
  retryAfter: string | null;
  completedAt: string | null;
};
export type RecommendationListItem = {
  id: string;
  hostname: string;
  score: number;
  status: RecommendationInventoryStatus;
  publicationStatus: "PUBLISHED";
  verifiedPublicEmailCount: number;
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
export type RecommendationInventorySummary = Readonly<{
  candidateReadyCount: number;
  publishedContactReadyCount: number;
  historicalEmailHitRate: number;
  candidateLowWatermark: number;
  candidateHighWatermark: number;
  publishedLowWatermark: number;
  publishedHighWatermark: number;
  blueprintVersion: number | null;
  blueprintGenerator: "AI" | "DETERMINISTIC_FALLBACK" | null;
  latestRefillAt: string | null;
  nextRefillAt: string | null;
  providerCollectedAt: string | null;
  pauseReason: string | null;
  refillInFlight: boolean;
  contactBatch: Readonly<{
    id: string;
    status: "running" | "completed" | "stale_context";
    totalJobCount: number;
    terminalJobCount: number;
    publishedCount: number;
    unpublishedCount: number;
    retryableUnpublishedCount: number;
    reasonCounts: {
      reasonCode: string;
      count: number;
    }[];
    startedAt: string;
    completedAt: string | null;
  }> | null;
}>;
export type RecommendationsQuery = Readonly<{
  listRecommendations(
    context: ResolvedProjectContext,
    input: RecommendationsListInput,
  ): Promise<RecommendationPage>;
  getRecommendationInventoryStatus(
    context: ResolvedProjectContext,
  ): Promise<RecommendationInventorySummary>;
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
    batchId: String(item.batchId),
    status: item.status as RecommendationContactJob["status"],
    candidateCount: Number(item.candidateCount),
    evidenceCount: Number(item.evidenceCount),
    pagesVisited: Number(item.pagesVisited),
    lastErrorCode: nullableString(item.lastErrorCode),
    terminalReasonCode: nullableString(item.terminalReasonCode) as
      RecommendationContactJob["terminalReasonCode"],
    method: item.method as RecommendationContactJob["method"],
    lastErrorCategory: nullableString(item.lastErrorCategory),
    retryAfter: item.retryAfter === null || item.retryAfter === undefined
      ? null
      : toIsoString(item.retryAfter),
    completedAt: item.completedAt === null || item.completedAt === undefined
      ? null
      : toIsoString(item.completedAt),
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
               i.publication_status "publicationStatus",
               i.verified_public_email_count "verifiedPublicEmailCount",
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
                 ELSE NULL
               END "createBlockReason",
               o.id IS NULL "canCreateOpportunity",
               c.contacts,
               i.default_contact_candidate_id
                 "recommendedContactCandidateId",
               'contactable' "contactStatus",
               CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
                 'id',j.id,
                 'batchId',j.batch_id,
                 'status',j.status,
                 'candidateCount',j.candidate_count,
                 'evidenceCount',j.evidence_count,
                 'pagesVisited',j.pages_visited,
                 'lastErrorCode',j.last_error_code,
                 'terminalReasonCode',j.terminal_reason_code,
                 'method',j.method,
                 'lastErrorCategory',j.last_error_category,
                 'retryAfter',j.retry_after,
                 'completedAt',j.completed_at
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
              count(*) FILTER (WHERE candidate.eligible)::integer
                eligible_count,
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
                  AND c.status IN ('candidate','promoted')
                  AND c.invalidated_at IS NULL
                  AND c.guessed=false
                  AND c.confidence>=80
                  AND c.purpose_confidence>=70
                  AND c.inferred_purpose IN (
                    'editorial','partnerships','advertising','business',
                    'marketing','site_owner','general'
                  )
                  AND evidence.has_valid_evidence
                ) eligible,
                false contact_review_required,
                evidence.items evidence
              FROM backlink_contact_candidates c
              CROSS JOIN LATERAL (
                SELECT
                  COALESCE(bool_or(
                    e.invalidated_at IS NULL
                    AND e.expires_at > now()
                    AND e.extraction_method IN (
                      'mailto','visible_text','obfuscated_text',
                      'json_ld'
                    )
                    AND e.confidence>=80
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
                      AND e.expires_at>now()
                      AND e.extraction_method IN (
                        'mailto','visible_text','obfuscated_text','json_ld'
                      )
                      AND e.confidence>=80
                  ),'[]'::jsonb) items
                FROM backlink_contact_evidence e
                WHERE (e.organization_id,e.workspace_id,
                       e.website_project_id,e.candidate_id)=
                      (c.organization_id,c.workspace_id,
                       c.website_project_id,c.id)
                  AND e.id=(
                    SELECT snapshot.contact_evidence_id
                      FROM backlink_contact_evidence_snapshots AS snapshot
                     WHERE (
                       snapshot.organization_id,snapshot.workspace_id,
                       snapshot.website_project_id,snapshot.id
                     )=(
                       i.organization_id,i.workspace_id,
                       i.website_project_id,i.contact_evidence_snapshot_id
                     )
                  )
              ) evidence
              WHERE (c.organization_id,c.workspace_id,
                     c.website_project_id,c.prospect_id,
                     c.recommendation_context_version_id)=
                    (i.organization_id,i.workspace_id,
                     i.website_project_id,i.prospect_id,
                     i.recommendation_context_version_id)
                AND c.status IN ('candidate','promoted')
                AND c.invalidated_at IS NULL
                AND c.id=i.default_contact_candidate_id
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
           AND i.publication_status='PUBLISHED'
           AND i.verified_public_email_count>=1
           AND i.contact_evidence_snapshot_id IS NOT NULL
           AND i.default_contact_candidate_id IS NOT NULL
           AND COALESCE(c.eligible_count,0)>=1
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
          publicationStatus: "PUBLISHED" as const,
          verifiedPublicEmailCount: Number(row.verifiedPublicEmailCount),
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
    async getRecommendationInventoryStatus(context) {
      const result = await client.query(`
        WITH current_context AS (
          SELECT id
            FROM backlink_project_context_snapshots
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_status='ACTIVE'
           ORDER BY snapshot_version DESC,created_at DESC,id DESC
           LIMIT 1
        ),
        latest_blueprint AS (
          SELECT blueprint_version,generator
            FROM backlink_commercial_discovery_blueprints
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_context_version_id=(SELECT id FROM current_context)
             AND status='active'
           ORDER BY blueprint_version DESC,generated_at DESC,id DESC
           LIMIT 1
        ),
        candidate_counts AS (
          SELECT
            count(*) FILTER (
              WHERE state IN ('candidate_ready','contact_enrichment')
            )::integer candidate_ready_count,
            count(*)::integer historical_candidate_count,
            max(provider_collected_at) provider_collected_at
            FROM backlink_commercial_candidates
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_context_version_id=(SELECT id FROM current_context)
        ),
        publication_counts AS (
          SELECT
            count(*) FILTER (
              WHERE publication_status='PUBLISHED'
                AND verified_public_email_count>=1
                AND status IN ('ready','shown')
            )::integer published_count,
            count(*) FILTER (
              WHERE verified_public_email_count>=1
            )::integer
              historical_verified_email_count
            FROM backlink_recommendation_inventory
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND recommendation_context_version_id=
                 (SELECT id FROM current_context)
        ),
        running_batch AS (
          SELECT EXISTS (
            SELECT 1
            FROM backlink_commercial_discovery_batches
             WHERE (organization_id,workspace_id,website_project_id)=
                   ($1,$2,$3)
               AND project_context_version_id=(SELECT id FROM current_context)
               AND status='running'
          ) value
        ),
        contact_batch AS (
          SELECT b.id,b.status,b.started_at,b.completed_at,
                 (
                   SELECT count(*)::integer
                     FROM backlink_contact_enrichment_jobs AS job
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                 ) total_job_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_contact_enrichment_jobs AS job
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                      AND job.terminal_reason_code IS NOT NULL
                 ) terminal_job_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_recommendation_inventory AS inventory
                    WHERE (
                      inventory.organization_id,inventory.workspace_id,
                      inventory.website_project_id,
                      inventory.recommendation_context_version_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,
                      b.recommendation_context_version_id
                    )
                      AND inventory.publication_status='PUBLISHED'
                      AND inventory.verified_public_email_count>=1
                 ) published_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_recommendation_inventory AS inventory
                    WHERE (
                      inventory.organization_id,inventory.workspace_id,
                      inventory.website_project_id,
                      inventory.recommendation_context_version_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,
                      b.recommendation_context_version_id
                    )
                      AND inventory.publication_status<>'PUBLISHED'
                 ) unpublished_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_contact_enrichment_jobs AS job
                     JOIN backlink_recommendation_inventory AS inventory ON
                       (
                         inventory.organization_id,inventory.workspace_id,
                         inventory.website_project_id,
                         inventory.recommendation_id,
                         inventory.recommendation_context_version_id
                       )=(
                         job.organization_id,job.workspace_id,
                         job.website_project_id,job.recommendation_id,
                         job.recommendation_context_version_id
                       )
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                      AND inventory.publication_status<>'PUBLISHED'
                      AND job.status IN (
                        'completed','partially_completed',
                        'no_contact_found','retry_scheduled'
                      )
                      AND job.attempt_count<10
                 ) retryable_unpublished_count,
                 (
                   SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'reasonCode',reason.reason_code,
                     'count',reason.reason_count
                   ) ORDER BY reason.reason_code),'[]'::jsonb)
                     FROM (
                       SELECT job.terminal_reason_code reason_code,
                              count(*)::integer reason_count
                         FROM backlink_contact_enrichment_jobs AS job
                        WHERE (
                          job.organization_id,job.workspace_id,
                          job.website_project_id,job.batch_id
                        )=(
                          b.organization_id,b.workspace_id,
                          b.website_project_id,b.id
                        )
                          AND job.terminal_reason_code IS NOT NULL
                        GROUP BY job.terminal_reason_code
                     ) reason
                 ) reason_counts
            FROM backlink_contact_enrichment_batches AS b
           WHERE (b.organization_id,b.workspace_id,b.website_project_id)=
                 ($1,$2,$3)
             AND b.recommendation_context_version_id=
                 (SELECT id FROM current_context)
           LIMIT 1
        )
        SELECT
          COALESCE(candidate_counts.candidate_ready_count,0)
            "candidateReadyCount",
          COALESCE(publication_counts.published_count,0)
            "publishedContactReadyCount",
          CASE
            WHEN COALESCE(candidate_counts.historical_candidate_count,0)=0
              THEN 0.1
            ELSE LEAST(0.8,GREATEST(
              0.1,
              publication_counts.historical_verified_email_count::numeric
                / candidate_counts.historical_candidate_count
            ))
          END::double precision "historicalEmailHitRate",
          COALESCE(policy.candidate_low_watermark,20)
            "candidateLowWatermark",
          COALESCE(policy.candidate_high_watermark,40)
            "candidateHighWatermark",
          COALESCE(policy.published_contact_ready_low_watermark,5)
            "publishedLowWatermark",
          COALESCE(policy.published_contact_ready_high_watermark,10)
            "publishedHighWatermark",
          latest_blueprint.blueprint_version "blueprintVersion",
          latest_blueprint.generator "blueprintGenerator",
          policy.latest_refill_at "latestRefillAt",
          policy.next_refill_at "nextRefillAt",
          COALESCE(
            policy.latest_provider_collected_at,
            candidate_counts.provider_collected_at
          ) "providerCollectedAt",
          policy.pause_reason "pauseReason",
          running_batch.value "refillInFlight",
          CASE WHEN contact_batch.id IS NULL THEN NULL
            ELSE jsonb_build_object(
              'id',contact_batch.id,
              'status',contact_batch.status,
              'totalJobCount',contact_batch.total_job_count,
              'terminalJobCount',contact_batch.terminal_job_count,
              'publishedCount',contact_batch.published_count,
              'unpublishedCount',contact_batch.unpublished_count,
              'retryableUnpublishedCount',
                contact_batch.retryable_unpublished_count,
              'reasonCounts',contact_batch.reason_counts,
              'startedAt',contact_batch.started_at,
              'completedAt',contact_batch.completed_at
            )
          END "contactBatch"
        FROM candidate_counts
        CROSS JOIN publication_counts
        CROSS JOIN running_batch
        LEFT JOIN latest_blueprint ON true
        LEFT JOIN contact_batch ON true
        LEFT JOIN backlink_commercial_inventory_policies AS policy
          ON (policy.organization_id,policy.workspace_id,
              policy.website_project_id,policy.project_context_version_id)=
             ($1,$2,$3,(SELECT id FROM current_context))
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
      ]);
      const row = result.rows[0] ?? {};
      const contactBatch = row.contactBatch === null
        || row.contactBatch === undefined
        ? null
        : objectValue(row.contactBatch);
      return Object.freeze({
        candidateReadyCount: Number(row.candidateReadyCount ?? 0),
        publishedContactReadyCount:
          Number(row.publishedContactReadyCount ?? 0),
        historicalEmailHitRate: Number(row.historicalEmailHitRate ?? 0.1),
        candidateLowWatermark: Number(row.candidateLowWatermark ?? 20),
        candidateHighWatermark: Number(row.candidateHighWatermark ?? 40),
        publishedLowWatermark: Number(row.publishedLowWatermark ?? 5),
        publishedHighWatermark: Number(row.publishedHighWatermark ?? 10),
        blueprintVersion: row.blueprintVersion === null
          || row.blueprintVersion === undefined
          ? null : Number(row.blueprintVersion),
        blueprintGenerator: nullableString(row.blueprintGenerator) as
          RecommendationInventorySummary["blueprintGenerator"],
        latestRefillAt: row.latestRefillAt === null
          || row.latestRefillAt === undefined
          ? null : toIsoString(row.latestRefillAt),
        nextRefillAt: row.nextRefillAt === null
          || row.nextRefillAt === undefined
          ? null : toIsoString(row.nextRefillAt),
        providerCollectedAt: row.providerCollectedAt === null
          || row.providerCollectedAt === undefined
          ? null : toIsoString(row.providerCollectedAt),
        pauseReason: nullableString(row.pauseReason),
        refillInFlight: row.refillInFlight === true,
        contactBatch: contactBatch === null ? null : Object.freeze({
          id: String(contactBatch.id),
          status: contactBatch.status as
            NonNullable<RecommendationInventorySummary["contactBatch"]>["status"],
          totalJobCount: Number(contactBatch.totalJobCount),
          terminalJobCount: Number(contactBatch.terminalJobCount),
          publishedCount: Number(contactBatch.publishedCount),
          unpublishedCount: Number(contactBatch.unpublishedCount),
          retryableUnpublishedCount:
            Number(contactBatch.retryableUnpublishedCount),
          reasonCounts: arrayValue(contactBatch.reasonCounts).map((value) => {
            const reason = objectValue(value);
            return Object.freeze({
              reasonCode: String(reason.reasonCode),
              count: Number(reason.count),
            });
          }),
          startedAt: toIsoString(contactBatch.startedAt),
          completedAt: contactBatch.completedAt === null
            || contactBatch.completedAt === undefined
            ? null
            : toIsoString(contactBatch.completedAt),
        }),
      });
    },
  });
}
