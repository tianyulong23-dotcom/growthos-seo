import { createHash, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
export type ContactCommandClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
export type ContactCandidate = Readonly<{
  id: string;
  prospectId: string;
  recommendationContextVersionId: string;
  normalizedEmail: string;
  domainRelation: "same_registrable_domain" | "external_domain" | "unknown";
  confidence: number;
  observedRole: string | null;
  inferredPurpose:
    | "press"
    | "editorial"
    | "partnerships"
    | "advertising"
    | "support"
    | "business"
    | "marketing"
    | "site_owner"
    | "general"
    | "unknown";
  purposeConfidence: number;
  purposeRuleVersion: string;
  purposeEvidence: Readonly<{
    tier: string;
    field: string;
    value: string;
    matchedToken: string;
    ruleId: string;
  }>[];
  guessed: boolean;
  status: "candidate";
  version: number;
  evidence: {
    sourceUrl: string;
    observedAt: string;
    method: string;
    snippet: string;
    extractionMethod: string;
    evidenceSnippet: string;
    confidence: number;
    expiresAt: string;
    ruleVersion: string;
    contentHash: string;
    domainRelation:
      | "same_registrable_domain"
      | "external_domain"
      | "unknown";
  }[];
}>;
export type ConfirmContactInput = Readonly<{
  context: ResolvedProjectContext;
  requestId: string;
  candidateId: string;
  expectedVersion: number;
  contactRole: string;
  reason: string;
}>;
export type CreateManualContactCandidateInput = Readonly<{
  context: ResolvedProjectContext;
  requestId: string;
  opportunityId: string;
  normalizedEmail: string;
  contactRole:
    | "press"
    | "editorial"
    | "partnerships"
    | "advertising"
    | "support"
    | "general";
  reason: string;
  idempotencyKey: string;
}>;
export type CreateManualContactCandidateResult = Readonly<{
  candidateId: string;
  prospectId: string;
  recommendationContextVersionId: string;
  normalizedEmail: string;
  contactRole: CreateManualContactCandidateInput["contactRole"];
  status: "candidate";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
  replayed: boolean;
}>;
export type ConfirmContactResult = Readonly<{
  candidateId: string;
  contactId: string;
  candidateStatus: "promoted";
  candidateVersion: number;
  contactStatus: "active";
  contactVersion: number;
  lifecycleEventId: string;
  auditEventId: string;
}>;
export type OpportunityContact = Readonly<{
  id: string;
  opportunityId: string;
  prospectId: string;
  normalizedEmail: string;
  contactRole: string;
  confirmedAt: string;
  status: "active";
  guessed: false;
  version: number;
}>;
export type OpportunityContactSelection = Readonly<{
  items: readonly OpportunityContact[];
  state:
    | "CONTACT_CONFIRMATION_REQUIRED"
    | "AUTO_SELECTED"
    | "USER_SELECTION_REQUIRED";
  autoSelectedContactId: string | null;
}>;
type StateRow = Record<string, unknown> & { state?: string };
type ManualCandidateRow = StateRow & {
  requestHash?: string;
  responseBody?: Omit<CreateManualContactCandidateResult, "replayed">;
};
const failure = (
  code: typeof backlinkErrorCodes.notFound | typeof backlinkErrorCodes.conflict,
  message: string,
) => new BacklinkError({ code, message });
const ignoredMailbox = /^(?:no-?reply|do-?not-?reply|noreply)$/iu;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role),
    )
  )
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Contact confirmation permission is required.",
    });
}
export function createContactCommands(client: ContactCommandClient) {
  return {
    async listCandidates(
      context: ResolvedProjectContext,
      prospectId: string,
      limit: number,
    ): Promise<ContactCandidate[]> {
      const { tenant, project } = context;
      const result = await client.query(
        `SELECT c.id,c.prospect_id "prospectId",
c.recommendation_context_version_id "recommendationContextVersionId",c.normalized_email "normalizedEmail",
c.domain_relation "domainRelation",c.confidence,c.observed_role "observedRole",
c.inferred_purpose "inferredPurpose",c.purpose_confidence "purposeConfidence",
c.purpose_rule_version "purposeRuleVersion",c.purpose_evidence "purposeEvidence",
c.guessed,c.status,c.version,COALESCE((SELECT
jsonb_agg(jsonb_build_object('sourceUrl',e.source_url,'observedAt',e.observed_at,
'method',e.extraction_method,'snippet',e.evidence_snippet,'extractionMethod',
e.extraction_method,'evidenceSnippet',e.evidence_snippet,'confidence',e.confidence,
'expiresAt',e.expires_at,'ruleVersion',e.rule_version,'contentHash',e.content_sha256,
'domainRelation',e.domain_relation) ORDER BY e.confidence DESC,e.source_url)
FROM backlink_contact_evidence e WHERE
(e.organization_id,e.workspace_id,e.website_project_id,e.candidate_id)=(c.organization_id,
c.workspace_id,c.website_project_id,c.id) AND e.invalidated_at IS NULL),'[]') evidence
FROM backlink_contact_candidates c WHERE (c.organization_id,c.workspace_id,c.website_project_id)=
($1,$2,$3) AND c.prospect_id=$4 AND c.status='candidate' AND c.invalidated_at IS NULL
ORDER BY c.confidence DESC,c.normalized_email,c.id LIMIT $5`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          prospectId,
          limit,
        ],
      );
      return result.rows as unknown as ContactCandidate[];
    },
    async listOpportunityContacts(
      context: ResolvedProjectContext,
      opportunityId: string,
    ): Promise<OpportunityContactSelection> {
      const { tenant, project } = context;
      const result = await client.query(
        `WITH target_opportunity AS (
  SELECT o.id,o.prospect_id,o.recommendation_context_version_id
  FROM backlink_opportunities o
  WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)=($1,$2,$3,$4)
), eligible_contacts AS (
  SELECT c.id,o.id "opportunityId",c.prospect_id "prospectId",
    c.normalized_email "normalizedEmail",c.contact_role "contactRole",
    c.confirmed_at "confirmedAt",c.status,c.guessed,c.version
  FROM target_opportunity o
  JOIN backlink_contacts c ON
    (c.organization_id,c.workspace_id,c.website_project_id,c.prospect_id,
      c.recommendation_context_version_id)=
    ($1,$2,$3,o.prospect_id,o.recommendation_context_version_id)
  WHERE c.status='active' AND c.guessed=false AND c.invalidated_at IS NULL
)
SELECT EXISTS(SELECT 1 FROM target_opportunity) "opportunityExists",
  COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c."normalizedEmail",c.id)
    FILTER (WHERE c.id IS NOT NULL),'[]'::jsonb) items
FROM eligible_contacts c`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          opportunityId,
        ],
      );
      const row = result.rows[0];
      if (row?.opportunityExists !== true) {
        throw failure(
          backlinkErrorCodes.notFound,
          "Opportunity was not found in this project.",
        );
      }
      const rawItems = Array.isArray(row.items) ? row.items : [];
      const items = rawItems.map((item) => {
        const contact = item as Record<string, unknown>;
        const confirmedAt =
          contact.confirmedAt instanceof Date
            ? contact.confirmedAt
            : new Date(String(contact.confirmedAt));
        return {
          id: String(contact.id),
          opportunityId: String(contact.opportunityId),
          prospectId: String(contact.prospectId),
          normalizedEmail: String(contact.normalizedEmail),
          contactRole: String(contact.contactRole),
          confirmedAt: confirmedAt.toISOString(),
          status: "active" as const,
          guessed: false as const,
          version: Number(contact.version),
        };
      });
      return {
        items,
        state:
          items.length === 0
            ? "CONTACT_CONFIRMATION_REQUIRED"
            : items.length === 1
              ? "AUTO_SELECTED"
              : "USER_SELECTION_REQUIRED",
        autoSelectedContactId:
          items.length === 1 ? (items[0]?.id ?? null) : null,
      };
    },
    async createManualCandidate(
      input: CreateManualContactCandidateInput,
    ): Promise<CreateManualContactCandidateResult> {
      authorize(input.context);
      const normalizedEmail = input.normalizedEmail.trim().toLowerCase();
      const separator = normalizedEmail.lastIndexOf("@");
      const localPart = normalizedEmail.slice(0, separator);
      const emailDomainAscii = domainToASCII(
        normalizedEmail.slice(separator + 1),
      ).toLowerCase();
      if (
        separator <= 0 ||
        emailDomainAscii.length === 0 ||
        ignoredMailbox.test(localPart)
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "A valid confirmed contact email is required.",
        });
      }
      const requestHash = digest({
        opportunityId: input.opportunityId,
        normalizedEmail,
        contactRole: input.contactRole,
        reason: input.reason,
      });
      const evidenceHash = digest({
        source: "manual",
        opportunityId: input.opportunityId,
        normalizedEmail,
        actorId: input.context.actor.userId,
      });
      const { tenant, project, actor } = input.context;
      const ids = Array.from({ length: 5 }, () => randomUUID());
      const sql = `WITH guard AS (SELECT
pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$10||':contact.candidate.create',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard
CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2
AND idempotency_key=$10 AND command_type='contact.candidate.create') i),
source AS (SELECT o.prospect_id,p.recommendation_context_version_id,p.hostname_ascii,
p.registrable_domain FROM guard,backlink_opportunities o JOIN backlink_prospects p ON
(p.organization_id,p.workspace_id,p.website_project_id,p.id,p.recommendation_context_version_id)=
(o.organization_id,o.workspace_id,o.website_project_id,o.prospect_id,
o.recommendation_context_version_id) WHERE
(o.organization_id,o.workspace_id,o.website_project_id,o.id)=($1,$2,$3,$5)
AND NOT EXISTS (SELECT 1 FROM prior)),
duplicate AS (SELECT c.* FROM source s JOIN backlink_contact_candidates c ON
(c.organization_id,c.workspace_id,c.website_project_id,c.prospect_id,
c.recommendation_context_version_id,c.normalized_email)=
($1,$2,$3,s.prospect_id,s.recommendation_context_version_id,$6)),
reusable AS (SELECT d.*,l.id lifecycle_event_id,a.id audit_event_id FROM duplicate d
JOIN LATERAL (SELECT id FROM backlink_lifecycle_events WHERE organization_id=$1
AND workspace_id=$2 AND website_project_id=$3 AND aggregate_type='contact_candidate'
AND aggregate_id=d.id AND event_type='contact_candidate.created' LIMIT 1) l ON true
JOIN LATERAL (SELECT id FROM backlink_audit_events WHERE organization_id=$1
AND workspace_id=$2 AND website_project_id=$3 AND lifecycle_event_id=l.id
AND action='contact_candidate.created' LIMIT 1) a ON true
WHERE d.status='candidate' AND d.guessed=false AND d.invalidated_at IS NULL
AND d.inferred_purpose=$8),
created AS (INSERT INTO backlink_contact_candidates (id,organization_id,workspace_id,
website_project_id,prospect_id,recommendation_context_version_id,normalized_email,
email_domain_ascii,domain_relation,syntax_validator_version,confidence,guessed,status,
observed_role,inferred_purpose,purpose_confidence,purpose_rule_version,purpose_evidence,
created_by,updated_by) SELECT $13,$1,$2,$3,s.prospect_id,s.recommendation_context_version_id,
$6,$7,CASE WHEN $7=s.registrable_domain OR $7 LIKE '%.'||s.registrable_domain
THEN 'same_registrable_domain' ELSE 'external_domain' END,'manual-email.v1',100,false,
'candidate',$8,$8,100,'manual-contact-purpose.v1',jsonb_build_array(jsonb_build_object(
'tier','manual','field','manual_entry','value',$8,'matchedToken',$8,
'ruleId','manual.contact-purpose')),$4,$4 FROM source s
WHERE NOT EXISTS (SELECT 1 FROM duplicate) RETURNING *),
evidence AS (INSERT INTO backlink_contact_evidence (id,organization_id,workspace_id,
website_project_id,candidate_id,source_url,observed_at,extraction_method,evidence_snippet,
parser_version,content_sha256,confidence,expires_at,created_by) SELECT $14,$1,$2,$3,c.id,
'https://'||s.hostname_ascii||'/',now(),'manual',
'Manually entered for explicit contact confirmation.','manual-contact-entry.v1',$18,100,
now()+interval '365 days',$4 FROM created c,source s RETURNING id),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,
website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
actor_type,actor_id,after_state,reason,correlation_id,idempotency_key) SELECT $15,$1,$2,$3,
'contact_candidate',c.id,1,c.version,'contact_candidate.created','user',$4,
jsonb_build_object('status',c.status,'opportunityId',$5,'prospectId',c.prospect_id,
'contactRole',$8),$9,$17,'contact.candidate.create:'||$10 FROM created c,evidence RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,
website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
outcome,reason,after_redacted,request_id,correlation_id,integrity_hash) SELECT $16,$1,$2,$3,
l.id,$4,'user','contact_candidate.created','contact_candidate',c.id,'success',$9,
jsonb_build_object('status',c.status,'opportunityId',$5,'prospectId',c.prospect_id,
'contactRole',$8),$17,$17,$11 FROM lifecycle l,created c RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,
website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,
response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $12,$1,$2,$3,
$10,'contact.candidate.create',$11,201,jsonb_build_object('candidateId',c.id,'prospectId',
c.prospect_id,'recommendationContextVersionId',c.recommendation_context_version_id,
'normalizedEmail',c.normalized_email,'contactRole',$8,'status',c.status,'version',c.version,
'lifecycleEventId',$15,'auditEventId',$16),1,now(),now()+interval '24 hours',$4,$4
FROM created c,audit RETURNING request_hash "requestHash",response_body "responseBody")
,
reused AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,
website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,
response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $12,$1,$2,$3,
$10,'contact.candidate.create',$11,201,jsonb_build_object('candidateId',d.id,'prospectId',
d.prospect_id,'recommendationContextVersionId',d.recommendation_context_version_id,
'normalizedEmail',d.normalized_email,'contactRole',$8,'status',d.status,'version',d.version,
'lifecycleEventId',d.lifecycle_event_id,'auditEventId',d.audit_event_id),1,now(),
now()+interval '24 hours',$4,$4 FROM reusable d
WHERE NOT EXISTS (SELECT 1 FROM completed)
RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL
SELECT 'reused',"requestHash","responseBody" FROM reused UNION ALL
SELECT 'replay',"requestHash","responseBody" FROM prior UNION ALL
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM source) THEN 'not_found' ELSE 'duplicate' END,
$11,NULL::jsonb WHERE NOT EXISTS (SELECT 1 FROM completed)
AND NOT EXISTS (SELECT 1 FROM reused) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const row = (
        await client.query(sql, [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          actor.userId,
          input.opportunityId,
          normalizedEmail,
          emailDomainAscii,
          input.contactRole,
          input.reason,
          input.idempotencyKey,
          requestHash,
          ids[0],
          ids[1],
          ids[2],
          ids[3],
          ids[4],
          input.requestId,
          evidenceHash,
        ])
      ).rows[0] as ManualCandidateRow | undefined;
      if (row?.requestHash !== requestHash) {
        throw failure(
          backlinkErrorCodes.conflict,
          "Idempotency key is already bound to a different request.",
        );
      }
      if (row.state === "not_found") {
        throw failure(
          backlinkErrorCodes.notFound,
          "Opportunity was not found in this project.",
        );
      }
      if (row.state === "duplicate") {
        throw failure(
          backlinkErrorCodes.conflict,
          "A contact candidate for this Opportunity already exists.",
        );
      }
      if (row.responseBody === undefined) {
        throw failure(
          backlinkErrorCodes.conflict,
          "The idempotent command is already in progress.",
        );
      }
      return {
        ...row.responseBody,
        replayed: row.state === "replay" || row.state === "reused",
      };
    },
    async confirm(input: ConfirmContactInput): Promise<ConfirmContactResult> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const [contactId, lifecycleId, auditId] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const integrity = createHash("sha256")
        .update(
          JSON.stringify({
            candidateId: input.candidateId,
            expectedVersion: input.expectedVersion,
            contactRole: input.contactRole,
            reason: input.reason,
            actorId: actor.userId,
          }),
        )
        .digest("hex");
      const sql = `WITH existing AS (SELECT * FROM backlink_contact_candidates WHERE
(organization_id,workspace_id,website_project_id)=($1,$2,$3) AND id=$5),
changed AS (UPDATE backlink_contact_candidates c SET status='promoted',version=c.version+1,
updated_at=now(),updated_by=$4 FROM existing x WHERE c.id=x.id AND x.version=$6 AND
x.status='candidate' AND x.guessed=false AND EXISTS (SELECT 1 FROM backlink_contact_evidence e WHERE
(e.organization_id,e.workspace_id,e.website_project_id,e.candidate_id)=($1,$2,$3,x.id) AND
e.invalidated_at IS NULL AND e.expires_at>now()) RETURNING c.*),
contact AS (INSERT INTO backlink_contacts (id,organization_id,workspace_id,website_project_id,prospect_id,
recommendation_context_version_id,source_candidate_id,normalized_email,contact_role,confidence,guessed,
observed_role,inferred_purpose,purpose_confidence,purpose_rule_version,purpose_evidence,
confirmed_at,confirmed_by,status,created_by,updated_by) SELECT $9,$1,$2,$3,prospect_id,
recommendation_context_version_id,id,normalized_email,$7::text,confidence,false,observed_role,
$7::text,100,
'manual-contact-purpose.v1',purpose_evidence || jsonb_build_array(jsonb_build_object(
'tier','manual','field','manual_confirmation','value',$7::text,'matchedToken',$7::text,
'ruleId','manual.contact-purpose')),now(),$4,'active',$4,$4
FROM changed RETURNING *),lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,
workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
actor_type,actor_id,before_state,after_state,reason,correlation_id,idempotency_key) SELECT $10,$1,$2,$3,
'contact_candidate',c.source_candidate_id,c2.version,c2.version,'contact_candidate.confirmed','user',$4,
jsonb_build_object('status','candidate','version',c2.version-1),jsonb_build_object('status','promoted',
'contactId',c.id),$8,$12,'contact.confirm:'||c.source_candidate_id FROM contact c JOIN changed c2
ON c2.id=c.source_candidate_id RETURNING id),audit AS (INSERT INTO backlink_audit_events (id,
organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,
target_id,outcome,reason,before_redacted,after_redacted,request_id,correlation_id,integrity_hash)
SELECT $11,$1,$2,$3,l.id,$4,'user','contact_candidate.confirmed','contact_candidate',
c.source_candidate_id,'success',$8,jsonb_build_object('expectedVersion',$6,
'observedRole',c2.observed_role,'inferredPurpose',c2.inferred_purpose,
'purposeConfidence',c2.purpose_confidence,'purposeRuleVersion',c2.purpose_rule_version),
jsonb_build_object('status','promoted','contactId',c.id,'observedRole',c.observed_role,
'inferredPurpose',c.inferred_purpose,'purposeConfidence',c.purpose_confidence,
'purposeRuleVersion',c.purpose_rule_version,
'purposeCorrected',c.inferred_purpose IS DISTINCT FROM c2.inferred_purpose),
$12,$12,$13 FROM lifecycle l,contact c JOIN changed c2 ON c2.id=c.source_candidate_id RETURNING id)
SELECT 'completed' state,c.source_candidate_id "candidateId",c.id "contactId",c2.version
"candidateVersion",c.version "contactVersion",$10 "lifecycleEventId",$11 "auditEventId"
FROM contact c JOIN changed c2 ON c2.id=c.source_candidate_id,audit
UNION ALL SELECT 'not_found',NULL,NULL,NULL,NULL,NULL,NULL WHERE NOT EXISTS (SELECT 1 FROM existing)
UNION ALL SELECT 'version_conflict',NULL,NULL,NULL,NULL,NULL,NULL WHERE EXISTS (SELECT 1 FROM existing)
AND NOT EXISTS (SELECT 1 FROM changed)`;
      const row = (
        await client.query(sql, [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          actor.userId,
          input.candidateId,
          input.expectedVersion,
          input.contactRole,
          input.reason,
          contactId,
          lifecycleId,
          auditId,
          input.requestId,
          integrity,
        ])
      ).rows[0] as StateRow | undefined;
      if (row?.state === "not_found")
        throw failure(
          backlinkErrorCodes.notFound,
          "Contact candidate was not found in this project.",
        );
      if (row?.state !== "completed")
        throw failure(
          backlinkErrorCodes.conflict,
          "ExpectedVersion does not match a confirmable contact candidate.",
        );
      return {
        candidateId: row.candidateId as string,
        contactId: row.contactId as string,
        candidateStatus: "promoted",
        candidateVersion: row.candidateVersion as number,
        contactStatus: "active",
        contactVersion: row.contactVersion as number,
        lifecycleEventId: row.lifecycleEventId as string,
        auditEventId: row.auditEventId as string,
      };
    },
  };
}
