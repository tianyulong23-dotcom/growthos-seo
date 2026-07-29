import { createHash, randomUUID } from "node:crypto";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
export type ContactCommandClient = Readonly<{ query(text: string, values?: readonly unknown[]):
  Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>> }>;
export type ContactCandidate = Readonly<{ id: string; prospectId: string; recommendationContextVersionId: string;
  normalizedEmail: string; domainRelation: "same_registrable_domain" | "external_domain" | "unknown";
  confidence: number; observedRole: string | null;
  inferredPurpose: "press" | "editorial" | "partnerships" | "advertising" | "support" | "general" | "unknown";
  purposeConfidence: number; purposeRuleVersion: string;
  purposeEvidence: Readonly<{ tier: string; field: string; value: string;
    matchedToken: string; ruleId: string }>[];
  guessed: boolean; status: "candidate"; version: number; evidence: { sourceUrl: string;
    observedAt: string; extractionMethod: string; evidenceSnippet: string; confidence: number; expiresAt: string }[] }>;
export type ConfirmContactInput = Readonly<{ context: ResolvedProjectContext; requestId: string;
  candidateId: string; expectedVersion: number; contactRole: string; reason: string }>;
export type ConfirmContactResult = Readonly<{ candidateId: string; contactId: string;
  candidateStatus: "promoted"; candidateVersion: number; contactStatus: "active";
  contactVersion: number; lifecycleEventId: string; auditEventId: string }>;
type StateRow = Record<string, unknown> & { state?: string };
const failure = (code: typeof backlinkErrorCodes.notFound | typeof backlinkErrorCodes.conflict,
  message: string) => new BacklinkError({ code, message });
function authorize(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) => ["owner", "admin", "member"].includes(role)))
    throw new BacklinkError({ code: backlinkErrorCodes.accessDenied,
      message: "Contact confirmation permission is required." });
}
export function createContactCommands(client: ContactCommandClient) {
  return {
    async listCandidates(context: ResolvedProjectContext, prospectId: string,
      limit: number): Promise<ContactCandidate[]> {
      const { tenant, project } = context;
      const result = await client.query(`SELECT c.id,c.prospect_id "prospectId",
c.recommendation_context_version_id "recommendationContextVersionId",c.normalized_email "normalizedEmail",
c.domain_relation "domainRelation",c.confidence,c.observed_role "observedRole",
c.inferred_purpose "inferredPurpose",c.purpose_confidence "purposeConfidence",
c.purpose_rule_version "purposeRuleVersion",c.purpose_evidence "purposeEvidence",
c.guessed,c.status,c.version,COALESCE((SELECT
jsonb_agg(jsonb_build_object('sourceUrl',e.source_url,'observedAt',e.observed_at,'extractionMethod',
e.extraction_method,'evidenceSnippet',e.evidence_snippet,'confidence',e.confidence,'expiresAt',
e.expires_at) ORDER BY e.confidence DESC,e.source_url) FROM backlink_contact_evidence e WHERE
(e.organization_id,e.workspace_id,e.website_project_id,e.candidate_id)=(c.organization_id,
c.workspace_id,c.website_project_id,c.id) AND e.invalidated_at IS NULL),'[]') evidence
FROM backlink_contact_candidates c WHERE (c.organization_id,c.workspace_id,c.website_project_id)=
($1,$2,$3) AND c.prospect_id=$4 AND c.status='candidate' AND c.invalidated_at IS NULL
ORDER BY c.confidence DESC,c.normalized_email,c.id LIMIT $5`,
        [tenant.organizationId, tenant.workspaceId, project.websiteProjectId, prospectId, limit]);
      return result.rows as unknown as ContactCandidate[];
    },
    async confirm(input: ConfirmContactInput): Promise<ConfirmContactResult> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const [contactId, lifecycleId, auditId] = [randomUUID(), randomUUID(), randomUUID()];
      const integrity = createHash("sha256").update(JSON.stringify({ candidateId: input.candidateId,
        expectedVersion: input.expectedVersion, contactRole: input.contactRole,
        reason: input.reason, actorId: actor.userId })).digest("hex");
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
recommendation_context_version_id,id,normalized_email,$7,confidence,false,observed_role,$7,100,
'manual-contact-purpose.v1',purpose_evidence || jsonb_build_array(jsonb_build_object(
'tier','manual','field','manual_confirmation','value',$7,'matchedToken',$7,
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
      const row = (await client.query(sql, [tenant.organizationId, tenant.workspaceId,
        project.websiteProjectId, actor.userId, input.candidateId, input.expectedVersion, input.contactRole,
        input.reason, contactId, lifecycleId, auditId, input.requestId, integrity])).rows[0] as StateRow | undefined;
      if (row?.state === "not_found")
        throw failure(backlinkErrorCodes.notFound, "Contact candidate was not found in this project.");
      if (row?.state !== "completed")
        throw failure(backlinkErrorCodes.conflict, "ExpectedVersion does not match a confirmable contact candidate.");
      return { candidateId: row.candidateId as string, contactId: row.contactId as string,
        candidateStatus: "promoted", candidateVersion: row.candidateVersion as number,
        contactStatus: "active", contactVersion: row.contactVersion as number,
        lifecycleEventId: row.lifecycleEventId as string, auditEventId: row.auditEventId as string };
    },
  };
}
