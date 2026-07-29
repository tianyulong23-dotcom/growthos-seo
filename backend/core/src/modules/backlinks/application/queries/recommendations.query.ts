import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import {
  toPublicAssessment,
  type PublicAssessment,
} from "../../domain/assessments/public-assessment.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type RecommendationListItem = Readonly<{
  id: string; hostname: string; score: number; status: "ready" | "claimed" | "rejected";
  recommendationContextVersionId: string; version: number;
  scoreModelVersion: string; ruleVersion: string; assessment: PublicAssessment;
}>;
export type RecommendationsListInput = Readonly<{
  status?: RecommendationListItem["status"] | undefined; minScore?: number | undefined;
  limit: number; cursor?: string | undefined;
}>;
export type RecommendationPage = Readonly<{
  items: RecommendationListItem[]; nextCursor: string | null; hasMore: boolean;
}>;
export type RecommendationsQuery = Readonly<{
  listRecommendations(context: ResolvedProjectContext,
    input: RecommendationsListInput): Promise<RecommendationPage>;
}>;
export type RecommendationsQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]):
    Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
type Cursor = readonly [number, string, string];

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest, message: "Recommendation cursor is invalid.",
  fieldErrors: [{ field: "cursor", message: "Use a cursor returned by this API." }],
});
function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3
      || typeof parsed[0] !== "number" || !Number.isFinite(parsed[0])
      || typeof parsed[1] !== "string" || parsed[1].length === 0
      || typeof parsed[2] !== "string" || parsed[2].length === 0) throw invalidCursor();
    return parsed as unknown as Cursor;
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}
const encodeCursor = (item: RecommendationListItem) =>
  Buffer.from(JSON.stringify([item.score, item.hostname, item.id])).toString("base64url");

export function createRecommendationsQuery(client: RecommendationsQueryClient):
RecommendationsQuery {
  return Object.freeze({
    async listRecommendations(context, input) {
      const after = decodeCursor(input.cursor);
      const result = await client.query(`
        SELECT r.id,p.hostname_ascii "hostname",s.total_score::double precision "score",
               i.status,i.recommendation_context_version_id "recommendationContextVersionId",
               i.version,s.id "scoreId",s.score_model_version "scoreModelVersion",
               s.rule_version "ruleVersion",s.components "scoreComponents",
               s.evidence "scoreEvidence",s.generated_at "scoreGeneratedAt"
          FROM backlink_recommendation_inventory i
          JOIN backlink_recommendations r ON (r.organization_id,r.workspace_id,
               r.website_project_id,r.id)=(i.organization_id,i.workspace_id,
               i.website_project_id,i.recommendation_id)
          JOIN backlink_prospects p ON (p.organization_id,p.workspace_id,
               p.website_project_id,p.id)=(i.organization_id,i.workspace_id,
               i.website_project_id,i.prospect_id)
          JOIN LATERAL (SELECT id,total_score,score_model_version,rule_version,
                               components,evidence,generated_at
            FROM backlink_recommendation_scores s WHERE (s.organization_id,s.workspace_id,
                 s.website_project_id,s.recommendation_id)=(i.organization_id,
                 i.workspace_id,i.website_project_id,i.recommendation_id)
            ORDER BY s.generated_at DESC,s.id DESC LIMIT 1) s ON true
         WHERE (i.organization_id,i.workspace_id,i.website_project_id)=($1,$2,$3)
           AND ($4::text IS NULL OR i.status=$4)
           AND ($5::numeric IS NULL OR s.total_score >= $5)
           AND ($6::numeric IS NULL OR s.total_score < $6
             OR (s.total_score=$6 AND p.hostname_ascii > $7)
             OR (s.total_score=$6 AND p.hostname_ascii=$7 AND r.id > $8::uuid))
         ORDER BY s.total_score DESC,p.hostname_ascii,r.id LIMIT $9
      `, [context.tenant.organizationId, context.tenant.workspaceId,
        context.project.websiteProjectId, input.status ?? null, input.minScore ?? null,
        after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, input.limit + 1]);
      const items = result.rows.slice(0, input.limit).map((row) => ({
        id: String(row.id),
        hostname: String(row.hostname),
        score: Number(row.score),
        status: row.status as RecommendationListItem["status"],
        recommendationContextVersionId: String(row.recommendationContextVersionId),
        version: Number(row.version),
        scoreModelVersion: String(row.scoreModelVersion),
        ruleVersion: String(row.ruleVersion),
        assessment: toPublicAssessment({
          scoreId: row.scoreId,
          totalScore: row.score,
          scoreModelVersion: row.scoreModelVersion,
          ruleVersion: row.ruleVersion,
          components: row.scoreComponents,
          evidence: row.scoreEvidence,
          generatedAt: row.scoreGeneratedAt,
        }),
      }));
      const hasMore = result.rows.length > input.limit, last = items.at(-1);
      return { items, hasMore,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null };
    },
  });
}
