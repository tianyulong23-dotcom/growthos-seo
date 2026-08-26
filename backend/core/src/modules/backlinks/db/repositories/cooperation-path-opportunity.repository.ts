import type {
  ManualActionState,
  NonEmailCooperationPathType,
} from "../../domain/opportunities/cooperation-path.js";

export type CooperationPathOpportunityCreation = Readonly<{
  opportunityId: string;
  recommendationId: string;
  cycleId: string;
  websiteProjectId: string;
  targetSiteKey: string;
  targetHostAscii: string;
  cooperationPathFactId: string;
  manualActionId: string;
  pathType: NonEmailCooperationPathType;
  pathUrl: string;
  contentType: "FORM_MESSAGE" | "SUBMISSION_PITCH";
  editableContent: string;
  manualActionState: "READY_FOR_MANUAL_ACTION";
  nextAction: string;
  manualActionVersion: number;
  joinSequence: number;
  businessStage: "JOINED";
  managementStatus: "ACTIVE";
  outcomeStatus: "OPEN";
  fulfillmentStatus: "NOT_EXPECTED";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
}>;

export type CooperationPathOpportunityCreationRow = Readonly<{
  state: "completed" | "replay" | "not_found" | "version_conflict"
    | "path_required" | "duplicate";
  requestHash: string;
  responseBody?: CooperationPathOpportunityCreation;
}>;

export type ManualActionMutation = Readonly<{
  opportunityId: string;
  manualActionId: string;
  manualActionState: ManualActionState;
  editableContent: string;
  nextAction: string;
  manualActionVersion: number;
  lifecycleEventId: string;
  auditEventId: string;
}>;

export type ManualActionMutationRow = Readonly<{
  state: "completed" | "replay" | "not_found" | "version_conflict"
    | "invalid_transition" | "unchanged";
  requestHash: string;
  responseBody?: ManualActionMutation;
  currentState?: string;
}>;

type CreateInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  recommendationId: string;
  cooperationPathFactId: string;
  expectedVersion: number;
  editableContent: string;
  nextAction: string;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
  idempotencyRecordId: string;
  opportunityId: string;
  cycleId: string;
  manualActionId: string;
  manualActionEventId: string;
  lifecycleEventId: string;
  auditEventId: string;
}>;

type PatchContentInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  opportunityId: string;
  expectedVersion: number;
  editableContent: string;
  nextAction: string;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
  idempotencyRecordId: string;
  lifecycleEventId: string;
  auditEventId: string;
}>;

type TransitionInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  opportunityId: string;
  expectedVersion: number;
  toState: ManualActionState;
  allowedFromStates: readonly ManualActionState[];
  nextAction: string;
  evidence: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
  idempotencyRecordId: string;
  manualActionEventId: string;
  lifecycleEventId: string;
  auditEventId: string;
}>;

type Client = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type CooperationPathOpportunityRepository = Readonly<{
  createFromVerifiedPath(
    input: CreateInput,
  ): Promise<CooperationPathOpportunityCreationRow>;
  patchManualContent(input: PatchContentInput): Promise<ManualActionMutationRow>;
  transitionManualAction(input: TransitionInput): Promise<ManualActionMutationRow>;
}>;

