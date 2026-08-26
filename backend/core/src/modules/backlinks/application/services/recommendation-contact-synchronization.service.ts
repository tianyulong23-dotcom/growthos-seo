import {
  synchronizeRecommendationPublication,
  type RecommendationPublicationClient,
} from "./recommendation-publication.service.js";

export type RecommendationContactSynchronizationInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  prospectId: string;
  recommendationContextVersionId: string;
  actorId: string;
}>;

export type OpportunityContactReconciliationInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  prospectId?: string;
  recommendationContextVersionId?: string;
}>;

export async function reconcilePublishedOpportunityContacts(
  client: RecommendationPublicationClient,
  input: OpportunityContactReconciliationInput,
): Promise<number> {
  const result = await client.query(
    `WITH published_contact AS MATERIALIZED (
       SELECT DISTINCT ON (
         inventory.recommendation_id,inventory.prospect_id,
         inventory.recommendation_context_version_id
       )
              inventory.recommendation_id,inventory.prospect_id,
              inventory.recommendation_context_version_id,
              candidate.id candidate_id,candidate.normalized_email,
              candidate.confidence,candidate.observed_role,
              candidate.inferred_purpose,candidate.purpose_confidence,
              candidate.purpose_rule_version,candidate.purpose_evidence
         FROM backlink_recommendation_inventory AS inventory
         JOIN backlink_contact_evidence_snapshots AS snapshot ON
           (
             snapshot.organization_id,snapshot.workspace_id,
             snapshot.website_project_id,snapshot.id,
             snapshot.recommendation_id,snapshot.prospect_id,
             snapshot.recommendation_context_version_id,
             snapshot.contact_candidate_id
           )=(
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id,
             inventory.contact_evidence_snapshot_id,
             inventory.recommendation_id,inventory.prospect_id,
             inventory.recommendation_context_version_id,
             inventory.default_contact_candidate_id
           )
         JOIN backlink_contact_candidates AS candidate ON
           (
             candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id,candidate.id,
             candidate.prospect_id,
             candidate.recommendation_context_version_id
           )=(
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id,
             inventory.default_contact_candidate_id,inventory.prospect_id,
             inventory.recommendation_context_version_id
           )
         JOIN backlink_contact_evidence AS evidence ON
           (
             evidence.organization_id,evidence.workspace_id,
             evidence.website_project_id,evidence.id,evidence.candidate_id
           )=(
             snapshot.organization_id,snapshot.workspace_id,
             snapshot.website_project_id,snapshot.contact_evidence_id,
             candidate.id
           )
        WHERE (
          inventory.organization_id,inventory.workspace_id,
          inventory.website_project_id
        )=($1,$2,$3)
          AND ($5::uuid IS NULL OR inventory.prospect_id=$5)
          AND (
            $6::uuid IS NULL
            OR inventory.recommendation_context_version_id=$6
          )
          AND inventory.publication_status='PUBLISHED'
          AND inventory.fit_decision='eligible'
          AND inventory.contact_decision='eligible'
          AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
          AND inventory.verified_public_email_count>=1
          AND inventory.status IN ('ready','shown','accepted')
          AND candidate.status IN ('candidate','promoted')
          AND candidate.invalidated_at IS NULL
          AND candidate.guessed=false
          AND candidate.confidence>=80
          AND candidate.purpose_confidence>=70
          AND candidate.inferred_purpose IN (
            'press','editorial','partnerships','advertising','business',
            'marketing','site_owner','general'
          )
          AND lower(candidate.normalized_email) ~
            '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
          AND split_part(lower(candidate.normalized_email),'@',1) !~
            '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
          AND candidate.email_domain_ascii NOT IN (
            'example.com','example.org','example.net'
          )
          AND candidate.email_domain_ascii NOT LIKE '%.invalid'
          AND evidence.invalidated_at IS NULL
          AND evidence.expires_at>now()
          AND evidence.confidence>=80
          AND evidence.extraction_method IN (
            'mailto','visible_text','obfuscated_text','json_ld'
          )
          AND evidence.source_url=snapshot.source_url
        ORDER BY inventory.recommendation_id,inventory.prospect_id,
                 inventory.recommendation_context_version_id,
                 inventory.visible_pool_generation DESC,
                 inventory.updated_at DESC,inventory.id DESC
     ),
     selected AS MATERIALIZED (
       SELECT opportunity.id opportunity_id,
              opportunity.version previous_version,published_contact.*
         FROM published_contact
         JOIN backlink_opportunities AS opportunity ON
           (
             opportunity.organization_id,opportunity.workspace_id,
             opportunity.website_project_id,opportunity.recommendation_id,
             opportunity.prospect_id,
             opportunity.recommendation_context_version_id
           )=(
             $1,$2,$3,published_contact.recommendation_id,
             published_contact.prospect_id,
             published_contact.recommendation_context_version_id
           )
        WHERE opportunity.engagement_channel='EMAIL'
          AND opportunity.source_contact_candidate_id IS NULL
          AND opportunity.contact_review_required=true
        FOR UPDATE OF opportunity
     ),
     promoted AS (
       UPDATE backlink_contact_candidates AS candidate
          SET status='promoted',version=candidate.version+1,
              updated_at=now(),updated_by=$4
         FROM selected
        WHERE (
          candidate.organization_id,candidate.workspace_id,
          candidate.website_project_id,candidate.id
        )=($1,$2,$3,selected.candidate_id)
          AND candidate.status='candidate'
       RETURNING candidate.id
     ),
     inserted_contact AS (
       INSERT INTO backlink_contacts (
         id,organization_id,workspace_id,website_project_id,prospect_id,
         recommendation_context_version_id,source_candidate_id,
         normalized_email,contact_role,confidence,guessed,observed_role,
         inferred_purpose,purpose_confidence,purpose_rule_version,
         purpose_evidence,confirmed_at,confirmed_by,status,created_by,
         updated_by
       )
       SELECT gen_random_uuid(),$1,$2,$3,selected.prospect_id,
              selected.recommendation_context_version_id,
              selected.candidate_id,selected.normalized_email,
              selected.inferred_purpose,selected.confidence,false,
              selected.observed_role,selected.inferred_purpose,
              selected.purpose_confidence,selected.purpose_rule_version,
              selected.purpose_evidence,now(),$4,'active',$4,$4
         FROM selected
        WHERE EXISTS (
          SELECT 1
            FROM promoted
           WHERE promoted.id=selected.candidate_id
          UNION ALL
          SELECT 1
            FROM backlink_contact_candidates AS candidate
           WHERE (
             candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id,candidate.id
           )=($1,$2,$3,selected.candidate_id)
             AND candidate.status='promoted'
        )
       ON CONFLICT DO NOTHING
       RETURNING source_candidate_id
     ),
     available_contact AS (
       SELECT source_candidate_id candidate_id FROM inserted_contact
       UNION
       SELECT contact.source_candidate_id
         FROM selected
         JOIN backlink_contacts AS contact ON
           (
             contact.organization_id,contact.workspace_id,
             contact.website_project_id,contact.prospect_id,
             contact.recommendation_context_version_id,
             contact.source_candidate_id
           )=(
             $1,$2,$3,selected.prospect_id,
             selected.recommendation_context_version_id,
             selected.candidate_id
           )
        WHERE contact.status='active'
          AND contact.guessed=false
          AND contact.invalidated_at IS NULL
     ),
     changed AS (
       UPDATE backlink_opportunities AS opportunity
          SET source_contact_candidate_id=selected.candidate_id,
              contact_review_required=false,
              version=opportunity.version+1,
              updated_at=now(),updated_by=$4
         FROM selected
        WHERE opportunity.id=selected.opportunity_id
          AND EXISTS (
            SELECT 1
              FROM available_contact
             WHERE candidate_id=selected.candidate_id
          )
       RETURNING opportunity.id opportunity_id,opportunity.version,
                 selected.previous_version,selected.candidate_id,
                 selected.normalized_email
     ),
     lifecycle AS (
       INSERT INTO backlink_lifecycle_events (
         id,organization_id,workspace_id,website_project_id,aggregate_type,
         aggregate_id,sequence,aggregate_version,event_type,actor_type,
         actor_id,before_state,after_state,reason,correlation_id,
         idempotency_key
       )
       SELECT gen_random_uuid(),$1,$2,$3,'opportunity',
              changed.opportunity_id,changed.version,changed.version,
              'opportunity.contact_auto_bound','system',$4,
              jsonb_build_object(
                'contactCandidateId',NULL,
                'contactReviewRequired',true,
                'version',changed.previous_version
              ),
              jsonb_build_object(
                'contactCandidateId',changed.candidate_id,
                'contactReviewRequired',false,
                'version',changed.version
              ),
              'published_contact_reconciled',
              'opportunity.contact-auto-bound:'||
                changed.opportunity_id::text||':'||
                changed.candidate_id::text,
              'opportunity.contact-auto-bound:'||
                changed.opportunity_id::text||':'||
                changed.candidate_id::text
         FROM changed
       ON CONFLICT DO NOTHING
       RETURNING id,aggregate_id
     ),
     audit AS (
       INSERT INTO backlink_audit_events (
         id,organization_id,workspace_id,website_project_id,
         lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
         outcome,reason,before_redacted,after_redacted,request_id,
         correlation_id,integrity_hash
       )
       SELECT gen_random_uuid(),$1,$2,$3,lifecycle.id,$4,'system',
              'opportunity.contact_auto_bound','opportunity',
              changed.opportunity_id,'success',
              'published_contact_reconciled',
              jsonb_build_object(
                'contactCandidateId',NULL,
                'contactReviewRequired',true,
                'version',changed.previous_version
              ),
              jsonb_build_object(
                'contactCandidateId',changed.candidate_id,
                'contactReviewRequired',false,
                'version',changed.version
              ),
              'opportunity.contact-auto-bound:'||
                changed.opportunity_id::text||':'||
                changed.candidate_id::text,
              'opportunity.contact-auto-bound:'||
                changed.opportunity_id::text||':'||
                changed.candidate_id::text,
              encode(sha256(convert_to(
                'opportunity.contact-auto-bound:'||
                  changed.opportunity_id::text||':'||
                  changed.candidate_id::text||':'||
                  changed.version::text,
                'UTF8'
              )),'hex')
         FROM lifecycle
         JOIN changed ON changed.opportunity_id=lifecycle.aggregate_id
       RETURNING target_id
     )
     SELECT count(DISTINCT changed.opportunity_id)::integer
              "reconciledCount"
       FROM changed
       LEFT JOIN audit ON audit.target_id=changed.opportunity_id`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.actorId,
      input.prospectId ?? null,
      input.recommendationContextVersionId ?? null,
    ],
  );
  return Number(result.rows[0]?.reconciledCount ?? 0);
}

export async function synchronizeRecommendationContactState(
  client: RecommendationPublicationClient,
  input: RecommendationContactSynchronizationInput,
): Promise<Readonly<{
  emailCount: number;
  reconciledOpportunityCount: number;
}>> {
  const emailCount = await synchronizeRecommendationPublication(client, input);
  const reconciledOpportunityCount =
    await reconcilePublishedOpportunityContacts(client, input);
  return Object.freeze({ emailCount, reconciledOpportunityCount });
}
