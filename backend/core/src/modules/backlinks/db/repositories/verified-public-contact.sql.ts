// Callers supply only static SQL aliases, never request values.
export function verifiedPublicContactSql(scope: string): string {
  return `SELECT candidate.*,evidence.source_url
    FROM backlink_contact_candidates candidate
    JOIN backlink_contact_evidence evidence
      ON evidence.organization_id=candidate.organization_id
     AND evidence.workspace_id=candidate.workspace_id
     AND evidence.website_project_id=candidate.website_project_id
     AND evidence.candidate_id=candidate.id
   WHERE candidate.organization_id=${scope}.organization_id
     AND candidate.workspace_id=${scope}.workspace_id
     AND candidate.website_project_id=${scope}.website_project_id
     AND candidate.prospect_id=${scope}.prospect_id
     AND candidate.recommendation_context_version_id=
         ${scope}.recommendation_context_version_id
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
     AND split_part(lower(candidate.normalized_email),'@',1)
       !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
     AND candidate.email_domain_ascii NOT IN (
       'example.com','example.org','example.net'
     )
     AND candidate.email_domain_ascii NOT LIKE '%.invalid'
     AND evidence.invalidated_at IS NULL
     AND evidence.expires_at>statement_timestamp()
     AND evidence.confidence>=80
     AND evidence.extraction_method IN (
       'mailto','visible_text','obfuscated_text','json_ld'
     )
   ORDER BY candidate.confidence DESC,candidate.purpose_confidence DESC,
            evidence.confidence DESC,candidate.id,
            evidence.observed_at DESC,evidence.id
   LIMIT 1`;
}
