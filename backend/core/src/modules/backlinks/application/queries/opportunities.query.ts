import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import {
  toPublicAssessment,
  type PublicAssessment,
} from "../../domain/assessments/public-assessment.js";
import type {
  OpportunityBusinessStage,
  OpportunityFulfillmentStatus,
  OpportunityManagementStatus,
  OpportunityOutcomeStatus,
} from "../../domain/opportunities/opportunity-state.js";
import type {
  PlacementCandidate,
} from "../../domain/placements/placement-promotion.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export type OpportunityListItem = Readonly<{
  id: string;
  targetSiteKey: string;
  targetHostAscii: string;
  joinSequence: number;
  businessStage: OpportunityBusinessStage;
  managementStatus: OpportunityManagementStatus;
  outcomeStatus: OpportunityOutcomeStatus;
  fulfillmentStatus: OpportunityFulfillmentStatus;
  sourceContactCandidateId: string | null;
  contactEmail: string | null;
  contactReviewRequired: boolean;
  hasDownstreamFacts: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;
export type OpportunityDetail = OpportunityListItem & Readonly<{
  recommendationId: string;
  prospectId: string;
  recommendationContextVersionId: string;
  targetIdentityKind: "registrable_domain" | "exact_host";
  targetIdentityRuleVersion: string;
  targetIdentityOverrideReason: string | null;
  assessment: PublicAssessment;
  placementCandidate: PlacementCandidate | null;
}>;
export type OpportunitiesListInput = Readonly<{
  businessStage?: OpportunityBusinessStage | undefined;
  managementStatus?: OpportunityManagementStatus | undefined;
  outcomeStatus?: OpportunityOutcomeStatus | undefined;
  fulfillmentStatus?: OpportunityFulfillmentStatus | undefined;
  search?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}>;
export type OpportunityPage = Readonly<{
  items: OpportunityListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}>;
