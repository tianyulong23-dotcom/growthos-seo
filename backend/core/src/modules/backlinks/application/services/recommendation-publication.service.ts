export type RecommendationPublicationClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export async function synchronizeRecommendationPublication(
  client: RecommendationPublicationClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    prospectId: string;
    recommendationContextVersionId: string;
    actorId: string;
  }>,
): Promise<number> {
  const result = await client.query(
    `WITH latest_job AS (
       SELECT terminal_reason_code,status
         FROM backlink_contact_enrichment_jobs
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
          AND prospect_id=$4
          AND recommendation_context_version_id=$5
        ORDER BY completed_at DESC NULLS LAST,updated_at DESC,id DESC
        LIMIT 1
     ),
     eligible_contacts AS (
       SELECT inventory.recommendation_id,
              candidate.id candidate_id,
              candidate.normalized_email,
              candidate.inferred_purpose,
              candidate.confidence contact_confidence,
              candidate.purpose_confidence,
              candidate.purpose_rule_version,
              evidence.id evidence_id,
              evidence.source_url,
              evidence.observed_at,
              evidence.confidence evidence_confidence,
              evidence.rule_version evidence_rule_version
         FROM backlink_recommendation_inventory AS inventory
         JOIN backlink_contact_candidates AS candidate ON
           (candidate.organization_id,candidate.workspace_id,
            candidate.website_project_id,candidate.prospect_id,
            candidate.recommendation_context_version_id)=
           (inventory.organization_id,inventory.workspace_id,
            inventory.website_project_id,inventory.prospect_id,
            inventory.recommendation_context_version_id)
         JOIN LATERAL (
           SELECT id,source_url,observed_at,confidence,rule_version
             FROM backlink_contact_evidence AS evidence
            WHERE (evidence.organization_id,evidence.workspace_id,
                   evidence.website_project_id,evidence.candidate_id)=
                  (candidate.organization_id,candidate.workspace_id,
                   candidate.website_project_id,candidate.id)
              AND evidence.invalidated_at IS NULL
              AND evidence.expires_at>now()
              AND evidence.extraction_method IN (
                'mailto','visible_text','obfuscated_text','json_ld'
              )
              AND evidence.confidence>=80
            ORDER BY evidence.confidence DESC,evidence.observed_at DESC,
                     evidence.id
            LIMIT 1
         ) evidence ON true
        WHERE (inventory.organization_id,inventory.workspace_id,
               inventory.website_project_id)=($1,$2,$3)
          AND inventory.prospect_id=$4
          AND inventory.recommendation_context_version_id=$5
          AND candidate.status IN ('candidate','promoted')
          AND candidate.invalidated_at IS NULL
          AND candidate.guessed=false
          AND candidate.confidence>=80
          AND candidate.purpose_confidence>=70
          AND candidate.inferred_purpose IN (
            'editorial','partnerships','advertising','business',
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
     ),
     eligible AS (
       SELECT count(DISTINCT candidate_id)::integer email_count
         FROM eligible_contacts
     ),
     selected AS (
       SELECT *
         FROM eligible_contacts
        ORDER BY contact_confidence DESC,purpose_confidence DESC,
                 evidence_confidence DESC,candidate_id
        LIMIT 1
     ),
     inserted_snapshot AS (
       INSERT INTO backlink_contact_evidence_snapshots (
         id,organization_id,workspace_id,website_project_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         contact_candidate_id,contact_evidence_id,source_url,email_sha256,
         email_reference,inferred_purpose,contact_confidence,
         purpose_confidence,evidence_confidence,collected_at,rules_version,
         created_by
       )
       SELECT gen_random_uuid(),$1,$2,$3,selected.recommendation_id,$4,$5,
              selected.candidate_id,selected.evidence_id,selected.source_url,
              encode(
                sha256(convert_to(selected.normalized_email,'UTF8')),
                'hex'
              ),
              'contact-candidate:'||selected.candidate_id::text,
              selected.inferred_purpose,selected.contact_confidence,
              selected.purpose_confidence,selected.evidence_confidence,
              selected.observed_at,
              'contact-publication-rules.v2|'||
                selected.purpose_rule_version||'|'||
                selected.evidence_rule_version,
              $6
         FROM selected,latest_job
        WHERE latest_job.terminal_reason_code='PUBLIC_EMAIL_FOUND'
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         recommendation_id,recommendation_context_version_id,
         contact_candidate_id,contact_evidence_id,rules_version
       ) DO NOTHING
       RETURNING *
     ),
     chosen_snapshot AS (
       SELECT * FROM inserted_snapshot
       UNION ALL
       (SELECT snapshot.*
          FROM backlink_contact_evidence_snapshots AS snapshot
          JOIN selected ON
            (snapshot.organization_id,snapshot.workspace_id,
             snapshot.website_project_id,snapshot.recommendation_id,
             snapshot.recommendation_context_version_id,
             snapshot.contact_candidate_id,snapshot.contact_evidence_id)=
            ($1,$2,$3,selected.recommendation_id,$5,
             selected.candidate_id,selected.evidence_id)
         WHERE snapshot.rules_version =
               'contact-publication-rules.v2|'||
                 selected.purpose_rule_version||'|'||
                 selected.evidence_rule_version
           AND NOT EXISTS (SELECT 1 FROM inserted_snapshot)
         ORDER BY snapshot.created_at DESC,snapshot.id DESC
         LIMIT 1)
     ),
     inventory AS (
       UPDATE backlink_recommendation_inventory
          SET publication_status=CASE
                WHEN snapshot.id IS NOT NULL THEN 'PUBLISHED'
                WHEN backlink_recommendation_inventory.publication_status=
                     'PUBLISHED' THEN 'CONTACT_REVIEW'
                WHEN latest_job.terminal_reason_code IS NULL
                     THEN 'CONTACT_PENDING'
                ELSE 'NOT_PUBLISHED'
              END,
              verified_public_email_count=CASE
                WHEN snapshot.id IS NOT NULL THEN eligible.email_count
                ELSE 0
              END,
              contact_evidence_snapshot_id=COALESCE(
                snapshot.id,
                backlink_recommendation_inventory.contact_evidence_snapshot_id
              ),
              default_contact_candidate_id=COALESCE(
                snapshot.contact_candidate_id,
                backlink_recommendation_inventory.default_contact_candidate_id
              ),
              default_contact_source_url=COALESCE(
                snapshot.source_url,
                backlink_recommendation_inventory.default_contact_source_url
              ),
              default_contact_email_sha256=COALESCE(
                snapshot.email_sha256,
                backlink_recommendation_inventory.default_contact_email_sha256
              ),
              default_contact_email_reference=COALESCE(
                snapshot.email_reference,
                backlink_recommendation_inventory.default_contact_email_reference
              ),
              contact_collected_at=COALESCE(
                snapshot.collected_at,
                backlink_recommendation_inventory.contact_collected_at
              ),
              contact_rules_version=COALESCE(
                snapshot.rules_version,
                backlink_recommendation_inventory.contact_rules_version
              ),
              updated_at=now(),updated_by=$6,version=version+1
         FROM eligible
         LEFT JOIN latest_job ON true
         LEFT JOIN chosen_snapshot AS snapshot ON true
        WHERE (
          backlink_recommendation_inventory.organization_id,
          backlink_recommendation_inventory.workspace_id,
          backlink_recommendation_inventory.website_project_id
        )=($1,$2,$3)
           AND backlink_recommendation_inventory.prospect_id=$4
           AND backlink_recommendation_inventory
                 .recommendation_context_version_id=$5
       RETURNING verified_public_email_count
     ),
     commercial AS (
       UPDATE backlink_commercial_candidates AS commercial
          SET state=CASE
                WHEN EXISTS (SELECT 1 FROM chosen_snapshot) THEN 'published'
                WHEN commercial.state='published' THEN 'candidate_ready'
                ELSE commercial.state
              END,
              updated_at=now(),updated_by=$6,version=version+1
         FROM eligible
        WHERE (commercial.organization_id,commercial.workspace_id,
               commercial.website_project_id)=($1,$2,$3)
          AND commercial.prospect_id=$4
          AND commercial.project_context_version_id=$5
          AND commercial.state IN (
            'candidate_ready','contact_enrichment','published'
          )
          AND commercial.state IS DISTINCT FROM CASE
                WHEN EXISTS (SELECT 1 FROM chosen_snapshot) THEN 'published'
                WHEN commercial.state='published' THEN 'candidate_ready'
                ELSE commercial.state
              END
       RETURNING commercial.id
     )
     SELECT eligible.email_count "emailCount"
       FROM eligible`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.prospectId,
      input.recommendationContextVersionId,
      input.actorId,
    ],
  );
  return Number(result.rows[0]?.emailCount ?? 0);
}
