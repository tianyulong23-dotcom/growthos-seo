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
    `WITH pool_policy AS MATERIALIZED (
       SELECT visible_pool_generation,visible_pool_state,
              visible_pool_target_count
         FROM backlink_commercial_inventory_policies
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
          AND project_context_version_id=$5
        FOR UPDATE
     ),
     published_capacity AS (
       SELECT count(*)::integer published_count
         FROM backlink_recommendation_inventory AS inventory
         JOIN pool_policy ON
           inventory.visible_pool_generation=
             pool_policy.visible_pool_generation
        WHERE (inventory.organization_id,inventory.workspace_id,
               inventory.website_project_id)=($1,$2,$3)
          AND inventory.recommendation_context_version_id=$5
          AND inventory.publication_status='PUBLISHED'
          AND inventory.fit_decision='eligible'
          AND inventory.fit_score_model_version=
            'recommendation-commercial-fit.v3'
          AND inventory.contact_decision='eligible'
          AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
          AND inventory.verified_public_email_count>=1
          AND inventory.status IN ('ready','shown','accepted')
     ),
     latest_job AS (
       SELECT terminal_reason_code,status
         FROM backlink_contact_enrichment_jobs
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
          AND prospect_id=$4
          AND recommendation_context_version_id=$5
        ORDER BY completed_at DESC NULLS LAST,updated_at DESC,id DESC
        LIMIT 1
     ),
     fit_candidate AS (
       SELECT recommendation_id,commercial_score,
              commercial_score->>'decision' fit_decision
         FROM backlink_commercial_candidates
        WHERE (organization_id,workspace_id,website_project_id)=($1,$2,$3)
         AND prospect_id=$4
          AND project_context_version_id=$5
          AND visible_pool_generation=(
            SELECT visible_pool_generation FROM pool_policy
          )
          AND score_model_version='recommendation-commercial-fit.v3'
        ORDER BY updated_at DESC,id DESC
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
         JOIN fit_candidate ON
           fit_candidate.recommendation_id=inventory.recommendation_id
           AND fit_candidate.fit_decision='eligible'
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
          AND inventory.visible_pool_generation=(
            SELECT visible_pool_generation FROM pool_policy
          )
          AND inventory.publication_status<>'PUBLISHED'
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
     ),
     eligible AS (
       SELECT count(DISTINCT candidate_id)::integer email_count
         FROM eligible_contacts
     ),
     selected AS (
       SELECT eligible_contacts.*
         FROM eligible_contacts
         CROSS JOIN pool_policy
         CROSS JOIN published_capacity
        WHERE pool_policy.visible_pool_state='building'
          AND published_capacity.published_count<
            pool_policy.visible_pool_target_count
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
         FROM selected
        WHERE EXISTS (
            SELECT 1 FROM fit_candidate
             WHERE fit_decision='eligible'
          )
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
                WHEN snapshot.id IS NOT NULL
                  AND fit_candidate.fit_decision='eligible'
                  THEN 'PUBLISHED'
                WHEN backlink_recommendation_inventory.publication_status=
                     'PUBLISHED' THEN 'CONTACT_REVIEW'
                WHEN latest_job.terminal_reason_code IS NULL
                     THEN 'CONTACT_PENDING'
                ELSE 'NOT_PUBLISHED'
              END,
              fit_decision=CASE
                WHEN fit_candidate.recommendation_id IS NOT NULL
                  THEN fit_candidate.fit_decision
                ELSE 'unassessed'
              END,
              fit_score_model_version=CASE
                WHEN fit_candidate.recommendation_id IS NOT NULL
                  THEN 'recommendation-commercial-fit.v3'
                ELSE NULL
              END,
              contact_decision=CASE
                WHEN snapshot.id IS NOT NULL THEN 'eligible'
                WHEN latest_job.terminal_reason_code IS NULL THEN 'pending'
                WHEN latest_job.terminal_reason_code IN (
                  'CONTACT_FORM_ONLY','LOGIN_REQUIRED',
                  'CAPTCHA_OR_BOT_CHALLENGE','ROBOTS_DISALLOWED',
                  'ACCESS_DENIED','MANUAL_REVIEW_REQUIRED',
                  'COMPLETED_PARTIAL'
                ) THEN 'manual_review'
                ELSE 'ineligible'
              END,
              contact_reason_code=CASE
                WHEN snapshot.id IS NOT NULL THEN 'PUBLIC_EMAIL_FOUND'
                WHEN latest_job.terminal_reason_code IS NULL
                  THEN 'CONTACT_PENDING'
                ELSE latest_job.terminal_reason_code
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
         LEFT JOIN fit_candidate ON true
         LEFT JOIN chosen_snapshot AS snapshot ON true
         JOIN pool_policy ON true
        WHERE (
          backlink_recommendation_inventory.organization_id,
          backlink_recommendation_inventory.workspace_id,
          backlink_recommendation_inventory.website_project_id
        )=($1,$2,$3)
           AND backlink_recommendation_inventory.prospect_id=$4
           AND backlink_recommendation_inventory
                 .recommendation_context_version_id=$5
           AND backlink_recommendation_inventory.visible_pool_generation=
                 pool_policy.visible_pool_generation
           AND pool_policy.visible_pool_state='building'
           AND (
             backlink_recommendation_inventory.publication_status<>'PUBLISHED'
             OR EXISTS (SELECT 1 FROM selected)
           )
       RETURNING verified_public_email_count
     ),
     commercial AS (
       UPDATE backlink_commercial_candidates AS commercial
          SET state=CASE
                WHEN commercial.commercial_score->>'decision'='ineligible'
                  THEN 'excluded'
                WHEN commercial.commercial_score->>'decision'=
                     'insufficient_data' THEN 'insufficient_data'
                WHEN commercial.commercial_score->>'decision'='manual_review'
                  THEN 'manual_review'
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
          AND commercial.visible_pool_generation=(
            SELECT visible_pool_generation FROM pool_policy
          )
          AND EXISTS (
            SELECT 1 FROM pool_policy
             WHERE visible_pool_state='building'
          )
          AND commercial.score_model_version=
            'recommendation-commercial-fit.v3'
          AND commercial.state IS DISTINCT FROM CASE
                WHEN commercial.commercial_score->>'decision'='ineligible'
                  THEN 'excluded'
                WHEN commercial.commercial_score->>'decision'=
                     'insufficient_data' THEN 'insufficient_data'
                WHEN commercial.commercial_score->>'decision'='manual_review'
                  THEN 'manual_review'
                WHEN EXISTS (SELECT 1 FROM chosen_snapshot) THEN 'published'
                WHEN commercial.state='published' THEN 'candidate_ready'
                ELSE commercial.state
              END
       RETURNING commercial.id
     ),
     current_pool AS (
       SELECT published_capacity.published_count
              + CASE WHEN EXISTS (
                  SELECT 1 FROM inventory
                   WHERE verified_public_email_count>=1
                ) THEN 1 ELSE 0 END AS published_count
         FROM published_capacity
     ),
     activated AS (
       UPDATE backlink_commercial_inventory_policies AS policy
           SET visible_pool_state='active',
               refill_state='completed',
               termination_reason='HIGH_WATERMARK',
               last_publishable_count=current_pool.published_count,
               pause_reason=NULL,
               next_refill_at=NULL,
              updated_at=now(),updated_by=$6,version=version+1
         FROM pool_policy,current_pool
        WHERE (policy.organization_id,policy.workspace_id,
               policy.website_project_id)=($1,$2,$3)
          AND policy.project_context_version_id=$5
          AND policy.visible_pool_generation=
                pool_policy.visible_pool_generation
          AND policy.visible_pool_state='building'
          AND current_pool.published_count>=
                pool_policy.visible_pool_target_count
       RETURNING policy.visible_pool_generation
     )
     SELECT eligible.email_count "emailCount",
            (SELECT visible_pool_generation FROM activated)
              "activatedGeneration"
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
