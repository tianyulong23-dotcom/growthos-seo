import type {
  ContactDiscoveryRepository, ContactDiscoveryWrite,
} from "../../application/services/contact-discovery.service.js";
import {
  withBacklinkTenantTransaction, type BacklinkTenantPool,
} from "../tenant-transaction.js";

export function createContactDiscoveryRepository(
  pool: BacklinkTenantPool,
): ContactDiscoveryRepository {
  return { merge: (input: ContactDiscoveryWrite) => withBacklinkTenantTransaction(
    pool, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
    },
    async (client) => {
    let evidenceInserted = 0, evidenceMerged = 0;
    for (const record of input.records) {
        const candidate = await client.query(`
          INSERT INTO backlink_contact_candidates AS c (
            id,organization_id,workspace_id,website_project_id,prospect_id,
            recommendation_context_version_id,normalized_email,email_domain_ascii,
            domain_relation,syntax_validator_version,confidence,observed_role,
            inferred_purpose,purpose_confidence,purpose_rule_version,purpose_evidence,
            created_by,updated_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
          ON CONFLICT (
            organization_id,workspace_id,website_project_id,prospect_id,
            recommendation_context_version_id,normalized_email
          ) DO UPDATE SET email_domain_ascii=EXCLUDED.email_domain_ascii,
            domain_relation=EXCLUDED.domain_relation,
            syntax_validator_version=EXCLUDED.syntax_validator_version,
            confidence=GREATEST(c.confidence,EXCLUDED.confidence),
            observed_role=CASE WHEN EXCLUDED.purpose_confidence>=c.purpose_confidence
              THEN EXCLUDED.observed_role ELSE c.observed_role END,
            inferred_purpose=CASE WHEN EXCLUDED.purpose_confidence>=c.purpose_confidence
              THEN EXCLUDED.inferred_purpose ELSE c.inferred_purpose END,
            purpose_confidence=GREATEST(c.purpose_confidence,EXCLUDED.purpose_confidence),
            purpose_rule_version=CASE WHEN EXCLUDED.purpose_confidence>=c.purpose_confidence
              THEN EXCLUDED.purpose_rule_version ELSE c.purpose_rule_version END,
            purpose_evidence=CASE WHEN EXCLUDED.purpose_confidence>=c.purpose_confidence
              THEN EXCLUDED.purpose_evidence ELSE c.purpose_evidence END,
            updated_at=now(),updated_by=EXCLUDED.updated_by,version=c.version+1
          RETURNING id
        `, [record.candidateId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.prospectId,
          input.recommendationContextVersionId, record.normalizedEmail,
          record.emailDomainAscii, record.domainRelation,
          record.syntaxValidatorVersion, record.confidence, record.observedRole,
          record.inferredPurpose, record.purposeConfidence, record.purposeRuleVersion,
          JSON.stringify(record.purposeEvidence), input.actorId]);
        const candidateId = candidate.rows[0]?.id;
        if (typeof candidateId !== "string") throw new Error("Contact candidate merge failed.");
        const key = JSON.stringify([input.organizationId, input.workspaceId, input.websiteProjectId,
          candidateId, record.sourceUrl, record.extractionMethod,
          record.contentSha256]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
        const merged = await client.query(`
          UPDATE backlink_contact_evidence SET
            observed_at=LEAST(observed_at,$8),confidence=GREATEST(confidence,$9),
            expires_at=GREATEST(expires_at,$10),
            rule_version=$11,domain_relation=$12
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
            AND candidate_id=$4 AND source_url=$5 AND extraction_method=$6
            AND content_sha256=$7 RETURNING id
        `, [input.organizationId, input.workspaceId, input.websiteProjectId,
          candidateId, record.sourceUrl, record.extractionMethod,
          record.contentSha256, record.observedAt, record.confidence,
          record.expiresAt, record.purposeRuleVersion, record.domainRelation]);
        if (merged.rows[0] !== undefined) {
          evidenceMerged++;
          continue;
        }
        await client.query(`
          INSERT INTO backlink_contact_evidence (
            id,organization_id,workspace_id,website_project_id,candidate_id,
            source_url,observed_at,extraction_method,evidence_snippet,parser_version,
            content_sha256,confidence,expires_at,created_by,rule_version,
            domain_relation
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `, [record.evidenceId, input.organizationId, input.workspaceId,
          input.websiteProjectId, candidateId, record.sourceUrl, record.observedAt,
          record.extractionMethod, record.evidenceSnippet, record.parserVersion,
          record.contentSha256, record.confidence, record.expiresAt, input.actorId,
          record.purposeRuleVersion, record.domainRelation]);
        evidenceInserted++;
    }
    return { candidateCount: input.records.length, evidenceInserted, evidenceMerged };
  }) };
}
