export type RecommendationInventoryQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;
type Scope = Readonly<{ organizationId: string; workspaceId: string;
  websiteProjectId: string; recommendationContextVersionId: string }>;
export type ClaimRecommendationInput = Scope & Readonly<{
  claimId: string; claimToken: string; claimedBy: string;
  claimedAt: Date; leaseExpiresAt: Date }>;
export type ClaimedRecommendation = Readonly<{
  inventoryId: string; recommendationId: string; prospectId: string;
  hostnameAscii: string; totalScore: number; claimToken: string;
  claimedAt: Date; leaseExpiresAt: Date; claimVersion: number }>;
export type ReleaseRecommendationInput = Scope & Readonly<{
  inventoryId: string; claimToken: string; actorId: string; releasedAt: Date }>;
export type RejectRecommendationInput = Scope & Readonly<{
  inventoryId: string; claimToken: string; rejectionId: string;
  rejectionType: "skipped" | "permanently_rejected"; reasonCode: string;
  rejectedBy: string; rejectedAt: Date; cooldownUntil: Date | null }>;

export function createRecommendationInventoryRepository(
  client: RecommendationInventoryQueryClient,
) {
  return {
    async claim(input: ClaimRecommendationInput): Promise<ClaimedRecommendation | null> {
      const result = await client.query(`
        WITH candidate AS (
          SELECT i.*,p.hostname_ascii,COALESCE((
            SELECT max(s.total_score)::double precision
              FROM backlink_recommendation_scores s
             WHERE (s.organization_id,s.workspace_id,s.website_project_id,
                    s.recommendation_id,s.prospect_id,s.recommendation_context_version_id)=
                   (i.organization_id,i.workspace_id,i.website_project_id,
                    i.recommendation_id,i.prospect_id,i.recommendation_context_version_id)
          ),0::double precision) total_score
            FROM backlink_recommendation_inventory i
            JOIN backlink_prospects p
              ON (p.organization_id,p.workspace_id,p.website_project_id,p.id,
                  p.recommendation_context_version_id)=
                 (i.organization_id,i.workspace_id,i.website_project_id,
                  i.prospect_id,i.recommendation_context_version_id)
       LEFT JOIN backlink_recommendation_claims c
              ON (c.organization_id,c.workspace_id,c.website_project_id,c.inventory_id)=
                 (i.organization_id,i.workspace_id,i.website_project_id,i.id)
           WHERE (i.organization_id,i.workspace_id,i.website_project_id,
                  i.recommendation_context_version_id)=($1,$2,$3,$4)
             AND (i.status='ready' OR (i.status='claimed' AND c.status='active'
                  AND c.lease_expires_at<=$8))
        ORDER BY total_score DESC,p.hostname_ascii,i.id
             FOR UPDATE OF i SKIP LOCKED LIMIT 1
        ), claimed AS (
          INSERT INTO backlink_recommendation_claims (
            id,organization_id,workspace_id,website_project_id,inventory_id,
            recommendation_id,prospect_id,recommendation_context_version_id,
            status,claim_token,claimed_by,claimed_at,lease_expires_at,
            created_at,updated_at,created_by,updated_by
          ) SELECT $5,organization_id,workspace_id,website_project_id,id,
                   recommendation_id,prospect_id,recommendation_context_version_id,
                   'active',$6,$7,$8,$9,$8,$8,$7,$7 FROM candidate
          ON CONFLICT (organization_id,workspace_id,website_project_id,inventory_id)
          DO UPDATE SET status='active',claim_token=EXCLUDED.claim_token,
            claimed_by=EXCLUDED.claimed_by,claimed_at=EXCLUDED.claimed_at,
            lease_expires_at=EXCLUDED.lease_expires_at,finished_at=NULL,
            version=backlink_recommendation_claims.version+1,
            updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by
          WHERE backlink_recommendation_claims.status='released'
             OR (backlink_recommendation_claims.status='active' AND
                 backlink_recommendation_claims.lease_expires_at<=EXCLUDED.claimed_at)
          RETURNING *
        ), updated AS (
          UPDATE backlink_recommendation_inventory i SET status='claimed',
            version=i.version+1,updated_at=$8,updated_by=$7 FROM claimed c
           WHERE i.id=c.inventory_id RETURNING i.id
        )
        SELECT c.inventory_id "inventoryId",c.recommendation_id "recommendationId",
               c.prospect_id "prospectId",d.hostname_ascii "hostnameAscii",
               d.total_score "totalScore",c.claim_token "claimToken",
               c.claimed_at "claimedAt",c.lease_expires_at "leaseExpiresAt",
               c.version "claimVersion"
          FROM claimed c JOIN candidate d ON d.id=c.inventory_id
          JOIN updated u ON u.id=c.inventory_id
      `, [input.organizationId, input.workspaceId, input.websiteProjectId,
        input.recommendationContextVersionId, input.claimId, input.claimToken,
        input.claimedBy, input.claimedAt, input.leaseExpiresAt]);
      return (result.rows[0] as ClaimedRecommendation | undefined) ?? null;
    },

    async release(input: ReleaseRecommendationInput): Promise<boolean> {
      const result = await client.query(`
        WITH released AS (
          UPDATE backlink_recommendation_claims c SET status='released',
            finished_at=$7,version=c.version+1,updated_at=$7,updated_by=$6
           WHERE (c.organization_id,c.workspace_id,c.website_project_id,
                  c.recommendation_context_version_id,c.inventory_id)=($1,$2,$3,$4,$5)
             AND c.claim_token=$8 AND c.status='active'
             AND EXISTS (SELECT 1 FROM backlink_recommendation_inventory i
                          WHERE i.id=c.inventory_id AND i.status='claimed')
          RETURNING c.inventory_id
        )
        UPDATE backlink_recommendation_inventory i SET status='ready',
          version=i.version+1,updated_at=$7,updated_by=$6
          FROM released r WHERE i.id=r.inventory_id RETURNING i.id
      `, [input.organizationId, input.workspaceId, input.websiteProjectId,
        input.recommendationContextVersionId, input.inventoryId, input.actorId,
        input.releasedAt, input.claimToken]);
      return result.rows[0] !== undefined;
    },

    async reject(input: RejectRecommendationInput): Promise<boolean> {
      const result = await client.query(`
        WITH consumed AS (
          UPDATE backlink_recommendation_claims c SET status='consumed',
            finished_at=$10,version=c.version+1,updated_at=$10,updated_by=$9
           WHERE (c.organization_id,c.workspace_id,c.website_project_id,
                  c.recommendation_context_version_id,c.inventory_id)=($1,$2,$3,$4,$5)
             AND c.claim_token=$6 AND c.status='active'
             AND EXISTS (SELECT 1 FROM backlink_recommendation_inventory i
                          WHERE i.id=c.inventory_id AND i.status='claimed')
          RETURNING *
        ), rejected AS (
          INSERT INTO backlink_recommendation_rejections (
            id,organization_id,workspace_id,website_project_id,inventory_id,
            recommendation_id,prospect_id,recommendation_context_version_id,
            rejection_type,reason_code,rejected_at,cooldown_until,rejected_by,
            created_at,created_by
          ) SELECT $7,organization_id,workspace_id,website_project_id,inventory_id,
                   recommendation_id,prospect_id,recommendation_context_version_id,
                   $8,$11,$10,$12,$9,$10,$9 FROM consumed
          RETURNING inventory_id
        )
        UPDATE backlink_recommendation_inventory i SET status='rejected',
          version=i.version+1,updated_at=$10,updated_by=$9
          FROM rejected r WHERE i.id=r.inventory_id RETURNING i.id
      `, [input.organizationId, input.workspaceId, input.websiteProjectId,
        input.recommendationContextVersionId, input.inventoryId, input.claimToken,
        input.rejectionId, input.rejectionType, input.rejectedBy, input.rejectedAt,
        input.reasonCode, input.cooldownUntil]);
      return result.rows[0] !== undefined;
    },
  };
}
