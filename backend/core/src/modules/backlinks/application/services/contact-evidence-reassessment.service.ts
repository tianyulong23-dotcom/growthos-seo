import {
  contactEvidenceConfidence,
  contactEvidenceConfidenceRuleVersion,
  type ContactDomainRelation,
  type ContactEvidenceSource,
} from "../../domain/contacts/contact-evidence-confidence.js";
import {
  classifyContactPurpose,
} from "../../domain/contacts/contact-purpose.js";

type ContactEvidenceReassessmentClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<
    Readonly<{
      rows: readonly Record<string, unknown>[];
      rowCount?: number | null;
    }>
  >;
}>;

const automatedSources = new Set<ContactEvidenceSource>([
  "mailto",
  "visible_text",
  "obfuscated_text",
  "json_ld",
]);
const domainRelations = new Set<ContactDomainRelation>([
  "same_registrable_domain",
  "external_domain",
  "unknown",
]);

export async function reassessStoredContactEvidence(
  client: ContactEvidenceReassessmentClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    recommendationContextVersionId: string;
    prospectId: string;
    actorId: string;
  }>,
): Promise<Readonly<{ candidatesUpdated: number; evidenceUpdated: number }>> {
  const evidenceRows = await client.query(
    `SELECT candidate.id "candidateId",
            candidate.normalized_email "normalizedEmail",
            evidence.id "evidenceId",
            evidence.source_url "sourceUrl",
            evidence.extraction_method "extractionMethod",
            evidence.evidence_snippet "evidenceSnippet",
            evidence.domain_relation "domainRelation"
       FROM backlink_contact_candidates AS candidate
       JOIN backlink_contact_evidence AS evidence ON
         (evidence.organization_id,evidence.workspace_id,
          evidence.website_project_id,evidence.candidate_id)=
         (candidate.organization_id,candidate.workspace_id,
          candidate.website_project_id,candidate.id)
      WHERE (candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id)=($1,$2,$3)
        AND candidate.recommendation_context_version_id=$4
        AND candidate.prospect_id=$5
        AND candidate.status IN ('candidate','promoted')
        AND candidate.invalidated_at IS NULL
        AND candidate.guessed=false
        AND evidence.invalidated_at IS NULL
        AND evidence.expires_at>now()
        AND evidence.extraction_method IN (
          'mailto','visible_text','obfuscated_text','json_ld'
        )`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.prospectId,
    ],
  );

  let candidatesUpdated = 0;
  let evidenceUpdated = 0;
  for (const row of evidenceRows.rows) {
    const candidateId = row.candidateId;
    const normalizedEmail = row.normalizedEmail;
    const evidenceId = row.evidenceId;
    const sourceUrl = row.sourceUrl;
    const extractionMethod = row.extractionMethod;
    const evidenceSnippet = row.evidenceSnippet;
    const domainRelation = row.domainRelation;
    if (
      typeof candidateId !== "string"
      || typeof normalizedEmail !== "string"
      || typeof evidenceId !== "string"
      || typeof sourceUrl !== "string"
      || typeof evidenceSnippet !== "string"
      || typeof extractionMethod !== "string"
      || !automatedSources.has(extractionMethod as ContactEvidenceSource)
      || typeof domainRelation !== "string"
      || !domainRelations.has(domainRelation as ContactDomainRelation)
    ) {
      continue;
    }
    const source = extractionMethod as ContactEvidenceSource;
    const relation = domainRelation as ContactDomainRelation;
    const confidence = contactEvidenceConfidence({
      source,
      domainRelation: relation,
    });
    const purpose = classifyContactPurpose({
      email: normalizedEmail,
      source,
      nearbyText: evidenceSnippet,
      pageUrl: sourceUrl,
    });
    const candidateUpdate = await client.query(
      `UPDATE backlink_contact_candidates AS candidate
          SET confidence=GREATEST(candidate.confidence,$6),
              observed_role=CASE
                WHEN $7>candidate.purpose_confidence
                  OR (
                    $7=candidate.purpose_confidence
                    AND candidate.inferred_purpose=$8
                    AND candidate.purpose_rule_version<>$9
                  )
                  THEN $10
                ELSE candidate.observed_role
              END,
              inferred_purpose=CASE
                WHEN $7>candidate.purpose_confidence
                  OR (
                    $7=candidate.purpose_confidence
                    AND candidate.inferred_purpose=$8
                    AND candidate.purpose_rule_version<>$9
                  )
                  THEN $8
                ELSE candidate.inferred_purpose
              END,
              purpose_confidence=GREATEST(
                candidate.purpose_confidence,$7
              ),
              purpose_rule_version=CASE
                WHEN $7>candidate.purpose_confidence
                  OR (
                    $7=candidate.purpose_confidence
                    AND candidate.inferred_purpose=$8
                    AND candidate.purpose_rule_version<>$9
                  )
                  THEN $9
                ELSE candidate.purpose_rule_version
              END,
              purpose_evidence=CASE
                WHEN $7>candidate.purpose_confidence
                  OR (
                    $7=candidate.purpose_confidence
                    AND candidate.inferred_purpose=$8
                    AND candidate.purpose_rule_version<>$9
                  )
                  THEN $11::jsonb
                ELSE candidate.purpose_evidence
              END,
              updated_at=now(),updated_by=$12,version=candidate.version+1
        WHERE (candidate.organization_id,candidate.workspace_id,
               candidate.website_project_id,candidate.id)=($1,$2,$3,$4)
          AND candidate.recommendation_context_version_id=$5
          AND (
            candidate.confidence<$6
            OR $7>candidate.purpose_confidence
            OR (
              $7=candidate.purpose_confidence
              AND candidate.inferred_purpose=$8
              AND candidate.purpose_rule_version<>$9
            )
          )
      RETURNING candidate.id`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        candidateId,
        input.recommendationContextVersionId,
        confidence,
        purpose.confidence,
        purpose.inferredPurpose,
        purpose.ruleVersion,
        purpose.observedRole,
        JSON.stringify(purpose.evidence),
        input.actorId,
      ],
    );
    candidatesUpdated += candidateUpdate.rowCount ?? 0;
    const evidenceUpdate = await client.query(
      `UPDATE backlink_contact_evidence AS evidence
          SET confidence=GREATEST(evidence.confidence,$6),
              rule_version=$7
        WHERE (evidence.organization_id,evidence.workspace_id,
               evidence.website_project_id,evidence.id)=($1,$2,$3,$4)
          AND evidence.candidate_id=$5
          AND (
            evidence.confidence<$6
            OR evidence.rule_version<>$7
          )
      RETURNING evidence.id`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        evidenceId,
        candidateId,
        confidence,
        contactEvidenceConfidenceRuleVersion,
      ],
    );
    evidenceUpdated += evidenceUpdate.rowCount ?? 0;
  }
  return { candidatesUpdated, evidenceUpdated };
}
