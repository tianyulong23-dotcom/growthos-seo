param(
    [string]$PostgresContainer = "growthos-live001-postgres"
)

$ErrorActionPreference = "Stop"

$sql = @'
\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE growthos_backlinks_canary;
SET LOCAL row_security = on;
SET LOCAL search_path = backlinks, pg_catalog;

SELECT set_config(
    'app.current_organization_id',
    '11111111-1111-4111-8111-111111111111',
    true
);
SELECT set_config(
    'app.current_workspace_id',
    '22222222-2222-4222-8222-222222222222',
    true
);
SELECT set_config(
    'app.current_website_project_id',
    '33333333-3333-4333-8333-333333333333',
    true
);

DO $seed$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM backlink_opportunities
        WHERE id = '44444444-4444-4444-8444-444444444441'
          AND organization_id = '11111111-1111-4111-8111-111111111111'
          AND workspace_id = '22222222-2222-4222-8222-222222222222'
          AND website_project_id = '33333333-3333-4333-8333-333333333333'
    ) THEN
        RAISE EXCEPTION 'LIVE-004 Canary Opportunity is missing';
    END IF;
END
$seed$;

INSERT INTO backlink_evidence_snapshots (
    id, organization_id, workspace_id, website_project_id, opportunity_id,
    evidence_items, snapshot_hash, schema_version, created_by
) VALUES (
    'a0040000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444441',
    '[{"ref":"canary:live004:controlled-input","kind":"manual"}]'::jsonb,
    repeat('4', 64),
    1,
    'live004-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_assessment_runs (
    id, organization_id, workspace_id, website_project_id, opportunity_id,
    policy_version, evidence_contract_version, source_release_ids,
    input_evidence_refs, input_evidence_hash, status, attempt_count,
    started_at, schema_version, created_by, updated_by
) VALUES (
    'a0040000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444441',
    'live004-controlled-assessment.v1',
    'live004-controlled-evidence.v1',
    '["live004-controlled-seed-20260802"]'::jsonb,
    '["canary:live004:controlled-input"]'::jsonb,
    repeat('5', 64),
    'RUNNING',
    1,
    now(),
    1,
    'live004-controlled-seed',
    'live004-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_assessment_snapshots (
    id, organization_id, workspace_id, website_project_id, run_id,
    opportunity_id, policy_version, input_evidence_hash, snapshot_version,
    source_release_ids, availability, confidence, evidence_refs, stale,
    result_payload, result_hash, generated_at, schema_version, created_by
) VALUES (
    'a0040000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    'a0040000-0000-4000-8000-000000000002',
    '44444444-4444-4444-8444-444444444441',
    'live004-controlled-assessment.v1',
    repeat('5', 64),
    1,
    '["live004-controlled-seed-20260802"]'::jsonb,
    'available',
    1.0000,
    '["canary:live004:controlled-input"]'::jsonb,
    false,
    '{"outcome":"controlled_gmail_canary_ready"}'::jsonb,
    repeat('6', 64),
    now(),
    1,
    'live004-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

UPDATE backlink_assessment_runs
SET status = 'SUCCEEDED',
    finished_at = COALESCE(finished_at, now()),
    last_successful_snapshot_id = 'a0040000-0000-4000-8000-000000000003',
    updated_at = now(),
    updated_by = 'live004-controlled-seed'
WHERE id = 'a0040000-0000-4000-8000-000000000002'
  AND status IN ('RUNNING', 'SUCCEEDED');

INSERT INTO backlink_contact_candidates (
    id, organization_id, workspace_id, website_project_id, prospect_id,
    recommendation_context_version_id, normalized_email, email_domain_ascii,
    domain_relation, syntax_validator_version, confidence, guessed, status,
    observed_role, inferred_purpose, purpose_confidence,
    purpose_rule_version, purpose_evidence, created_by, updated_by
) VALUES (
    'a0040000-0000-4000-8000-000000000004',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '88888888-8888-4888-8888-888888888881',
    '77777777-7777-4777-8777-777777777771',
    'canary-recipient@redacted.invalid',
    'redacted.invalid',
    'external_domain',
    'manual-live004.v1',
    100,
    false,
    'candidate',
    'controlled recipient',
    'general',
    100,
    'live004-controlled-recipient.v1',
    '[{"tier":"manual","field":"authorization","value":"masked","matchedToken":"controlled","ruleId":"live004.authorization"}]'::jsonb,
    'live004-controlled-seed',
    'live004-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_contact_evidence (
    id, organization_id, workspace_id, website_project_id, candidate_id,
    source_url, observed_at, extraction_method, evidence_snippet,
    parser_version, content_sha256, confidence, expires_at, created_by
) VALUES (
    'a0040000-0000-4000-8000-000000000005',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    'a0040000-0000-4000-8000-000000000004',
    'https://redacted.invalid/live004-controlled-authorization',
    now(),
    'manual',
    'Authorized controlled Canary recipient; address resolved at send time.',
    'manual-live004.v1',
    repeat('7', 64),
    100,
    now() + interval '7 days',
    'live004-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

DO $verify$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM backlink_assessment_runs AS run
        JOIN backlink_assessment_snapshots AS snapshot
          ON snapshot.id = run.last_successful_snapshot_id
        JOIN backlink_evidence_snapshots AS evidence
          ON evidence.opportunity_id = run.opportunity_id
        JOIN backlink_contact_candidates AS candidate
          ON candidate.prospect_id = '88888888-8888-4888-8888-888888888881'
        WHERE run.id = 'a0040000-0000-4000-8000-000000000002'
          AND run.status = 'SUCCEEDED'
          AND snapshot.id = 'a0040000-0000-4000-8000-000000000003'
          AND evidence.id = 'a0040000-0000-4000-8000-000000000001'
          AND candidate.id = 'a0040000-0000-4000-8000-000000000004'
          AND candidate.normalized_email = 'canary-recipient@redacted.invalid'
    ) THEN
        RAISE EXCEPTION 'LIVE-004 controlled seed verification failed';
    END IF;

    IF EXISTS (
        SELECT 1 FROM backlink_email_drafts
    ) OR EXISTS (
        SELECT 1 FROM backlink_send_intents
    ) OR EXISTS (
        SELECT 1 FROM backlink_send_attempts
    ) THEN
        RAISE EXCEPTION 'LIVE-004 must start from zero Draft and Send facts';
    END IF;
END
$verify$;

RESET ROLE;
COMMIT;

SELECT json_build_object(
    'evidenceSnapshotId', 'a0040000-0000-4000-8000-000000000001',
    'assessmentRunId', 'a0040000-0000-4000-8000-000000000002',
    'assessmentSnapshotId', 'a0040000-0000-4000-8000-000000000003',
    'contactCandidateId', 'a0040000-0000-4000-8000-000000000004'
) AS live004_seed;
'@

$running = docker inspect -f "{{.State.Running}}" $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $running.Trim() -ne "true") {
    throw "PostgreSQL container $PostgresContainer is not running"
}

$output = $sql |
    docker exec -i $PostgresContainer psql -X -A -t `
        -v ON_ERROR_STOP=1 -U postgres -d growthos_live001
if ($LASTEXITCODE -ne 0) {
    throw "LIVE-004 controlled Canary Seed failed"
}

$output | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Last 1