export type OpportunitiesQuery = Readonly<{
  listOpportunities(
    context: ResolvedProjectContext,
    input: OpportunitiesListInput,
  ): Promise<OpportunityPage>;
  getOpportunity(
    context: ResolvedProjectContext,
    opportunityId: string,
  ): Promise<OpportunityDetail>;
}>;
export type OpportunitiesQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type Cursor = readonly [number, string];

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest,
  message: "Opportunity cursor is invalid.",
  fieldErrors: [{ field: "cursor", message: "Use a cursor returned by this API." }],
});

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== "number" || !Number.isInteger(parsed[0])
      || parsed[0] <= 0 || typeof parsed[1] !== "string" || parsed[1].length === 0) {
      throw invalidCursor();
    }
    return parsed as unknown as Cursor;
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function toListItem(row: Record<string, unknown>): OpportunityListItem {
  return {
    id: String(row.id),
    targetSiteKey: String(row.targetSiteKey),
    targetHostAscii: String(row.targetHostAscii),
    joinSequence: Number(row.joinSequence),
    businessStage: row.businessStage as OpportunityBusinessStage,
    managementStatus: row.managementStatus as OpportunityManagementStatus,
    outcomeStatus: row.outcomeStatus as OpportunityOutcomeStatus,
    fulfillmentStatus: row.fulfillmentStatus as OpportunityFulfillmentStatus,
    sourceContactCandidateId:
      row.sourceContactCandidateId === null
        || row.sourceContactCandidateId === undefined
      ? null
      : String(row.sourceContactCandidateId),
    contactEmail: row.contactEmail === null || row.contactEmail === undefined
      ? null
      : String(row.contactEmail),
    contactReviewRequired: row.contactReviewRequired === true,
    hasDownstreamFacts: row.hasDownstreamFacts === true,
    version: Number(row.version),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toDetail(row: Record<string, unknown>): OpportunityDetail {
  return {
    ...toListItem(row),
    recommendationId: String(row.recommendationId),
    prospectId: String(row.prospectId),
    recommendationContextVersionId: String(row.recommendationContextVersionId),
    targetIdentityKind: row.targetIdentityKind as OpportunityDetail["targetIdentityKind"],
    targetIdentityRuleVersion: String(row.targetIdentityRuleVersion),
    targetIdentityOverrideReason: row.targetIdentityOverrideReason === null
      ? null : String(row.targetIdentityOverrideReason),
    assessment: toPublicAssessment({
      scoreId: row.assessmentScoreId,
      totalScore: row.assessmentScore,
      scoreModelVersion: row.assessmentScoreModelVersion,
      ruleVersion: row.assessmentRuleVersion,
      components: row.assessmentComponents,
      evidence: row.assessmentEvidence,
      generatedAt: row.assessmentGeneratedAt ?? row.updatedAt,
    }),
    placementCandidate: null,
  };
}

const listColumns = `
  o.id,o.target_site_key "targetSiteKey",o.target_host_ascii "targetHostAscii",
  o.join_sequence "joinSequence",o.business_stage "businessStage",
  o.management_status "managementStatus",o.outcome_status "outcomeStatus",
  o.fulfillment_status "fulfillmentStatus",
  o.source_contact_candidate_id "sourceContactCandidateId",
  (
    SELECT cc.normalized_email
      FROM backlink_contact_candidates cc
     WHERE (cc.organization_id,cc.workspace_id,cc.website_project_id,cc.id)=
           (o.organization_id,o.workspace_id,o.website_project_id,
            o.source_contact_candidate_id)
     LIMIT 1
  ) "contactEmail",
  o.contact_review_required "contactReviewRequired",
  (
    EXISTS (
      SELECT 1 FROM backlink_email_drafts d
       WHERE (d.organization_id,d.workspace_id,d.website_project_id,
              d.opportunity_id)=
             (o.organization_id,o.workspace_id,o.website_project_id,o.id)
    )
    OR EXISTS (
      SELECT 1 FROM backlink_send_intents si
       WHERE (si.organization_id,si.workspace_id,si.website_project_id,
              si.opportunity_id)=
             (o.organization_id,o.workspace_id,o.website_project_id,o.id)
    )
    OR EXISTS (
      SELECT 1 FROM backlink_reply_match_candidates r
       WHERE (r.organization_id,r.workspace_id,r.website_project_id,
              r.opportunity_id)=
             (o.organization_id,o.workspace_id,o.website_project_id,o.id)
    )
    OR EXISTS (
      SELECT 1 FROM backlink_placement_candidates pc
       WHERE (pc.organization_id,pc.workspace_id,pc.website_project_id,
              pc.opportunity_id)=
             (o.organization_id,o.workspace_id,o.website_project_id,o.id)
    )
    OR EXISTS (
      SELECT 1 FROM backlink_placements p
       WHERE (p.organization_id,p.workspace_id,p.website_project_id,
              p.opportunity_id)=
             (o.organization_id,o.workspace_id,o.website_project_id,o.id)
    )
  ) "hasDownstreamFacts",
  o.version,
  o.created_at "createdAt",o.updated_at "updatedAt"`;

export function createOpportunitiesQuery(
  client: OpportunitiesQueryClient,
): OpportunitiesQuery {
  return Object.freeze({
    async listOpportunities(context, input) {
      const after = decodeCursor(input.cursor);
      const result = await client.query(`
        SELECT ${listColumns}
          FROM backlink_opportunities o
         WHERE (o.organization_id,o.workspace_id,o.website_project_id)=($1,$2,$3)
           AND ($4::text IS NULL OR o.business_stage=$4)
           AND (
             ($5::text IS NULL AND o.management_status<>'ARCHIVED')
             OR o.management_status=$5
           )
           AND ($6::text IS NULL OR o.outcome_status=$6)
           AND ($7::text IS NULL OR o.fulfillment_status=$7)
           AND (
             $8::text IS NULL
             OR o.target_host_ascii ILIKE '%'||$8||'%'
             OR o.target_site_key ILIKE '%'||$8||'%'
             OR EXISTS (
               SELECT 1 FROM backlink_contact_candidates search_contact
                WHERE (
                  search_contact.organization_id,
                  search_contact.workspace_id,
                  search_contact.website_project_id,
                  search_contact.id
                )=(
                  o.organization_id,o.workspace_id,o.website_project_id,
                  o.source_contact_candidate_id
                )
                  AND search_contact.normalized_email ILIKE '%'||$8||'%'
             )
           )
           AND ($9::integer IS NULL OR o.join_sequence < $9
             OR (o.join_sequence=$9 AND o.id < $10::uuid))
         ORDER BY o.join_sequence DESC,o.id DESC
         LIMIT $11
      `, [context.tenant.organizationId, context.tenant.workspaceId,
        context.project.websiteProjectId, input.businessStage ?? null,
        input.managementStatus ?? null, input.outcomeStatus ?? null,
        input.fulfillmentStatus ?? null, input.search ?? null,
        after?.[0] ?? null, after?.[1] ?? null, input.limit + 1]);
      const items = result.rows.slice(0, input.limit).map(toListItem);
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? Buffer.from(JSON.stringify([last.joinSequence, last.id])).toString("base64url")
          : null,
      };
    },
    async getOpportunity(context, opportunityId) {
      const result = await client.query(`
        SELECT ${listColumns},
               o.recommendation_id "recommendationId",o.prospect_id "prospectId",
               o.recommendation_context_version_id "recommendationContextVersionId",
               o.target_identity_kind "targetIdentityKind",
               o.target_identity_rule_version "targetIdentityRuleVersion",
               o.target_identity_override_reason "targetIdentityOverrideReason",
               s.id "assessmentScoreId",
               s.total_score::double precision "assessmentScore",
               s.score_model_version "assessmentScoreModelVersion",
               s.rule_version "assessmentRuleVersion",
               s.components "assessmentComponents",
               s.evidence "assessmentEvidence",
               s.generated_at "assessmentGeneratedAt"
          FROM backlink_opportunities o
          LEFT JOIN LATERAL (
            SELECT id,total_score,score_model_version,rule_version,
                   components,evidence,generated_at
              FROM backlink_recommendation_scores s
             WHERE (s.organization_id,s.workspace_id,s.website_project_id,
                    s.recommendation_id)=(o.organization_id,o.workspace_id,
                    o.website_project_id,o.recommendation_id)
             ORDER BY s.generated_at DESC,s.id DESC LIMIT 1
          ) s ON true
         WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)=($1,$2,$3,$4)
      `, [context.tenant.organizationId, context.tenant.workspaceId,
        context.project.websiteProjectId, opportunityId]);
      const row = result.rows[0];
      if (row === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Opportunity was not found in this project.",
        });
      }
      return toDetail(row);
    },
  });
}
