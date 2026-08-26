export type OpportunityCreation = Readonly<{
  opportunityId: string; recommendationId: string; cycleId: string;
  websiteProjectId: string; targetSiteKey: string; targetHostAscii: string;
  contactCandidateId: string | null; contactReviewRequired: boolean;
  joinSequence: number; businessStage: "JOINED"; managementStatus: "ACTIVE";
  outcomeStatus: "OPEN"; fulfillmentStatus: "NOT_EXPECTED"; version: number;
  lifecycleEventId: string; auditEventId: string;
}>;
export type OpportunityCreationRow = Readonly<{
  state: "completed" | "replay" | "not_found" | "version_conflict" |
    "contact_required" | "duplicate";
  requestHash: string; responseBody?: OpportunityCreation;
}>;
export type OpportunityTransition = Readonly<{
  opportunityId: string; businessStage: OpportunityBusinessStage;
  managementStatus: OpportunityManagementStatus;
  outcomeStatus: OpportunityOutcomeStatus;
  fulfillmentStatus: OpportunityFulfillmentStatus; version: number;
  lifecycleEventId: string; auditEventId: string;
}>;
export type OpportunityTransitionRow = Readonly<{
  state: "completed" | "replay" | "not_found" |
    "version_conflict" | "invalid_transition";
  requestHash: string; responseBody?: OpportunityTransition; currentStage?: string;
}>;
export type OpportunityManagementPatch = OpportunityTransition;
export type OpportunityManagementPatchRow = Readonly<{
  state: "completed" | "replay" | "not_found" | "version_conflict" | "unchanged";
  requestHash: string; responseBody?: OpportunityManagementPatch;
}>;
type CreateInput = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
  actorId: string; recommendationId: string; contactCandidateId: string | null;
  expectedVersion: number;
  idempotencyKey: string; requestHash: string; requestId: string;
  idempotencyRecordId: string; opportunityId: string; cycleId: string;
  lifecycleEventId: string; auditEventId: string; contactId: string;
}>;
type TransitionInput = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
  actorId: string; opportunityId: string; expectedVersion: number;
  toBusinessStage: OpportunityBusinessStage;
  allowedFromStages: readonly OpportunityBusinessStage[]; reason: string;
  idempotencyKey: string; requestHash: string; requestId: string;
  idempotencyRecordId: string; lifecycleEventId: string; auditEventId: string;
}>;
type ManagementPatchInput = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
  actorId: string; opportunityId: string; expectedVersion: number;
  managementStatus: OpportunityManagementStatus; reason: string;
  idempotencyKey: string; requestHash: string; requestId: string;
  idempotencyRecordId: string; lifecycleEventId: string; auditEventId: string;
}>;
type Client = Readonly<{ query(text: string, values?: readonly unknown[]):
  Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>> }>;
export type OpportunityRepository = Readonly<{
  createFromRecommendation(input: CreateInput): Promise<OpportunityCreationRow>;
  transitionBusinessStage(input: TransitionInput): Promise<OpportunityTransitionRow>;
  patchManagement(input: ManagementPatchInput): Promise<OpportunityManagementPatchRow>;
}>;

