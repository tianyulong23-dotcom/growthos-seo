import { allowedOutreachTargetSql } from "./outreach-target-predicate.js";
import { verifiedPublicContactSql } from "./verified-public-contact.sql.js";

export type RecommendationFeedOpportunityCreation = Readonly<{
  opportunityId: string;
  recommendationId: string;
  recommendationFeedItemId: string;
  cycleId: string;
  websiteProjectId: string;
  targetSiteKey: string;
  targetHostAscii: string;
  contactCandidateId: string | null;
  contactReviewRequired: boolean;
  joinSequence: number;
  businessStage: "JOINED";
  managementStatus: "ACTIVE";
  outcomeStatus: "OPEN";
  fulfillmentStatus: "NOT_EXPECTED";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
  existingOpportunity: boolean;
  teamAdded: boolean;
  createdByCurrentUser: boolean;
}>;

export type RecommendationFeedOpportunityCreationRow = Readonly<{
  state: "completed" | "existing" | "replay" | "not_found";
  requestHash: string;
  responseBody?: RecommendationFeedOpportunityCreation;
}>;

export type RecommendationFeedOpportunityCreateInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  recommendationFeedItemId: string;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
  idempotencyRecordId: string;
  opportunityId: string;
  cycleId: string;
  lifecycleEventId: string;
  auditEventId: string;
  contactId: string;
  opportunityCreatedActionId: string;
}>;

export type RecommendationFeedOpportunityRepository = Readonly<{
  createFromRecommendationFeedItem(
    input: RecommendationFeedOpportunityCreateInput,
  ): Promise<RecommendationFeedOpportunityCreationRow>;
}>;