export function createCooperationPathOpportunityRepository(
  client: Client,
): CooperationPathOpportunityRepository {
  return Object.freeze({
    async createFromVerifiedPath(input) {
      const sql = `WITH guard AS (
  SELECT pg_advisory_xact_lock(
    hashtextextended(
      $2::uuid::text||':'||$10||':opportunity.cooperation_path.create',0
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
         AND idempotency_key=$10
         AND command_type='opportunity.cooperation_path.create'
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
    FROM present
   WHERE version=$7
     AND status IN ('ready','shown')
),
source AS (
  SELECT i.id inventory_id,i.recommendation_id,i.prospect_id,
         i.recommendation_context_version_id,p.hostname_ascii,
         p.registrable_domain,p.normalization_version,
         f.id cooperation_path_fact_id,f.path_type,
         CASE WHEN f.path_type='contact_form'
           THEN 'FORM_MESSAGE' ELSE 'SUBMISSION_PITCH' END content_type,
         COALESCE(
           NULLIF(btrim(f.evidence->>'url'),''),
           NULLIF(btrim(f.evidence->>'pathUrl'),''),
           NULLIF(btrim(f.evidence->>'sourceUrl'),'')
         ) path_url,
         f.evidence
    FROM versioned i
    JOIN backlink_prospects p ON
      (p.organization_id,p.workspace_id,p.website_project_id,p.id,
       p.recommendation_context_version_id)=
      (i.organization_id,i.workspace_id,i.website_project_id,i.prospect_id,
       i.recommendation_context_version_id)
    JOIN backlink_recommendation_cooperation_path_facts f ON
      (f.organization_id,f.workspace_id,f.website_project_id,f.id,
       f.recommendation_id,f.prospect_id,
       f.recommendation_context_version_id)=
      (i.organization_id,i.workspace_id,i.website_project_id,$6,
       i.recommendation_id,i.prospect_id,
       i.recommendation_context_version_id)
   WHERE f.decision='verified'
     AND f.path_type IN (
       'contact_form','guest_post_submission',
       'resource_submission','editor_author_page'
     )
     AND COALESCE(
       NULLIF(btrim(f.evidence->>'url'),''),
       NULLIF(btrim(f.evidence->>'pathUrl'),''),
       NULLIF(btrim(f.evidence->>'sourceUrl'),'')
     ) ~ '^https?://[^[:space:]]+$'
     AND COALESCE(
       NULLIF(btrim(f.evidence->>'url'),''),
       NULLIF(btrim(f.evidence->>'pathUrl'),''),
       NULLIF(btrim(f.evidence->>'sourceUrl'),'')
     ) !~ '^https?://[^/]*@'
     AND (
       SELECT q.decision
         FROM backlink_recommendation_qualification_facts q
        WHERE (q.organization_id,q.workspace_id,q.website_project_id,
               q.generation_contract_id,
               q.recommendation_context_version_id,
               q.recommendation_id,q.prospect_id)=
              (f.organization_id,f.workspace_id,f.website_project_id,
               f.generation_contract_id,
               f.recommendation_context_version_id,
               f.recommendation_id,f.prospect_id)
        ORDER BY q.attempt DESC,q.observed_at DESC,q.id DESC
        LIMIT 1
     )='eligible'
     AND (
       SELECT v.decision
         FROM backlink_recommendation_visibility_facts v
         JOIN backlink_recommendation_qualification_facts q ON
           (q.organization_id,q.workspace_id,q.website_project_id,q.id)=
           (v.organization_id,v.workspace_id,v.website_project_id,
            v.qualification_fact_id)
        WHERE (v.organization_id,v.workspace_id,v.website_project_id,
               v.generation_contract_id,
               v.recommendation_context_version_id,
               v.recommendation_id,v.prospect_id)=
              (f.organization_id,f.workspace_id,f.website_project_id,
               f.generation_contract_id,
               f.recommendation_context_version_id,
               f.recommendation_id,f.prospect_id)
          AND v.qualification_fact_id=(
            SELECT q2.id
              FROM backlink_recommendation_qualification_facts q2
             WHERE (q2.organization_id,q2.workspace_id,q2.website_project_id,
                    q2.generation_contract_id,
                    q2.recommendation_context_version_id,
                    q2.recommendation_id,q2.prospect_id)=
                   (f.organization_id,f.workspace_id,f.website_project_id,
                    f.generation_contract_id,
                    f.recommendation_context_version_id,
                    f.recommendation_id,f.prospect_id)
             ORDER BY q2.attempt DESC,q2.observed_at DESC,q2.id DESC
             LIMIT 1
          )
        ORDER BY v.attempt DESC,v.observed_at DESC,v.id DESC
        LIMIT 1
     )='visible'
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
  SELECT backlink_allocate_opportunity_join_sequence($1,$2,$3,$4) join_sequence
    FROM source
   WHERE NOT EXISTS (SELECT 1 FROM existing)
),
created AS (
  INSERT INTO backlink_opportunities (
    id,organization_id,workspace_id,website_project_id,recommendation_id,
    prospect_id,recommendation_context_version_id,
    source_contact_candidate_id,contact_review_required,
    engagement_channel,source_cooperation_path_fact_id,
    target_site_key,target_host_ascii,target_identity_rule_version,
    join_sequence,created_by,updated_by
  )
  SELECT $13,$1,$2,$3,s.recommendation_id,s.prospect_id,
         s.recommendation_context_version_id,NULL,false,
         'COOPERATION_PATH',s.cooperation_path_fact_id,
         s.registrable_domain,s.hostname_ascii,s.normalization_version,
         n.join_sequence,$4,$4
    FROM source s,next_sequence n
  ON CONFLICT (website_project_id,target_site_key) DO NOTHING
  RETURNING *
),
manual_action AS (
  INSERT INTO backlink_opportunity_manual_actions (
    id,organization_id,workspace_id,website_project_id,opportunity_id,
    cooperation_path_fact_id,path_type,path_url,content_type,
    editable_content,state,next_action,evidence,created_by,updated_by
  )
  SELECT $15,$1,$2,$3,c.id,s.cooperation_path_fact_id,s.path_type,
         s.path_url,s.content_type,$8,'READY_FOR_MANUAL_ACTION',$9,
         s.evidence,$4,$4
    FROM source s,created c
  RETURNING *
),
manual_event AS (
  INSERT INTO backlink_opportunity_manual_action_events (
    id,organization_id,workspace_id,website_project_id,manual_action_id,
    opportunity_id,from_state,to_state,actor_id,path_url,evidence,
    next_action,idempotency_key
  )
  SELECT $16,$1,$2,$3,m.id,m.opportunity_id,NULL,m.state,$4,m.path_url,
         m.evidence,m.next_action,$10
    FROM manual_action m
  RETURNING id
),
cycle AS (
  INSERT INTO backlink_opportunity_cycles (
    id,organization_id,workspace_id,website_project_id,opportunity_id,
    cycle_number,started_at,created_by,updated_by
  )
  SELECT $14,$1,$2,$3,id,1,now(),$4,$4
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
  SELECT $17,$1,$2,$3,'opportunity',c.id,1,c.version,
         'opportunity.cooperation_path.created','user',$4,
         jsonb_build_object(
           'businessStage',c.business_stage,
           'engagementChannel',c.engagement_channel,
           'cooperationPathFactId',c.source_cooperation_path_fact_id,
           'manualActionId',m.id,
           'manualActionState',m.state,
           'pathType',m.path_type,
           'pathUrl',m.path_url,
           'contentType',m.content_type
         ),
         'verified_non_email_cooperation_path',$12,
         'opportunity.cooperation_path.create:'||$10
    FROM created c,manual_action m,recommendation,manual_event
  RETURNING id
),
audit AS (
  INSERT INTO backlink_audit_events (
    id,organization_id,workspace_id,website_project_id,lifecycle_event_id,
    actor_id,actor_kind,action,target_type,target_id,outcome,reason,
    after_redacted,request_id,correlation_id,integrity_hash
  )
  SELECT $18,$1,$2,$3,l.id,$4,'user',
         'opportunity.cooperation_path.created','opportunity',c.id,'success',
         'verified_non_email_cooperation_path',
         jsonb_build_object(
           'recommendationId',c.recommendation_id,
           'engagementChannel',c.engagement_channel,
           'cooperationPathFactId',c.source_cooperation_path_fact_id,
           'manualActionId',m.id,
           'manualActionState',m.state,
           'pathType',m.path_type,
           'pathUrl',m.path_url
         ),
         $12,$12,$11
    FROM lifecycle l,created c,manual_action m
  RETURNING id
),
completed AS (
  INSERT INTO backlink_idempotency_records (
    id,organization_id,workspace_id,website_project_id,idempotency_key,
    command_type,request_hash,response_status,response_body,
    response_schema_version,completed_at,expires_at,created_by,updated_by
  )
  SELECT $19,$1,$2,$3,$10,'opportunity.cooperation_path.create',$11,201,
         jsonb_build_object(
           'opportunityId',c.id,
           'recommendationId',c.recommendation_id,
           'cycleId',$14,
           'websiteProjectId',c.website_project_id,
           'targetSiteKey',c.target_site_key,
           'targetHostAscii',c.target_host_ascii,
           'cooperationPathFactId',c.source_cooperation_path_fact_id,
           'manualActionId',m.id,
           'pathType',m.path_type,
           'pathUrl',m.path_url,
           'contentType',m.content_type,
           'editableContent',m.editable_content,
           'manualActionState',m.state,
           'nextAction',m.next_action,
           'manualActionVersion',m.version,
           'joinSequence',c.join_sequence,
           'businessStage',c.business_stage,
           'managementStatus',c.management_status,
           'outcomeStatus',c.outcome_status,
           'fulfillmentStatus',c.fulfillment_status,
           'version',c.version,
           'lifecycleEventId',$17,
           'auditEventId',$18
         ),
         1,now(),now()+interval '24 hours',$4,$4
    FROM created c,manual_action m,audit
  RETURNING request_hash "requestHash",response_body "responseBody"
)
SELECT 'completed' state,* FROM completed
UNION ALL
SELECT 'replay',"requestHash","responseBody" FROM prior
UNION ALL
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM present) THEN 'not_found'
         WHEN NOT EXISTS (SELECT 1 FROM versioned) THEN 'version_conflict'
         WHEN NOT EXISTS (SELECT 1 FROM source) THEN 'path_required'
         ELSE 'duplicate'
       END,
       $11,NULL::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM completed)
   AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.actorId,
        input.recommendationId,
        input.cooperationPathFactId,
        input.expectedVersion,
        input.editableContent,
        input.nextAction,
        input.idempotencyKey,
        input.requestHash,
        input.requestId,
        input.opportunityId,
        input.cycleId,
        input.manualActionId,
        input.manualActionEventId,
        input.lifecycleEventId,
        input.auditEventId,
        input.idempotencyRecordId,
      ];
      return (await client.query(sql, values)).rows[0] as
        CooperationPathOpportunityCreationRow;
    },

    async patchManualContent(input) {
      const sql = `WITH guard AS (
  SELECT pg_advisory_xact_lock(
    hashtextextended(
      $2::uuid::text||':'||$9||':opportunity.manual_content.patch',0
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
         AND idempotency_key=$9
         AND command_type='opportunity.manual_content.patch'
    ) i
),
present AS (
  SELECT m.*
    FROM guard,backlink_opportunity_manual_actions m
    JOIN backlink_opportunities o ON
      (o.organization_id,o.workspace_id,o.website_project_id,o.id)=
      (m.organization_id,m.workspace_id,m.website_project_id,m.opportunity_id)
   WHERE (m.organization_id,m.workspace_id,m.website_project_id,
          m.opportunity_id)=($1,$2,$3,$5)
     AND o.engagement_channel='COOPERATION_PATH'
     AND NOT EXISTS (SELECT 1 FROM prior)
   FOR UPDATE OF m
),
changed AS (
  UPDATE backlink_opportunity_manual_actions m
     SET editable_content=$7,next_action=$8,version=m.version+1,
         updated_at=now(),updated_by=$4
    FROM present p
   WHERE m.id=p.id
     AND p.version=$6
     AND (p.editable_content<>$7 OR p.next_action<>$8)
  RETURNING m.*,p.editable_content previous_content,p.next_action previous_next_action
),
lifecycle AS (
  INSERT INTO backlink_lifecycle_events (
    id,organization_id,workspace_id,website_project_id,aggregate_type,
    aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,
    before_state,after_state,reason,correlation_id,idempotency_key
  )
  SELECT $12,$1,$2,$3,'opportunity_manual_action',c.id,c.version,c.version,
         'opportunity.manual_content.updated','user',$4,
         jsonb_build_object(
           'editableContent',c.previous_content,
           'nextAction',c.previous_next_action,
           'version',$6
         ),
         jsonb_build_object(
           'editableContent',c.editable_content,
           'nextAction',c.next_action,
           'version',c.version
         ),
         'operator_edited_manual_content',$11,
         'opportunity.manual_content.patch:'||$9
    FROM changed c
  RETURNING id
),
audit AS (
  INSERT INTO backlink_audit_events (
    id,organization_id,workspace_id,website_project_id,lifecycle_event_id,
    actor_id,actor_kind,action,target_type,target_id,outcome,reason,
    before_redacted,after_redacted,request_id,correlation_id,integrity_hash
  )
  SELECT $13,$1,$2,$3,l.id,$4,'user',
         'opportunity.manual_content.updated','opportunity_manual_action',
         c.id,'success','operator_edited_manual_content',
         jsonb_build_object('version',$6),
         jsonb_build_object('state',c.state,'version',c.version),
         $11,$11,$10
    FROM lifecycle l,changed c
  RETURNING id
),
completed AS (
  INSERT INTO backlink_idempotency_records (
    id,organization_id,workspace_id,website_project_id,idempotency_key,
    command_type,request_hash,response_status,response_body,
    response_schema_version,completed_at,expires_at,created_by,updated_by
  )
  SELECT $14,$1,$2,$3,$9,'opportunity.manual_content.patch',$10,200,
         jsonb_build_object(
           'opportunityId',c.opportunity_id,
           'manualActionId',c.id,
           'manualActionState',c.state,
           'editableContent',c.editable_content,
           'nextAction',c.next_action,
           'manualActionVersion',c.version,
           'lifecycleEventId',$12,
           'auditEventId',$13
         ),
         1,now(),now()+interval '24 hours',$4,$4
    FROM changed c,audit
  RETURNING request_hash "requestHash",response_body "responseBody"
)
SELECT 'completed' state,* ,NULL::text "currentState" FROM completed
UNION ALL
SELECT 'replay',"requestHash","responseBody",NULL::text FROM prior
UNION ALL
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM present) THEN 'not_found'
         WHEN (SELECT version FROM present)<>$6 THEN 'version_conflict'
         ELSE 'unchanged'
       END,
       $10,NULL::jsonb,(SELECT state FROM present)
 WHERE NOT EXISTS (SELECT 1 FROM completed)
   AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.actorId,
        input.opportunityId,
        input.expectedVersion,
        input.editableContent,
        input.nextAction,
        input.idempotencyKey,
        input.requestHash,
        input.requestId,
        input.lifecycleEventId,
        input.auditEventId,
        input.idempotencyRecordId,
      ];
      return (await client.query(sql, values)).rows[0] as ManualActionMutationRow;
    },

    async transitionManualAction(input) {
      const sql = `WITH guard AS (
  SELECT pg_advisory_xact_lock(
    hashtextextended(
      $2::uuid::text||':'||$11||':opportunity.manual_action.transition',0
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
         AND idempotency_key=$11
         AND command_type='opportunity.manual_action.transition'
    ) i
),
present AS (
  SELECT m.*
    FROM guard,backlink_opportunity_manual_actions m
    JOIN backlink_opportunities o ON
      (o.organization_id,o.workspace_id,o.website_project_id,o.id)=
      (m.organization_id,m.workspace_id,m.website_project_id,m.opportunity_id)
   WHERE (m.organization_id,m.workspace_id,m.website_project_id,
          m.opportunity_id)=($1,$2,$3,$5)
     AND o.engagement_channel='COOPERATION_PATH'
     AND NOT EXISTS (SELECT 1 FROM prior)
   FOR UPDATE OF m
),
changed AS (
  UPDATE backlink_opportunity_manual_actions m
     SET state=$7,next_action=$9,evidence=m.evidence||$10::jsonb,
         version=m.version+1,updated_at=now(),updated_by=$4
    FROM present p
   WHERE m.id=p.id
     AND p.version=$6
     AND p.state=ANY($8::text[])
  RETURNING m.*,p.state previous_state
),
manual_event AS (
  INSERT INTO backlink_opportunity_manual_action_events (
    id,organization_id,workspace_id,website_project_id,manual_action_id,
    opportunity_id,from_state,to_state,actor_id,path_url,evidence,
    next_action,idempotency_key
  )
  SELECT $15,$1,$2,$3,c.id,c.opportunity_id,c.previous_state,c.state,$4,
         c.path_url,$10::jsonb,c.next_action,$11
    FROM changed c
  RETURNING id
),
lifecycle AS (
  INSERT INTO backlink_lifecycle_events (
    id,organization_id,workspace_id,website_project_id,aggregate_type,
    aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,
    before_state,after_state,reason,correlation_id,idempotency_key
  )
  SELECT $16,$1,$2,$3,'opportunity_manual_action',c.id,c.version,c.version,
         'opportunity.manual_action.transitioned','user',$4,
         jsonb_build_object(
           'state',c.previous_state,'nextAction',c.next_action,'version',$6
         ),
         jsonb_build_object(
           'state',c.state,'nextAction',c.next_action,'version',c.version,
           'pathUrl',c.path_url,'evidence',$10::jsonb
         ),
         'operator_confirmed_manual_transition',$14,
         'opportunity.manual_action.transition:'||$11
    FROM changed c,manual_event
  RETURNING id
),
audit AS (
  INSERT INTO backlink_audit_events (
    id,organization_id,workspace_id,website_project_id,lifecycle_event_id,
    actor_id,actor_kind,action,target_type,target_id,outcome,reason,
    before_redacted,after_redacted,request_id,correlation_id,integrity_hash
  )
  SELECT $17,$1,$2,$3,l.id,$4,'user',
         'opportunity.manual_action.transitioned','opportunity_manual_action',
         c.id,'success','operator_confirmed_manual_transition',
         jsonb_build_object('state',c.previous_state,'version',$6),
         jsonb_build_object('state',c.state,'version',c.version),
         $14,$14,$12
    FROM lifecycle l,changed c
  RETURNING id
),
completed AS (
  INSERT INTO backlink_idempotency_records (
    id,organization_id,workspace_id,website_project_id,idempotency_key,
    command_type,request_hash,response_status,response_body,
    response_schema_version,completed_at,expires_at,created_by,updated_by
  )
  SELECT $13,$1,$2,$3,$11,'opportunity.manual_action.transition',$12,200,
         jsonb_build_object(
           'opportunityId',c.opportunity_id,
           'manualActionId',c.id,
           'manualActionState',c.state,
           'editableContent',c.editable_content,
           'nextAction',c.next_action,
           'manualActionVersion',c.version,
           'lifecycleEventId',$16,
           'auditEventId',$17
         ),
         1,now(),now()+interval '24 hours',$4,$4
    FROM changed c,audit
  RETURNING request_hash "requestHash",response_body "responseBody"
)
SELECT 'completed' state,* ,NULL::text "currentState" FROM completed
UNION ALL
SELECT 'replay',"requestHash","responseBody",NULL::text FROM prior
UNION ALL
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM present) THEN 'not_found'
         WHEN (SELECT version FROM present)<>$6 THEN 'version_conflict'
         ELSE 'invalid_transition'
       END,
       $12,NULL::jsonb,(SELECT state FROM present)
 WHERE NOT EXISTS (SELECT 1 FROM completed)
   AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.actorId,
        input.opportunityId,
        input.expectedVersion,
        input.toState,
        input.allowedFromStates,
        input.nextAction,
        JSON.stringify(input.evidence),
        input.idempotencyKey,
        input.requestHash,
        input.idempotencyRecordId,
        input.requestId,
        input.manualActionEventId,
        input.lifecycleEventId,
        input.auditEventId,
      ];
      return (await client.query(sql, values)).rows[0] as ManualActionMutationRow;
    },
  });
}