export function createOpportunityRepository(client: Client): OpportunityRepository {
  return Object.freeze({
    async createFromRecommendation(input) {
      const sql = `WITH guard AS (
  SELECT pg_advisory_xact_lock(
    hashtextextended(
      $2::uuid::text||':'||$8||':opportunity.create',0
    )
  )
),
prior AS (
  SELECT i.request_hash "requestHash",i.response_body "responseBody"
    FROM guard
    CROSS JOIN LATERAL (
      SELECT *
        FROM backlink_idempotency_records
       WHERE workspace_id=$2
         AND idempotency_key=$8
         AND command_type='opportunity.create'
    ) i
),
present AS (
  SELECT i.*
    FROM guard,backlink_recommendation_inventory i
   WHERE (i.organization_id,i.workspace_id,i.website_project_id,
          i.recommendation_id)=($1,$2,$3,$5)
     AND NOT EXISTS (SELECT 1 FROM prior)
   FOR UPDATE OF i
),
versioned AS (
  SELECT *
    FROM present i
   WHERE version=$7
     AND status IN ('ready','shown')
     AND (
       NOT EXISTS (
         SELECT 1
           FROM backlink_commercial_inventory_policies policy
          WHERE (
            policy.organization_id,policy.workspace_id,
            policy.website_project_id
          )=(i.organization_id,i.workspace_id,i.website_project_id)
       )
       OR EXISTS (
         SELECT 1
           FROM backlink_commercial_inventory_policies policy
          WHERE (
            policy.organization_id,policy.workspace_id,
            policy.website_project_id,policy.project_context_version_id,
            policy.visible_pool_generation
          )=(
            i.organization_id,i.workspace_id,i.website_project_id,
            i.recommendation_context_version_id,i.visible_pool_generation
          )
            AND policy.visible_pool_state IN ('building','active')
            AND (
              policy.updated_at,policy.version,
              policy.project_context_version_id
            )=(
              SELECT current_policy.updated_at,current_policy.version,
                     current_policy.project_context_version_id
                FROM backlink_commercial_inventory_policies current_policy
               WHERE (
                 current_policy.organization_id,current_policy.workspace_id,
                 current_policy.website_project_id
               )=(i.organization_id,i.workspace_id,i.website_project_id)
               ORDER BY current_policy.updated_at DESC,
                        current_policy.version DESC,
                        current_policy.project_context_version_id DESC
               LIMIT 1
            )
       )
     )
),
selection AS (
  SELECT i.*,
         generation.id selection_generation_contract_id,
         generation.input_pin_id selection_input_pin_id,
         generation.score_model_version selection_score_model_version,
         pin.project_context_version selection_project_context_version,
         pin.site_profile_version_id selection_site_profile_version_id,
         pin.outreach_profile_version_id selection_outreach_profile_version_id,
         pin.promotion_target_version_id
           selection_promotion_target_version_id,
         pin.immutable_fingerprint selection_immutable_fingerprint,
         outreach.target_urls->>0 selection_target_url
    FROM versioned i
    LEFT JOIN backlink_recommendation_generation_contracts generation ON
      (
        generation.organization_id,generation.workspace_id,
        generation.website_project_id,
        generation.recommendation_context_version_id,
        generation.visible_pool_generation
      )=(
        i.organization_id,i.workspace_id,i.website_project_id,
        i.recommendation_context_version_id,i.visible_pool_generation
      )
    LEFT JOIN backlink_generation_input_pins pin ON
      (pin.organization_id,pin.workspace_id,pin.website_project_id,pin.id)=
      (generation.organization_id,generation.workspace_id,
       generation.website_project_id,generation.input_pin_id)
    LEFT JOIN backlink_outreach_profile_versions outreach ON
      (outreach.organization_id,outreach.workspace_id,
       outreach.website_project_id,outreach.id)=
      (pin.organization_id,pin.workspace_id,pin.website_project_id,
       pin.outreach_profile_version_id)
),
source AS (
  SELECT i.id inventory_id,i.recommendation_id,i.prospect_id,
         i.recommendation_context_version_id,p.hostname_ascii,
         p.registrable_domain,p.normalization_version,
         c.id contact_candidate_id,
         false contact_review_required,
         i.visible_pool_generation,
         i.selection_generation_contract_id,
         i.selection_input_pin_id,
         i.selection_score_model_version,
         i.selection_project_context_version,
         i.selection_site_profile_version_id,
         i.selection_outreach_profile_version_id,
         i.selection_promotion_target_version_id,
         i.selection_immutable_fingerprint,
         i.selection_target_url
    FROM selection i
    JOIN backlink_prospects p ON
      (p.organization_id,p.workspace_id,p.website_project_id,p.id,
       p.recommendation_context_version_id)=
      (i.organization_id,i.workspace_id,i.website_project_id,i.prospect_id,
       i.recommendation_context_version_id)
    JOIN backlink_contact_candidates c ON
      (c.organization_id,c.workspace_id,c.website_project_id,c.id,
       c.prospect_id,c.recommendation_context_version_id)=
      (i.organization_id,i.workspace_id,i.website_project_id,$6,
       i.prospect_id,i.recommendation_context_version_id)
    JOIN backlink_contact_evidence_snapshots snapshot ON
      (snapshot.organization_id,snapshot.workspace_id,
       snapshot.website_project_id,snapshot.id,
       snapshot.recommendation_id,snapshot.prospect_id,
       snapshot.recommendation_context_version_id,
       snapshot.contact_candidate_id)=
      (i.organization_id,i.workspace_id,i.website_project_id,
       i.contact_evidence_snapshot_id,i.recommendation_id,i.prospect_id,
       i.recommendation_context_version_id,c.id)
    JOIN backlink_contact_evidence e ON
      (e.organization_id,e.workspace_id,e.website_project_id,e.id,
       e.candidate_id)=
      (snapshot.organization_id,snapshot.workspace_id,
       snapshot.website_project_id,snapshot.contact_evidence_id,c.id)
   WHERE c.status IN ('candidate','promoted')
     AND c.invalidated_at IS NULL
     AND c.guessed=false
     AND c.confidence>=80
     AND c.purpose_confidence>=70
     AND c.inferred_purpose IN (
       'press','editorial','partnerships','advertising','business',
       'marketing','site_owner','general'
     )
     AND lower(c.normalized_email) ~
       '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
     AND split_part(lower(c.normalized_email),'@',1) !~
       '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
     AND c.email_domain_ascii NOT IN (
       'example.com','example.org','example.net'
     )
     AND c.email_domain_ascii NOT LIKE '%.invalid'
     AND e.invalidated_at IS NULL
     AND e.expires_at > now()
     AND e.confidence>=80
     AND e.extraction_method IN (
       'mailto','visible_text','obfuscated_text','json_ld'
     )
     AND e.source_url=snapshot.source_url
     AND $6::uuid IS NOT NULL
  UNION ALL
  SELECT i.id inventory_id,i.recommendation_id,i.prospect_id,
         i.recommendation_context_version_id,p.hostname_ascii,
         p.registrable_domain,p.normalization_version,
         NULL::uuid contact_candidate_id,
         true contact_review_required,
         i.visible_pool_generation,
         i.selection_generation_contract_id,
         i.selection_input_pin_id,
         i.selection_score_model_version,
         i.selection_project_context_version,
         i.selection_site_profile_version_id,
         i.selection_outreach_profile_version_id,
         i.selection_promotion_target_version_id,
         i.selection_immutable_fingerprint,
         i.selection_target_url
    FROM selection i
    JOIN backlink_prospects p ON
      (p.organization_id,p.workspace_id,p.website_project_id,p.id,
       p.recommendation_context_version_id)=
      (i.organization_id,i.workspace_id,i.website_project_id,i.prospect_id,
       i.recommendation_context_version_id)
   WHERE $6::uuid IS NULL
),
existing AS (
  SELECT o.id
    FROM source s
    JOIN backlink_opportunities o ON
      (o.organization_id,o.workspace_id,o.website_project_id,
       o.target_site_key)=
      ($1,$2,$3,s.registrable_domain)
   LIMIT 1
),
next_sequence AS (
  SELECT backlink_allocate_opportunity_join_sequence(
    $1,$2,$3,$4
  ) join_sequence
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
  SELECT $11,$1,$2,$3,s.recommendation_id,s.prospect_id,
         s.recommendation_context_version_id,s.contact_candidate_id,
         s.contact_review_required,s.registrable_domain,s.hostname_ascii,
         s.normalization_version,n.join_sequence,$4,$4
    FROM source s,next_sequence n
  ON CONFLICT (website_project_id,target_site_key) DO NOTHING
  RETURNING *
),
candidate_promoted AS (
  UPDATE backlink_contact_candidates c
     SET status='promoted',version=c.version+1,updated_at=now(),updated_by=$4
    FROM source s,created o
   WHERE (c.organization_id,c.workspace_id,c.website_project_id,c.id)=
         ($1,$2,$3,s.contact_candidate_id)
     AND s.contact_review_required=false
     AND c.status='candidate'
  RETURNING c.id
),
auto_contact AS (
  INSERT INTO backlink_contacts (
    id,organization_id,workspace_id,website_project_id,prospect_id,
    recommendation_context_version_id,source_candidate_id,normalized_email,
    contact_role,confidence,guessed,observed_role,inferred_purpose,
    purpose_confidence,purpose_rule_version,purpose_evidence,
    confirmed_at,confirmed_by,status,created_by,updated_by
  )
  SELECT $16,$1,$2,$3,c.prospect_id,c.recommendation_context_version_id,
         c.id,c.normalized_email,c.inferred_purpose,c.confidence,false,
         c.observed_role,c.inferred_purpose,c.purpose_confidence,
         c.purpose_rule_version,c.purpose_evidence,
         now(),$4,'active',$4,$4
    FROM source s
    CROSS JOIN created o
    JOIN backlink_contact_candidates c ON
      (c.organization_id,c.workspace_id,c.website_project_id,c.id)=
      ($1,$2,$3,s.contact_candidate_id)
    LEFT JOIN candidate_promoted promoted ON promoted.id=c.id
   WHERE s.contact_review_required=false
  ON CONFLICT DO NOTHING
  RETURNING id
),
cycle AS (
  INSERT INTO backlink_opportunity_cycles (
    id,organization_id,workspace_id,website_project_id,opportunity_id,
    cycle_number,started_at,created_by,updated_by
  )
  SELECT $12,$1,$2,$3,id,1,now(),$4,$4
    FROM created
  RETURNING id
),
inventory AS (
  UPDATE backlink_recommendation_inventory i
     SET status='accepted',version=i.version+1,updated_at=now(),updated_by=$4
    FROM source s,cycle
   WHERE i.id=s.inventory_id
  RETURNING i.id
),
recommendation AS (
  UPDATE backlink_recommendations r
     SET status='accepted',version=r.version+1,updated_at=now(),updated_by=$4
    FROM source s,inventory
   WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
         ($1,$2,$3,s.recommendation_id)
  RETURNING r.id
),
lifecycle AS (
  INSERT INTO backlink_lifecycle_events (
    id,organization_id,workspace_id,website_project_id,aggregate_type,
    aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,
    after_state,reason,correlation_id,idempotency_key
  )
  SELECT $13,$1,$2,$3,'opportunity',c.id,1,c.version,
         'opportunity.created','user',$4,
         jsonb_build_object(
           'businessStage',c.business_stage,
           'managementStatus',c.management_status,
           'outcomeStatus',c.outcome_status,
           'fulfillmentStatus',c.fulfillment_status,
           'joinSequence',c.join_sequence,
           'contactCandidateId',c.source_contact_candidate_id,
           'contactReviewRequired',c.contact_review_required,
           'contactAutoConfirmed',NOT c.contact_review_required,
           'visiblePoolGeneration',s.visible_pool_generation,
           'generationContractId',s.selection_generation_contract_id,
           'inputPinId',s.selection_input_pin_id,
           'scoreModelVersion',s.selection_score_model_version,
           'projectContextVersion',s.selection_project_context_version,
           'siteProfileVersionId',s.selection_site_profile_version_id,
           'outreachProfileVersionId',s.selection_outreach_profile_version_id,
           'promotionTargetVersionId',
             s.selection_promotion_target_version_id,
           'immutableFingerprint',s.selection_immutable_fingerprint,
           'selectedTargetUrl',s.selection_target_url,
           'selectedBy',c.created_by,
           'selectedAt',c.created_at
         ),
         CASE WHEN c.source_contact_candidate_id IS NULL
           THEN 'recommendation_contact_pending'
           WHEN c.contact_review_required
           THEN 'recommendation_contact_selected_review_required'
           ELSE 'recommendation_contact_confirmed'
         END,$15,
         'opportunity.create:'||$8
    FROM created c
    JOIN source s ON s.recommendation_id=c.recommendation_id
    CROSS JOIN recommendation
  RETURNING id
),
audit AS (
  INSERT INTO backlink_audit_events (
    id,organization_id,workspace_id,website_project_id,lifecycle_event_id,
    actor_id,actor_kind,action,target_type,target_id,outcome,reason,
    after_redacted,request_id,correlation_id,integrity_hash
  )
  SELECT $14,$1,$2,$3,l.id,$4,'user','opportunity.created','opportunity',
         c.id,'success',
         CASE WHEN c.source_contact_candidate_id IS NULL
           THEN 'recommendation_contact_pending'
           WHEN c.contact_review_required
           THEN 'recommendation_contact_selected_review_required'
           ELSE 'recommendation_contact_confirmed'
         END,
         jsonb_build_object(
           'recommendationId',c.recommendation_id,
           'joinSequence',c.join_sequence,
           'contactCandidateId',c.source_contact_candidate_id,
           'contactReviewRequired',c.contact_review_required,
           'contactAutoConfirmed',NOT c.contact_review_required,
           'visiblePoolGeneration',s.visible_pool_generation,
           'generationContractId',s.selection_generation_contract_id,
           'inputPinId',s.selection_input_pin_id,
           'scoreModelVersion',s.selection_score_model_version,
           'projectContextVersion',s.selection_project_context_version,
           'siteProfileVersionId',s.selection_site_profile_version_id,
           'outreachProfileVersionId',s.selection_outreach_profile_version_id,
           'promotionTargetVersionId',
             s.selection_promotion_target_version_id,
           'immutableFingerprint',s.selection_immutable_fingerprint,
           'selectedTargetUrl',s.selection_target_url
         ),
         $15,$15,$9
    FROM lifecycle l
    JOIN created c ON true
    JOIN source s ON s.recommendation_id=c.recommendation_id
  RETURNING id
),
completed AS (
  INSERT INTO backlink_idempotency_records (
    id,organization_id,workspace_id,website_project_id,idempotency_key,
    command_type,request_hash,response_status,response_body,
    response_schema_version,completed_at,expires_at,created_by,updated_by
  )
  SELECT $10,$1,$2,$3,$8,'opportunity.create',$9,201,
         jsonb_build_object(
           'opportunityId',c.id,
           'recommendationId',c.recommendation_id,
           'websiteProjectId',c.website_project_id,
           'targetSiteKey',c.target_site_key,
           'targetHostAscii',c.target_host_ascii,
           'contactCandidateId',c.source_contact_candidate_id,
           'contactReviewRequired',c.contact_review_required,
           'cycleId',$12,
           'joinSequence',c.join_sequence,
           'businessStage',c.business_stage,
           'managementStatus',c.management_status,
           'outcomeStatus',c.outcome_status,
           'fulfillmentStatus',c.fulfillment_status,
           'version',c.version,
           'lifecycleEventId',$13,
           'auditEventId',$14
         ),
         1,now(),now()+interval '24 hours',$4,$4
    FROM created c,audit
  RETURNING request_hash "requestHash",response_body "responseBody"
)
SELECT 'completed' state,* FROM completed
UNION ALL
SELECT 'replay',"requestHash","responseBody" FROM prior
UNION ALL
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM present) THEN 'not_found'
         WHEN NOT EXISTS (SELECT 1 FROM versioned) THEN 'version_conflict'
         WHEN NOT EXISTS (SELECT 1 FROM source) THEN 'contact_required'
         ELSE 'duplicate'
       END,
       $9,NULL::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM completed)
   AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [input.organizationId, input.workspaceId, input.websiteProjectId,
        input.actorId, input.recommendationId, input.contactCandidateId,
        input.expectedVersion, input.idempotencyKey, input.requestHash,
        input.idempotencyRecordId, input.opportunityId, input.cycleId,
        input.lifecycleEventId, input.auditEventId, input.requestId,
        input.contactId];
      return (await client.query(sql, values)).rows[0] as OpportunityCreationRow;
    },
    async transitionBusinessStage(input) {
      const sql = `WITH guard AS (SELECT
pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$11||':opportunity.transition',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$11 AND command_type='opportunity.transition') i),
present AS (SELECT o.* FROM guard,backlink_opportunities o WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)=($1,$2,$3,$5) AND NOT EXISTS (SELECT 1 FROM prior) FOR UPDATE OF o),
changed AS (UPDATE backlink_opportunities o SET business_stage=$7,version=o.version+1,updated_at=now(),updated_by=$4 FROM present p WHERE o.id=p.id AND p.version=$6 AND p.business_stage=ANY($8::text[]) RETURNING o.*,p.business_stage previous_business_stage),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,before_state,after_state,reason,correlation_id,idempotency_key) SELECT $13,$1,$2,$3,'opportunity',c.id,c.version,c.version,'opportunity.business_stage.transitioned','user',$4,jsonb_build_object('businessStage',c.previous_business_stage,'managementStatus',c.management_status,'outcomeStatus',c.outcome_status,'fulfillmentStatus',c.fulfillment_status,'version',$6),jsonb_build_object('businessStage',c.business_stage,'managementStatus',c.management_status,'outcomeStatus',c.outcome_status,'fulfillmentStatus',c.fulfillment_status,'version',c.version),$9,$15,'opportunity.transition:'||$11 FROM changed c RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,reason,before_redacted,after_redacted,request_id,correlation_id,integrity_hash) SELECT $14,$1,$2,$3,l.id,$4,'user','opportunity.business_stage.transitioned','opportunity',c.id,'success',$9,jsonb_build_object('businessStage',c.previous_business_stage,'version',$6),jsonb_build_object('businessStage',c.business_stage,'version',c.version),$15,$15,$10 FROM lifecycle l,changed c RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $12,$1,$2,$3,$11,'opportunity.transition',$10,200,jsonb_build_object('opportunityId',c.id,'businessStage',c.business_stage,'managementStatus',c.management_status,'outcomeStatus',c.outcome_status,'fulfillmentStatus',c.fulfillment_status,'version',c.version,'lifecycleEventId',$13,'auditEventId',$14),1,now(),now()+interval '24 hours',$4,$4 FROM changed c,audit RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* ,NULL::text "currentStage" FROM completed UNION ALL
SELECT 'replay',"requestHash","responseBody",NULL::text FROM prior UNION ALL
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM present) THEN 'not_found' WHEN (SELECT version FROM present)<>$6 THEN 'version_conflict' ELSE 'invalid_transition' END,$10,NULL::jsonb,(SELECT business_stage FROM present) WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [input.organizationId, input.workspaceId, input.websiteProjectId,
        input.actorId, input.opportunityId, input.expectedVersion,
        input.toBusinessStage, input.allowedFromStages, input.reason, input.requestHash,
        input.idempotencyKey, input.idempotencyRecordId, input.lifecycleEventId,
        input.auditEventId, input.requestId];
      return (await client.query(sql, values)).rows[0] as OpportunityTransitionRow;
    },
    async patchManagement(input) {
      const sql = `WITH guard AS (SELECT
pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$10||':opportunity.management.patch',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$10 AND command_type='opportunity.management.patch') i),
present AS (SELECT o.* FROM guard,backlink_opportunities o WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)=($1,$2,$3,$5) AND NOT EXISTS (SELECT 1 FROM prior) FOR UPDATE OF o),
changed AS (UPDATE backlink_opportunities o SET management_status=$7,version=o.version+1,updated_at=now(),updated_by=$4 FROM present p WHERE o.id=p.id AND p.version=$6 AND p.management_status<>$7 RETURNING o.*,p.management_status previous_management_status),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,before_state,after_state,reason,correlation_id,idempotency_key) SELECT $12,$1,$2,$3,'opportunity',c.id,c.version,c.version,'opportunity.management_status.changed','user',$4,jsonb_build_object('businessStage',c.business_stage,'managementStatus',c.previous_management_status,'outcomeStatus',c.outcome_status,'fulfillmentStatus',c.fulfillment_status,'version',$6),jsonb_build_object('businessStage',c.business_stage,'managementStatus',c.management_status,'outcomeStatus',c.outcome_status,'fulfillmentStatus',c.fulfillment_status,'version',c.version),$8,$14,'opportunity.management.patch:'||$10 FROM changed c RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,reason,before_redacted,after_redacted,request_id,correlation_id,integrity_hash) SELECT $13,$1,$2,$3,l.id,$4,'user','opportunity.management_status.changed','opportunity',c.id,'success',$8,jsonb_build_object('managementStatus',c.previous_management_status,'version',$6),jsonb_build_object('managementStatus',c.management_status,'version',c.version),$14,$14,$9 FROM lifecycle l,changed c RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $11,$1,$2,$3,$10,'opportunity.management.patch',$9,200,jsonb_build_object('opportunityId',c.id,'businessStage',c.business_stage,'managementStatus',c.management_status,'outcomeStatus',c.outcome_status,'fulfillmentStatus',c.fulfillment_status,'version',c.version,'lifecycleEventId',$12,'auditEventId',$13),1,now(),now()+interval '24 hours',$4,$4 FROM changed c,audit RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL
SELECT 'replay',"requestHash","responseBody" FROM prior UNION ALL
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM present) THEN 'not_found' WHEN (SELECT version FROM present)<>$6 THEN 'version_conflict' ELSE 'unchanged' END,$9,NULL::jsonb WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [input.organizationId, input.workspaceId, input.websiteProjectId,
        input.actorId, input.opportunityId, input.expectedVersion,
        input.managementStatus, input.reason, input.requestHash, input.idempotencyKey,
        input.idempotencyRecordId, input.lifecycleEventId, input.auditEventId,
        input.requestId];
      return (await client.query(sql, values)).rows[0] as OpportunityManagementPatchRow;
    },
  });
}
import type { OpportunityBusinessStage, OpportunityFulfillmentStatus,
  OpportunityManagementStatus, OpportunityOutcomeStatus
} from "../../domain/opportunities/opportunity-state.js";