type Client = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export async function createOpportunityFromRecommendationFeedItem(
  client: Client,
  input: RecommendationFeedOpportunityCreateInput,
): Promise<RecommendationFeedOpportunityCreationRow> {
  const result = await client.query(
    `WITH idempotency_guard AS (
       SELECT pg_advisory_xact_lock(
         hashtextextended(
           $2::uuid::text || ':' || $6 || ':opportunity.create.feed-item',
           0
         )
       )
     ),
     prior AS (
       SELECT record.request_hash AS "requestHash",
              record.response_body AS "responseBody"
         FROM idempotency_guard
         CROSS JOIN LATERAL (
           SELECT request_hash, response_body
             FROM backlink_idempotency_records
            WHERE workspace_id=$2
              AND idempotency_key=$6
              AND command_type='opportunity.create.feed-item'
         ) AS record
     ),
     entitled AS (
       SELECT item.id AS item_id,
              item.organization_id,item.workspace_id,item.website_project_id,
              item.recommendation_id,
              item.prospect_id,
              item.inventory_id,
              item.candidate_id AS commercial_candidate_id,
              item.generation_contract_id,
              item.input_pin_id,
              item.recommendation_context_version_id,
              item.visible_pool_generation,
              item.recommendation_marker_version,
              item.contact_email_at_release,
              batch.id AS batch_id,
              batch.selection_policy_version,
              prospect.hostname_ascii,
              prospect.registrable_domain,
              prospect.normalization_version,
              pin.project_context_version,
              pin.immutable_fingerprint,
              outreach.target_urls->>0 AS selected_target_url,
              inventory.default_contact_candidate_id,
              inventory.contact_evidence_snapshot_id
         FROM idempotency_guard
         JOIN backlink_recommendation_release_batch_items AS item
           ON (item.organization_id,item.workspace_id,
               item.website_project_id,item.id)=($1,$2,$3,$5)
         JOIN backlink_recommendation_release_batches AS batch
           ON (batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id,
               batch.recommendation_context_version_id,
               batch.visible_pool_generation)=
              (item.organization_id,item.workspace_id,
               item.website_project_id,item.batch_id,
               item.recommendation_context_version_id,
               item.visible_pool_generation)
          AND batch.state='AVAILABLE'
         JOIN backlink_recommendation_user_publications AS publication
           ON (publication.organization_id,publication.workspace_id,
               publication.website_project_id,publication.batch_id,
               publication.recommendation_context_version_id,
               publication.visible_pool_generation)=
              (item.organization_id,item.workspace_id,
               item.website_project_id,item.batch_id,
               item.recommendation_context_version_id,
               item.visible_pool_generation)
          AND publication.user_id=$4
          AND publication.publication_state='ACTIVE'
         JOIN backlink_recommendation_generation_contracts AS generation
           ON (generation.organization_id,generation.workspace_id,
               generation.website_project_id,generation.id,
               generation.recommendation_context_version_id,
               generation.visible_pool_generation,generation.input_pin_id,
               generation.pool_contract_version)=
              (item.organization_id,item.workspace_id,
               item.website_project_id,item.generation_contract_id,
               item.recommendation_context_version_id,
               item.visible_pool_generation,item.input_pin_id,
               item.pool_contract_version)
         JOIN backlink_recommendation_pool_project_contracts AS contract
           ON (contract.organization_id,contract.workspace_id,
               contract.website_project_id,contract.generation_contract_id,
               contract.recommendation_context_version_id,
               contract.visible_pool_generation)=
              (generation.organization_id,generation.workspace_id,
               generation.website_project_id,generation.id,
               generation.recommendation_context_version_id,
               generation.visible_pool_generation)
          AND contract.pool_contract_version='recommendation-pool.v2'
          AND contract.migration_state='V2_ACTIVE'
         JOIN backlink_generation_input_pins AS pin
           ON (pin.organization_id,pin.workspace_id,
               pin.website_project_id,pin.id)=
              (generation.organization_id,generation.workspace_id,
               generation.website_project_id,generation.input_pin_id)
         JOIN backlink_outreach_profile_versions AS outreach
           ON (outreach.organization_id,outreach.workspace_id,
               outreach.website_project_id,outreach.id)=
              (pin.organization_id,pin.workspace_id,
               pin.website_project_id,pin.outreach_profile_version_id)
         JOIN backlink_prospects AS prospect
           ON (prospect.organization_id,prospect.workspace_id,
               prospect.website_project_id,prospect.id,
               prospect.recommendation_context_version_id)=
              (item.organization_id,item.workspace_id,
               item.website_project_id,item.prospect_id,
               item.recommendation_context_version_id)
         JOIN backlink_recommendation_inventory AS inventory
           ON (inventory.organization_id,inventory.workspace_id,
               inventory.website_project_id,inventory.id,
               inventory.recommendation_id,inventory.prospect_id,
               inventory.recommendation_context_version_id,
               inventory.visible_pool_generation)=
              (item.organization_id,item.workspace_id,
               item.website_project_id,item.inventory_id,
               item.recommendation_id,item.prospect_id,
               item.recommendation_context_version_id,
               item.visible_pool_generation)
        WHERE NOT EXISTS (SELECT 1 FROM prior)
          AND ${allowedOutreachTargetSql("item.canonical_domain")}
          AND item.candidate_id IS NOT NULL
          AND item.recommendation_id IS NOT NULL
          AND item.prospect_id IS NOT NULL
          AND item.inventory_id IS NOT NULL
          AND item.generation_contract_id IS NOT NULL
          AND item.input_pin_id IS NOT NULL
        FOR UPDATE OF publication
     ),
     domain_guard AS (
       SELECT pg_advisory_xact_lock(
         hashtextextended(
           $3::uuid::text || ':' || entitled.registrable_domain ||
             ':opportunity-domain',
           0
         )
       )
         FROM entitled
     ),
     source AS (
       SELECT entitled.*,
              CASE
                WHEN candidate.id IS NOT NULL
                  AND snapshot.id IS NOT NULL
                  AND lower(candidate.normalized_email)=
                      lower(entitled.contact_email_at_release)
                  THEN candidate.id
                ELSE verified_contact.id
              END AS contact_candidate_id
         FROM entitled
         CROSS JOIN domain_guard
         LEFT JOIN LATERAL (
           ${verifiedPublicContactSql("entitled")}
         ) verified_contact ON entitled.contact_email_at_release IS NULL
         LEFT JOIN backlink_contact_candidates AS candidate
           ON (candidate.organization_id,candidate.workspace_id,
               candidate.website_project_id,candidate.id,
               candidate.prospect_id,
               candidate.recommendation_context_version_id)=
              ($1,$2,$3,entitled.default_contact_candidate_id,
               entitled.prospect_id,
               entitled.recommendation_context_version_id)
          AND candidate.status IN ('candidate','promoted')
          AND candidate.invalidated_at IS NULL
          AND candidate.guessed=false
         LEFT JOIN backlink_contact_evidence_snapshots AS snapshot
           ON (snapshot.organization_id,snapshot.workspace_id,
               snapshot.website_project_id,snapshot.id,
               snapshot.recommendation_id,snapshot.prospect_id,
               snapshot.recommendation_context_version_id,
               snapshot.contact_candidate_id)=
              ($1,$2,$3,entitled.contact_evidence_snapshot_id,
               entitled.recommendation_id,entitled.prospect_id,
               entitled.recommendation_context_version_id,candidate.id)
     ),
     existing AS (
       SELECT opportunity.*
         FROM source
         JOIN backlink_opportunities AS opportunity
           ON (opportunity.organization_id,opportunity.workspace_id,
               opportunity.website_project_id,opportunity.target_site_key)=
              ($1,$2,$3,source.registrable_domain)
         LIMIT 1
     ),
     next_sequence AS (
       SELECT backlink_allocate_opportunity_join_sequence($1,$2,$3,$4)
                AS join_sequence
         FROM source
        WHERE NOT EXISTS (SELECT 1 FROM existing)
     ),
     created AS (
       INSERT INTO backlink_opportunities (
         id,organization_id,workspace_id,website_project_id,recommendation_id,
         prospect_id,recommendation_context_version_id,
         source_contact_candidate_id,contact_review_required,
         target_site_key,target_host_ascii,target_identity_rule_version,
         join_sequence,created_by,updated_by
       )
       SELECT $9,$1,$2,$3,source.recommendation_id,source.prospect_id,
              source.recommendation_context_version_id,
              source.contact_candidate_id,
              source.contact_candidate_id IS NULL,
              source.registrable_domain,source.hostname_ascii,
              source.normalization_version,next_sequence.join_sequence,$4,$4
         FROM source
         CROSS JOIN next_sequence
       ON CONFLICT (website_project_id,target_site_key) DO NOTHING
       RETURNING *
     ),
     candidate_promoted AS (
       UPDATE backlink_contact_candidates AS candidate
          SET status='promoted',
              version=candidate.version+1,
              updated_at=statement_timestamp(),
              updated_by=$4
         FROM source
         CROSS JOIN created
        WHERE (candidate.organization_id,candidate.workspace_id,
               candidate.website_project_id,candidate.id)=
              ($1,$2,$3,source.contact_candidate_id)
          AND candidate.status='candidate'
       RETURNING candidate.id
     ),
     auto_contact AS (
       INSERT INTO backlink_contacts (
         id,organization_id,workspace_id,website_project_id,prospect_id,
         recommendation_context_version_id,source_candidate_id,
         normalized_email,contact_role,confidence,guessed,observed_role,
         inferred_purpose,purpose_confidence,purpose_rule_version,
         purpose_evidence,confirmed_at,confirmed_by,status,created_by,updated_by
       )
       SELECT $14,$1,$2,$3,candidate.prospect_id,
              candidate.recommendation_context_version_id,candidate.id,
              candidate.normalized_email,candidate.inferred_purpose,
              candidate.confidence,false,candidate.observed_role,
              candidate.inferred_purpose,candidate.purpose_confidence,
              candidate.purpose_rule_version,candidate.purpose_evidence,
              statement_timestamp(),$4,'active',$4,$4
         FROM source
         CROSS JOIN created
         JOIN backlink_contact_candidates AS candidate
           ON (candidate.organization_id,candidate.workspace_id,
               candidate.website_project_id,candidate.id)=
              ($1,$2,$3,source.contact_candidate_id)
         LEFT JOIN candidate_promoted AS promoted
           ON promoted.id=candidate.id
       ON CONFLICT DO NOTHING
       RETURNING id
     ),
     cycle AS (
       INSERT INTO backlink_opportunity_cycles (
         id,organization_id,workspace_id,website_project_id,opportunity_id,
         cycle_number,started_at,created_by,updated_by
       )
       SELECT $10,$1,$2,$3,created.id,1,statement_timestamp(),$4,$4
         FROM created
       RETURNING id
     ),
     lifecycle AS (
       INSERT INTO backlink_lifecycle_events (
         id,organization_id,workspace_id,website_project_id,aggregate_type,
         aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,
         after_state,reason,correlation_id,idempotency_key
       )
       SELECT $11,$1,$2,$3,'opportunity',created.id,1,created.version,
              'opportunity.created','user',$4,
              jsonb_build_object(
                'businessStage',created.business_stage,
                'managementStatus',created.management_status,
                'outcomeStatus',created.outcome_status,
                'fulfillmentStatus',created.fulfillment_status,
                'joinSequence',created.join_sequence,
                'contactCandidateId',created.source_contact_candidate_id,
                'contactReviewRequired',created.contact_review_required,
                'contactAutoConfirmed',NOT created.contact_review_required,
                'poolContractVersion','recommendation-pool.v2',
                'recommendationFeedItemId',source.item_id,
                'commercialCandidateId',source.commercial_candidate_id,
                'inventoryId',source.inventory_id,
                'visiblePoolGeneration',source.visible_pool_generation,
                'generationContractId',source.generation_contract_id,
                'inputPinId',source.input_pin_id,
                'projectContextVersion',
                  source.project_context_version,
                'immutableFingerprint',source.immutable_fingerprint,
                'selectedTargetUrl',source.selected_target_url,
                'recommendationMarkerVersion',
                  source.recommendation_marker_version,
                'selectionPolicyVersion',source.selection_policy_version,
                'selectedBy',created.created_by,
                'selectedAt',created.created_at
              ),
              CASE WHEN created.contact_review_required
                THEN 'recommendation_feed_contact_review_required'
                ELSE 'recommendation_feed_contact_confirmed'
              END,
              $13,'opportunity.create.feed-item:'||$6
         FROM created
         CROSS JOIN source
         CROSS JOIN cycle
       RETURNING id
     ),
     audit AS (
       INSERT INTO backlink_audit_events (
         id,organization_id,workspace_id,website_project_id,lifecycle_event_id,
         actor_id,actor_kind,action,target_type,target_id,outcome,reason,
         after_redacted,request_id,correlation_id,integrity_hash
       )
       SELECT $12,$1,$2,$3,lifecycle.id,$4,'user','opportunity.created',
              'opportunity',created.id,'success',
              CASE WHEN created.contact_review_required
                THEN 'recommendation_feed_contact_review_required'
                ELSE 'recommendation_feed_contact_confirmed'
              END,
              jsonb_build_object(
                'recommendationId',created.recommendation_id,
                'recommendationFeedItemId',source.item_id,
                'commercialCandidateId',source.commercial_candidate_id,
                'inventoryId',source.inventory_id,
                'generationContractId',source.generation_contract_id,
                'inputPinId',source.input_pin_id,
                'poolContractVersion','recommendation-pool.v2',
                'immutableFingerprint',source.immutable_fingerprint,
                'selectedTargetUrl',source.selected_target_url,
                'contactCandidateId',created.source_contact_candidate_id,
                'contactReviewRequired',created.contact_review_required
              ),
              $13,$13,$7
         FROM lifecycle
         CROSS JOIN created
         CROSS JOIN source
       RETURNING id
     ),
     opportunity_action AS (
       INSERT INTO backlink_recommendation_user_item_actions (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,
         user_id,batch_id,batch_item_id,action_type,opportunity_id,
         idempotency_key,request_hash,created_by
       )
       SELECT $15,$1,$2,$3,source.recommendation_context_version_id,
              source.visible_pool_generation,$4,source.batch_id,source.item_id,
              'OPPORTUNITY_CREATED',created.id,$6,$7,$4
         FROM created
         CROSS JOIN source
         CROSS JOIN audit
       RETURNING id
     ),
     created_response AS (
       SELECT 'completed'::text AS state,
              jsonb_build_object(
                'opportunityId',created.id,
                'recommendationId',created.recommendation_id,
                'recommendationFeedItemId',source.item_id,
                'cycleId',$10,
                'websiteProjectId',created.website_project_id,
                'targetSiteKey',created.target_site_key,
                'targetHostAscii',created.target_host_ascii,
                'contactCandidateId',created.source_contact_candidate_id,
                'contactReviewRequired',created.contact_review_required,
                'joinSequence',created.join_sequence,
                'businessStage',created.business_stage,
                'managementStatus',created.management_status,
                'outcomeStatus',created.outcome_status,
                'fulfillmentStatus',created.fulfillment_status,
                'version',created.version,
                'lifecycleEventId',$11,
                'auditEventId',$12,
                'existingOpportunity',false,
                'teamAdded',true,
                'createdByCurrentUser',true
              ) AS response_body
         FROM created
         CROSS JOIN source
         CROSS JOIN opportunity_action
     ),
     existing_response AS (
       SELECT 'existing'::text AS state,
              jsonb_build_object(
                'opportunityId',existing.id,
                'recommendationId',existing.recommendation_id,
                'recommendationFeedItemId',source.item_id,
                'cycleId',existing_cycle.id,
                'websiteProjectId',existing.website_project_id,
                'targetSiteKey',existing.target_site_key,
                'targetHostAscii',existing.target_host_ascii,
                'contactCandidateId',existing.source_contact_candidate_id,
                'contactReviewRequired',existing.contact_review_required,
                'joinSequence',existing.join_sequence,
                'businessStage',existing.business_stage,
                'managementStatus',existing.management_status,
                'outcomeStatus',existing.outcome_status,
                'fulfillmentStatus',existing.fulfillment_status,
                'version',existing.version,
                'lifecycleEventId',existing_lifecycle.id,
                'auditEventId',existing_audit.id,
                'existingOpportunity',true,
                'teamAdded',true,
                'createdByCurrentUser',false
              ) AS response_body
         FROM existing
         CROSS JOIN source
         JOIN backlink_opportunity_cycles AS existing_cycle
           ON (existing_cycle.organization_id,existing_cycle.workspace_id,
               existing_cycle.website_project_id,
               existing_cycle.opportunity_id,existing_cycle.cycle_number)=
              ($1,$2,$3,existing.id,1)
         JOIN LATERAL (
           SELECT event.id
             FROM backlink_lifecycle_events AS event
            WHERE event.organization_id=$1
              AND event.workspace_id=$2
              AND event.website_project_id=$3
              AND event.aggregate_type='opportunity'
              AND event.aggregate_id=existing.id
              AND event.event_type='opportunity.created'
            ORDER BY event.sequence,event.id
            LIMIT 1
         ) AS existing_lifecycle ON true
         JOIN backlink_audit_events AS existing_audit
           ON (existing_audit.organization_id,existing_audit.workspace_id,
               existing_audit.website_project_id,
               existing_audit.lifecycle_event_id)=
              ($1,$2,$3,existing_lifecycle.id)
         WHERE NOT EXISTS (SELECT 1 FROM created)
     ),
     effective_response AS (
       SELECT * FROM created_response
       UNION ALL
       SELECT * FROM existing_response
     ),
     completed AS (
       INSERT INTO backlink_idempotency_records (
         id,organization_id,workspace_id,website_project_id,idempotency_key,
         command_type,request_hash,response_status,response_body,
         response_schema_version,completed_at,expires_at,created_by,updated_by
       )
       SELECT $8,$1,$2,$3,$6,'opportunity.create.feed-item',$7,
              CASE WHEN effective_response.state='completed' THEN 201 ELSE 200 END,
              effective_response.response_body,1,statement_timestamp(),
              statement_timestamp()+interval '24 hours',$4,$4
         FROM effective_response
       RETURNING request_hash AS "requestHash",response_body AS "responseBody"
     )
     SELECT effective_response.state,
            completed."requestHash",completed."responseBody"
       FROM completed
       JOIN effective_response ON true
     UNION ALL
     SELECT 'replay',prior."requestHash",prior."responseBody"
       FROM prior
     UNION ALL
     SELECT 'not_found',$7,NULL::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM prior)
        AND NOT EXISTS (SELECT 1 FROM entitled)`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.actorId,
      input.recommendationFeedItemId,
      input.idempotencyKey,
      input.requestHash,
      input.idempotencyRecordId,
      input.opportunityId,
      input.cycleId,
      input.lifecycleEventId,
      input.auditEventId,
      input.requestId,
      input.contactId,
      input.opportunityCreatedActionId,
    ],
  );
  return result.rows[0] as RecommendationFeedOpportunityCreationRow;
}
