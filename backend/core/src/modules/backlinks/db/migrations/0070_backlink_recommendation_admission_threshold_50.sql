BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_qualification_facts
  DROP CONSTRAINT backlink_rec_qualification_values_v3_2_ck,
  ADD CONSTRAINT backlink_rec_qualification_values_v3_3_ck CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND metric_scope IN ('TARGET_MARKET', 'GLOBAL')
    AND (traffic_organic_etv IS NULL OR traffic_organic_etv >= 0)
    AND (spam_score IS NULL OR (spam_score >= 0 AND spam_score <= 100))
    AND (
      authority_rank IS NULL
      OR (authority_rank >= 0 AND authority_rank <= 100)
    )
    AND accessibility_decision IN (
      'accessible', 'inaccessible', 'insufficient_data'
    )
    AND (
      semantic_score IS NULL
      OR (semantic_score >= 0 AND semantic_score <= 100)
    )
    AND attempt > 0
    AND decision IN (
      'eligible', 'ineligible', 'insufficient_data', 'manual_review'
    )
    AND length(btrim(decision_reason_code)) > 0
    AND (model_version IS NULL OR length(btrim(model_version)) > 0)
    AND (prompt_version IS NULL OR length(btrim(prompt_version)) > 0)
    AND length(btrim(rule_version)) > 0
    AND length(btrim(fact_contract_version)) > 0
    AND length(btrim(worker_contract_version)) > 0
    AND jsonb_typeof(request_fingerprints) = 'object'
    AND jsonb_typeof(evidence) = 'object'
    AND (
      (recommendation_id IS NULL AND prospect_id IS NULL)
      OR (recommendation_id IS NOT NULL AND prospect_id IS NOT NULL)
    )
    AND (
      score_model_version = 'recommendation-commercial-fit.v4'
      OR (
        score_model_version = 'recommendation-commercial-fit.v3'
        AND rule_version = 'recommendation-commercial-fit-rules.v3.2'
        AND COALESCE(
          evidence->>'freshMetricsRole' IN (
            'evidence_only',
            'qualification_authority'
          ),
          false
        )
        AND COALESCE(
          jsonb_typeof(evidence->'screeningPolicy') = 'object',
          false
        )
        AND COALESCE(
          evidence#>>'{screeningPolicy,policyVersion}' =
            'commercial-fit-progressive-admission.v1',
          false
        )
        AND COALESCE(
          evidence#>>'{screeningPolicy,scoreModelVersion}' =
            'recommendation-commercial-fit.v3',
          false
        )
        AND COALESCE(
          evidence#>>'{screeningPolicy,ruleVersion}' =
            'recommendation-commercial-fit-rules.v3.2',
          false
        )
        AND COALESCE(
          jsonb_typeof(evidence#>'{screeningPolicy,components}') = 'array',
          false
        )
        AND CASE
          WHEN jsonb_typeof(
            evidence#>'{screeningPolicy,components}'
          ) = 'array'
          THEN jsonb_array_length(
            evidence#>'{screeningPolicy,components}'
          ) = 7
          ELSE false
        END
        AND COALESCE(
          jsonb_typeof(evidence#>'{screeningPolicy,hitGates}') = 'array',
          false
        )
        AND COALESCE(
          jsonb_typeof(evidence#>'{screeningPolicy,missingEvidence}') =
            'array',
          false
        )
        AND COALESCE(
          jsonb_typeof(evidence#>'{screeningPolicy,admission}') = 'object',
          false
        )
        AND COALESCE(
          evidence#>>'{screeningPolicy,admission,policyVersion}' =
            'commercial-fit-progressive-admission.v1',
          false
        )
        AND CASE
          WHEN jsonb_typeof(
            evidence#>'{screeningPolicy,admission,baselineThreshold}'
          ) = 'number'
          THEN (
            evidence#>>'{screeningPolicy,admission,baselineThreshold}'
          )::numeric IN (50, 55)
          ELSE false
        END
        AND CASE
          WHEN jsonb_typeof(
            evidence#>'{screeningPolicy,admission,appliedThreshold}'
          ) = 'number'
          THEN (
            evidence#>>'{screeningPolicy,admission,appliedThreshold}'
          )::numeric BETWEEN 0 AND 55
            AND mod(
              (
                evidence#>>'{screeningPolicy,admission,appliedThreshold}'
              )::numeric,
              5
            ) = 0
          ELSE false
        END
        AND (
          decision <> 'eligible'
          OR (
            COALESCE(
              evidence#>>'{screeningPolicy,sourceDecision}' = 'eligible',
              false
            )
            AND evidence#>'{screeningPolicy,hitGates}' = '[]'::jsonb
            AND CASE
              WHEN jsonb_typeof(
                evidence#>'{screeningPolicy,total}'
              ) = 'number'
                AND jsonb_typeof(
                  evidence#>'{screeningPolicy,admission,appliedThreshold}'
                ) = 'number'
              THEN (
                evidence#>>'{screeningPolicy,total}'
              )::numeric >= (
                evidence#>>'{screeningPolicy,admission,appliedThreshold}'
              )::numeric
              ELSE false
            END
          )
        )
      )
    )
  );

COMMIT;
