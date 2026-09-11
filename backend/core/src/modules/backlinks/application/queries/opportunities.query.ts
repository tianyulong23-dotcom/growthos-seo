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
  ManualActionState,
  NonEmailCooperationPathType,
} from "../../domain/opportunities/cooperation-path.js";
import type {
  PlacementCandidate,
} from "../../domain/placements/placement-promotion.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  deriveOpportunityHandoffState,
  type EngagementPathState,
  type OpportunityPrimaryNextAction,
} from "../read-models/opportunity-handoff.js";

export type OpportunityListItem = Readonly<{
  id: string;
  targetSiteKey: string;
  targetHostAscii: string;
  joinSequence: number;
  businessStage: OpportunityBusinessStage;
  managementStatus: OpportunityManagementStatus;
  outcomeStatus: OpportunityOutcomeStatus;
  fulfillmentStatus: OpportunityFulfillmentStatus;
  engagementChannel: "EMAIL" | "COOPERATION_PATH";
  engagementPathState: EngagementPathState;
  primaryNextAction: OpportunityPrimaryNextAction;
  draftId: string | null;
  sourceContactCandidateId: string | null;
  contactEmail: string | null;
  contactReviewRequired: boolean;
  manualActionState: ManualActionState | null;
  hasDownstreamFacts: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;
export type OpportunityCooperationPath = Readonly<{
  factId: string;
  manualActionId: string;
  pathType: NonEmailCooperationPathType;
  pathUrl: string;
  contentType: "FORM_MESSAGE" | "SUBMISSION_PITCH";
  editableContent: string;
  state: ManualActionState;
  nextAction: string;
  evidence: Readonly<Record<string, unknown>>;
  version: number;
  updatedAt: string;
}>;
export type OpportunitySelectionSnapshot = Readonly<{
  lineageStatus: "COMPLETE" | "PARTIAL";
  recommendationId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number | null;
  generationContractId: string | null;
  inputPinId: string | null;
  scoreModelVersion: string | null;
  projectContextVersion: number | null;
  siteProfileVersionId: string | null;
  outreachProfileVersionId: string | null;
  promotionTargetVersionId: string | null;
  immutableFingerprint: string | null;
  selectedTargetUrl: string | null;
  selectedContactCandidateId: string | null;
  selectedCooperationPathFactId: string | null;
  selectedCooperationPathVersion: number | null;
  selectedBy: string;
  selectedAt: string;
}>;
export type OpportunityDetail = OpportunityListItem & Readonly<{
  recommendationId: string;
  prospectId: string;
  recommendationContextVersionId: string;
  targetIdentityKind: "registrable_domain" | "exact_host";
  targetIdentityRuleVersion: string;
  targetIdentityOverrideReason: string | null;
  assessment: PublicAssessment | null;
  placementCandidate: PlacementCandidate | null;
  cooperationPath: OpportunityCooperationPath | null;
  selectionSnapshot: OpportunitySelectionSnapshot;
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

function toDraftState(value: unknown): Readonly<{
  id: string;
  status: "generating" | "draft" | "approved" | "rejected" | "sent";
  currentVersionSource:
    | "MODEL"
    | "TEMPLATE_FALLBACK"
    | "MANUAL"
    | "RESTORED"
    | null;
}> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const status = row.status;
  if (
    typeof row.id !== "string"
    || !["generating", "draft", "approved", "rejected", "sent"]
      .includes(String(status))
  ) {
    return null;
  }
  const source = row.currentVersionSource;
  return {
    id: row.id,
    status: status as
      "generating" | "draft" | "approved" | "rejected" | "sent",
    currentVersionSource:
      source === "MODEL"
        || source === "TEMPLATE_FALLBACK"
        || source === "MANUAL"
        || source === "RESTORED"
        ? source
        : null,
  };
}

function toListItem(row: Record<string, unknown>): OpportunityListItem {
  const engagementChannel = row.engagementChannel === "COOPERATION_PATH"
    ? "COOPERATION_PATH" as const
    : "EMAIL" as const;
  const contactEmail = row.contactEmail === null || row.contactEmail === undefined
    ? null
    : String(row.contactEmail);
  const manualActionState = row.manualActionState === null
      || row.manualActionState === undefined
    ? null
    : row.manualActionState as ManualActionState;
  const draft = toDraftState(row.draftState);
  const handoff = deriveOpportunityHandoffState({
    engagementChannel,
    contactEmail,
    contactReviewRequired: row.contactReviewRequired === true,
    manualActionState,
    draftStatus: draft?.status ?? null,
    draftVersionSource: draft?.currentVersionSource ?? null,
  });
  return {
    id: String(row.id),
    targetSiteKey: String(row.targetSiteKey),
    targetHostAscii: String(row.targetHostAscii),
    joinSequence: Number(row.joinSequence),
    businessStage: row.businessStage as OpportunityBusinessStage,
    managementStatus: row.managementStatus as OpportunityManagementStatus,
    outcomeStatus: row.outcomeStatus as OpportunityOutcomeStatus,
    fulfillmentStatus: row.fulfillmentStatus as OpportunityFulfillmentStatus,
    engagementChannel,
    ...handoff,
    draftId: draft?.id ?? null,
    sourceContactCandidateId:
      row.sourceContactCandidateId === null
        || row.sourceContactCandidateId === undefined
      ? null
      : String(row.sourceContactCandidateId),
    contactEmail,
    contactReviewRequired: row.contactReviewRequired === true,
    manualActionState,
    hasDownstreamFacts: row.hasDownstreamFacts === true,
    version: Number(row.version),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toDetail(row: Record<string, unknown>): OpportunityDetail {
  const listItem = toListItem(row);
  const recommendationId = String(row.recommendationId);
  const recommendationContextVersionId =
    String(row.recommendationContextVersionId);
  const visiblePoolGeneration = row.selectionVisiblePoolGeneration === null
      || row.selectionVisiblePoolGeneration === undefined
    ? null
    : Number(row.selectionVisiblePoolGeneration);
  const generationContractId = row.selectionGenerationContractId === null
      || row.selectionGenerationContractId === undefined
    ? null
    : String(row.selectionGenerationContractId);
  const inputPinId = row.selectionInputPinId === null
      || row.selectionInputPinId === undefined
    ? null
    : String(row.selectionInputPinId);
  const optionalString = (value: unknown) =>
    value === null || value === undefined ? null : String(value);
  return {
    ...listItem,
    recommendationId,
    prospectId: String(row.prospectId),
    recommendationContextVersionId,
    targetIdentityKind: row.targetIdentityKind as OpportunityDetail["targetIdentityKind"],
    targetIdentityRuleVersion: String(row.targetIdentityRuleVersion),
    targetIdentityOverrideReason: row.targetIdentityOverrideReason === null
      ? null : String(row.targetIdentityOverrideReason),
    assessment: row.assessmentScoreId === null
        || row.assessmentScoreId === undefined
      ? null
      : toPublicAssessment({
        scoreId: row.assessmentScoreId,
        totalScore: row.assessmentScore,
        scoreModelVersion: row.assessmentScoreModelVersion,
        ruleVersion: row.assessmentRuleVersion,
        components: row.assessmentComponents,
        evidence: row.assessmentEvidence,
        generatedAt: row.assessmentGeneratedAt ?? row.updatedAt,
      }),
    placementCandidate: null,
    cooperationPath: row.manualActionId === null
        || row.manualActionId === undefined
      ? null
      : {
        factId: String(row.cooperationPathFactId),
        manualActionId: String(row.manualActionId),
        pathType: row.cooperationPathType as NonEmailCooperationPathType,
        pathUrl: String(row.cooperationPathUrl),
        contentType: row.cooperationContentType as
          OpportunityCooperationPath["contentType"],
        editableContent: String(row.cooperationEditableContent),
        state: row.cooperationState as ManualActionState,
        nextAction: String(row.cooperationNextAction),
        evidence: row.cooperationEvidence as Readonly<Record<string, unknown>>,
        version: Number(row.cooperationVersion),
        updatedAt: toIsoString(row.cooperationUpdatedAt),
      },
    selectionSnapshot: {
      lineageStatus: generationContractId !== null
          && inputPinId !== null
          && row.selectionImmutableFingerprint !== null
          && row.selectionImmutableFingerprint !== undefined
        ? "COMPLETE"
        : "PARTIAL",
      recommendationId,
      recommendationContextVersionId,
      visiblePoolGeneration,
      generationContractId,
      inputPinId,
      scoreModelVersion: optionalString(row.selectionScoreModelVersion),
      projectContextVersion: row.selectionProjectContextVersion === null
          || row.selectionProjectContextVersion === undefined
        ? null
        : Number(row.selectionProjectContextVersion),
      siteProfileVersionId: optionalString(row.selectionSiteProfileVersionId),
      outreachProfileVersionId: optionalString(
        row.selectionOutreachProfileVersionId,
      ),
      promotionTargetVersionId: optionalString(
        row.selectionPromotionTargetVersionId,
      ),
      immutableFingerprint: optionalString(row.selectionImmutableFingerprint),
      selectedTargetUrl: optionalString(row.selectionTargetUrl),
      selectedContactCandidateId: listItem.sourceContactCandidateId,
      selectedCooperationPathFactId: optionalString(row.cooperationPathFactId),
      selectedCooperationPathVersion: row.cooperationVersion === null
          || row.cooperationVersion === undefined
        ? null
        : Number(row.cooperationVersion),
      selectedBy: String(row.selectedBy),
      selectedAt: toIsoString(row.createdAt),
    },
  };
}

const listColumns = `
  o.id,o.target_site_key "targetSiteKey",o.target_host_ascii "targetHostAscii",
  o.join_sequence "joinSequence",o.business_stage "businessStage",
  o.management_status "managementStatus",o.outcome_status "outcomeStatus",
  o.fulfillment_status "fulfillmentStatus",
  o.engagement_channel "engagementChannel",
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
    SELECT manual.state
      FROM backlink_opportunity_manual_actions manual
     WHERE (manual.organization_id,manual.workspace_id,
            manual.website_project_id,manual.opportunity_id)=
           (o.organization_id,o.workspace_id,o.website_project_id,o.id)
     LIMIT 1
  ) "manualActionState",
  (
    SELECT jsonb_build_object(
      'id',draft.id,
      'status',draft.status,
      'currentVersionSource',version.source
    )
      FROM backlink_email_drafts draft
      LEFT JOIN backlink_draft_versions version ON
        (version.organization_id,version.workspace_id,
         version.website_project_id,version.id)=
        (draft.organization_id,draft.workspace_id,
         draft.website_project_id,draft.current_version_id)
     WHERE (draft.organization_id,draft.workspace_id,
            draft.website_project_id,draft.opportunity_id)=
           (o.organization_id,o.workspace_id,o.website_project_id,o.id)
     ORDER BY draft.updated_at DESC,draft.id DESC
     LIMIT 1
  ) "draftState",
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
    OR EXISTS (
      SELECT 1 FROM backlink_opportunity_manual_actions manual
       WHERE (manual.organization_id,manual.workspace_id,
              manual.website_project_id,manual.opportunity_id)=
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
               s.generated_at "assessmentGeneratedAt",
               manual.id "manualActionId",
               manual.cooperation_path_fact_id "cooperationPathFactId",
               manual.path_type "cooperationPathType",
               manual.path_url "cooperationPathUrl",
               manual.content_type "cooperationContentType",
               manual.editable_content "cooperationEditableContent",
               manual.state "cooperationState",
               manual.next_action "cooperationNextAction",
               manual.evidence "cooperationEvidence",
               manual.version "cooperationVersion",
               manual.updated_at "cooperationUpdatedAt",
               COALESCE(
                 created_event.after_state->>'selectedBy',o.created_by
               ) "selectedBy",
               COALESCE(
                 NULLIF(
                   created_event.after_state->>'visiblePoolGeneration',''
                 )::integer,
                 selection.visible_pool_generation
               )
                 "selectionVisiblePoolGeneration",
               COALESCE(
                 created_event.after_state->>'generationContractId',
                 selection.generation_contract_id::text
               )
                 "selectionGenerationContractId",
               COALESCE(
                 created_event.after_state->>'inputPinId',
                 selection.input_pin_id::text
               ) "selectionInputPinId",
               COALESCE(
                 created_event.after_state->>'scoreModelVersion',
                 selection.score_model_version
               ) "selectionScoreModelVersion",
               COALESCE(
                 CASE
                   WHEN created_event.after_state->>'projectContextVersion'
                     ~ '^[1-9][0-9]*$'
                     THEN (
                       created_event.after_state->>'projectContextVersion'
                     )::integer
                   ELSE NULL
                 END,
                 selection.project_context_version
               )
                 "selectionProjectContextVersion",
               COALESCE(
                 created_event.after_state->>'siteProfileVersionId',
                 selection.site_profile_version_id
               )
                 "selectionSiteProfileVersionId",
               COALESCE(
                 created_event.after_state->>'outreachProfileVersionId',
                 selection.outreach_profile_version_id::text
               )
                 "selectionOutreachProfileVersionId",
               COALESCE(
                 created_event.after_state->>'promotionTargetVersionId',
                 selection.promotion_target_version_id
               )
                 "selectionPromotionTargetVersionId",
               COALESCE(
                 created_event.after_state->>'immutableFingerprint',
                 selection.immutable_fingerprint
               )
                 "selectionImmutableFingerprint",
               COALESCE(
                 created_event.after_state->>'selectedTargetUrl',
                 selection.selected_target_url
               ) "selectionTargetUrl"
          FROM backlink_opportunities o
          LEFT JOIN LATERAL (
            SELECT id,total_score,score_model_version,rule_version,
                   components,evidence,generated_at
              FROM backlink_recommendation_scores s
             WHERE (s.organization_id,s.workspace_id,s.website_project_id,
                    s.recommendation_id)=(o.organization_id,o.workspace_id,
                    o.website_project_id,o.recommendation_id)
               AND s.score_model_version<>
                 'recommendation-commercial-fit.v3'
             ORDER BY s.generated_at DESC,s.id DESC LIMIT 1
          ) s ON true
          LEFT JOIN backlink_opportunity_manual_actions manual ON
            (manual.organization_id,manual.workspace_id,
             manual.website_project_id,manual.opportunity_id)=
            (o.organization_id,o.workspace_id,o.website_project_id,o.id)
          LEFT JOIN LATERAL (
            SELECT event.after_state
              FROM backlink_lifecycle_events event
             WHERE (
               event.organization_id,event.workspace_id,
               event.website_project_id,event.aggregate_type,
               event.aggregate_id,event.event_type
             )=(
               o.organization_id,o.workspace_id,o.website_project_id,
               'opportunity',o.id,'opportunity.created'
             )
             ORDER BY event.sequence,event.created_at,event.id
             LIMIT 1
          ) created_event ON true
          LEFT JOIN LATERAL (
            SELECT inventory.visible_pool_generation,
                   generation.id generation_contract_id,
                   generation.input_pin_id,
                   generation.score_model_version,
                   pin.project_context_version,
                   pin.site_profile_version_id,
                   pin.outreach_profile_version_id,
                   pin.promotion_target_version_id,
                   pin.immutable_fingerprint,
                   outreach.target_urls->>0 selected_target_url
              FROM backlink_recommendation_inventory inventory
              LEFT JOIN backlink_recommendation_generation_contracts generation
                ON (
                  generation.organization_id,generation.workspace_id,
                  generation.website_project_id,
                  generation.recommendation_context_version_id,
                  generation.visible_pool_generation
                )=(
                  inventory.organization_id,inventory.workspace_id,
                  inventory.website_project_id,
                  inventory.recommendation_context_version_id,
                  inventory.visible_pool_generation
                )
              LEFT JOIN backlink_generation_input_pins pin ON
                (pin.organization_id,pin.workspace_id,pin.website_project_id,
                 pin.id)=
                (generation.organization_id,generation.workspace_id,
                 generation.website_project_id,generation.input_pin_id)
              LEFT JOIN backlink_outreach_profile_versions outreach ON
                (outreach.organization_id,outreach.workspace_id,
                 outreach.website_project_id,outreach.id)=
                (pin.organization_id,pin.workspace_id,pin.website_project_id,
                 pin.outreach_profile_version_id)
             WHERE (
               inventory.organization_id,inventory.workspace_id,
               inventory.website_project_id,inventory.recommendation_id,
               inventory.recommendation_context_version_id
             )=(
               o.organization_id,o.workspace_id,o.website_project_id,
               o.recommendation_id,o.recommendation_context_version_id
             )
             ORDER BY
               abs(extract(epoch FROM (inventory.updated_at-o.created_at))),
               inventory.visible_pool_generation DESC
             LIMIT 1
          ) selection ON true
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
