param(
    [string]$PostgresContainer = "growthos-live001-postgres"
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Value) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $algorithm.ComputeHash($bytes)
    }
    finally {
        $algorithm.Dispose()
    }
    return ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
}

$sourceUrl = "https://publisher-live002.example.invalid/research/growthos"
$targetUrl = "https://live001-canary.example.invalid/growthos/backlinks"
$discoveryEvidence = (
    '{"contractVersion":"live002.controlled-seed.v1",' +
    '"refs":["canary:live002:source-page"],' +
    '"sourceReleaseId":"live002-canary-seed-20260731"}'
)
$validationEvidence = (
    '{"contractVersion":"placement.initial-validation.v1",' +
    '"result":{"reasonCode":"CANARY_CONTROLLED_INCONCLUSIVE",' +
    '"status":"INCONCLUSIVE"},"schemaVersion":1,' +
    '"source":"LIVE-002_CONTROLLED_CANARY_SEED"}'
)

$replacements = [ordered]@{
    "__SOURCE_URL__" = $sourceUrl
    "__TARGET_URL__" = $targetUrl
    "__SOURCE_HASH__" = Get-Sha256 $sourceUrl
    "__TARGET_HASH__" = Get-Sha256 $targetUrl
    "__DISCOVERY_EVIDENCE__" = $discoveryEvidence
    "__DISCOVERY_HASH__" = Get-Sha256 $discoveryEvidence
    "__VALIDATION_EVIDENCE__" = $validationEvidence
    "__VALIDATION_HASH__" = Get-Sha256 $validationEvidence
}

$sql = @'
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO platform.projects (
    id, organization_id, name, domain, country, language
) VALUES (
    '33333333-3333-4333-8333-333333333334',
    '11111111-1111-4111-8111-111111111111',
    'LIVE-002 Isolation Canary',
    'live002-isolation.example.invalid',
    'US',
    'en'
)
ON CONFLICT (id) DO NOTHING;

DO $seed$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM platform.projects
        WHERE id = '33333333-3333-4333-8333-333333333333'
          AND organization_id = '11111111-1111-4111-8111-111111111111'
          AND domain = 'live001-canary.example.invalid'
    ) THEN
        RAISE EXCEPTION 'LIVE-001 Website Project identity is missing or changed';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM platform.projects
        WHERE id = '33333333-3333-4333-8333-333333333334'
          AND organization_id = '11111111-1111-4111-8111-111111111111'
          AND domain = 'live002-isolation.example.invalid'
    ) THEN
        RAISE EXCEPTION 'LIVE-002 isolation Website Project identity is missing or changed';
    END IF;
END
$seed$;

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
    '22222222-2222-4222-8222-222222222223',
    true
);
SELECT set_config(
    'app.current_website_project_id',
    '33333333-3333-4333-8333-333333333334',
    true
);

INSERT INTO backlink_project_context_snapshots (
    id, organization_id, workspace_id, website_project_id,
    snapshot_version, project_status, canonical_domain, locale,
    country_code, profile_version_id, promotion_target_version_id,
    created_by
) VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222223',
    '33333333-3333-4333-8333-333333333334',
    1,
    'ACTIVE',
    'live002-isolation.example.invalid',
    'en-US',
    'US',
    'live002-isolation-profile-v1',
    'live002-isolation-home-v1',
    'live002-controlled-seed'
)
ON CONFLICT (
    organization_id, workspace_id, website_project_id, snapshot_version
) DO NOTHING;

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

INSERT INTO backlink_prospects (
    id, organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, hostname_ascii,
    registrable_domain, normalization_version, created_by, updated_by
) VALUES (
    '88888888-8888-4888-8888-888888888881',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '77777777-7777-4777-8777-777777777771',
    'publisher-live002.example.invalid',
    'example.invalid',
    'tldts-7.4.9-v1',
    'live002-controlled-seed',
    'live002-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_recommendations (
    id, organization_id, workspace_id, website_project_id, prospect_id,
    recommendation_context_version_id, status, created_by, updated_by
) VALUES (
    '99999999-9999-4999-8999-999999999991',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '88888888-8888-4888-8888-888888888881',
    '77777777-7777-4777-8777-777777777771',
    'accepted',
    'live002-controlled-seed',
    'live002-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_opportunities (
    id, organization_id, workspace_id, website_project_id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    target_site_key, target_host_ascii, target_identity_rule_version,
    join_sequence, business_stage, management_status, outcome_status,
    fulfillment_status, created_by, updated_by
) VALUES (
    '44444444-4444-4444-8444-444444444441',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '99999999-9999-4999-8999-999999999991',
    '88888888-8888-4888-8888-888888888881',
    '77777777-7777-4777-8777-777777777771',
    'example.invalid',
    'publisher-live002.example.invalid',
    'tldts-7.4.9-v1',
    1,
    'WAITING_PLACEMENT',
    'ACTIVE',
    'OPEN',
    'PENDING',
    'live002-controlled-seed',
    'live002-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_placement_candidates (
    id, organization_id, workspace_id, website_project_id, opportunity_id,
    source_type, source_external_id, source_page_url, normalized_source_url,
    normalized_source_url_hash, target_url, normalized_target_url,
    normalized_target_url_hash, url_normalization_version, status,
    match_status, initial_validation_status, discovery_evidence_snapshot,
    discovery_evidence_hash, evidence_contract_version,
    evidence_schema_version, version, created_by, updated_by
) VALUES (
    '55555555-5555-4555-8555-555555555551',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444441',
    'manual',
    'live002-controlled-seed-a',
    '__SOURCE_URL__',
    '__SOURCE_URL__',
    '__SOURCE_HASH__',
    '__TARGET_URL__',
    '__TARGET_URL__',
    '__TARGET_HASH__',
    'whatwg-tldts-v1',
    'REVIEW_REQUIRED',
    'AUTO_MATCHED',
    'INCONCLUSIVE',
    '__DISCOVERY_EVIDENCE__'::jsonb,
    '__DISCOVERY_HASH__',
    'live002.controlled-seed.v1',
    1,
    2,
    'live002-controlled-seed',
    'live002-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO backlink_placement_validation_runs (
    id, organization_id, workspace_id, website_project_id, candidate_id,
    opportunity_id, run_number, validation_method, status, source_page_url,
    normalized_source_url, normalized_source_url_hash, target_url,
    normalized_target_url, normalized_target_url_hash,
    url_normalization_version, evidence_snapshot, evidence_snapshot_hash,
    evidence_contract_version, evidence_schema_version, evidence_observed_at,
    verified_by, verified_at, audit_event_id, initial_evidence_ref,
    manual_confirmation_reason, created_by
) VALUES (
    '66666666-6666-4666-8666-666666666661',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '55555555-5555-4555-8555-555555555551',
    '44444444-4444-4444-8444-444444444441',
    1,
    'direct_page_check',
    'INCONCLUSIVE',
    '__SOURCE_URL__',
    '__SOURCE_URL__',
    '__SOURCE_HASH__',
    '__TARGET_URL__',
    '__TARGET_URL__',
    '__TARGET_HASH__',
    'whatwg-tldts-v1',
    '__VALIDATION_EVIDENCE__'::jsonb,
    '__VALIDATION_HASH__',
    'placement.initial-validation.v1',
    1,
    now() - interval '1 second',
    'live002-controlled-seed',
    now(),
    'live002-controlled-validation-audit',
    'canary:live002:controlled-inconclusive',
    NULL,
    'live002-controlled-seed'
)
ON CONFLICT (id) DO NOTHING;

DO $seed$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM backlink_project_context_snapshots
        WHERE organization_id = '11111111-1111-4111-8111-111111111111'
          AND workspace_id = '22222222-2222-4222-8222-222222222222'
          AND website_project_id = '33333333-3333-4333-8333-333333333333'
          AND snapshot_version = 1
          AND project_status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'LIVE-001 Backlinks Project Context is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM backlink_placement_candidates c
        JOIN backlink_placement_validation_runs v
          ON (
            v.organization_id, v.workspace_id, v.website_project_id,
            v.candidate_id, v.opportunity_id
          ) = (
            c.organization_id, c.workspace_id, c.website_project_id,
            c.id, c.opportunity_id
          )
        WHERE c.id = '55555555-5555-4555-8555-555555555551'
          AND c.status = 'REVIEW_REQUIRED'
          AND c.match_status = 'AUTO_MATCHED'
          AND c.initial_validation_status = 'INCONCLUSIVE'
          AND c.version = 2
          AND v.id = '66666666-6666-4666-8666-666666666661'
          AND v.run_number = 1
          AND v.status = 'INCONCLUSIVE'
          AND v.evidence_snapshot #>> '{result,reasonCode}'
              = 'CANARY_CONTROLLED_INCONCLUSIVE'
    ) THEN
        RAISE EXCEPTION 'LIVE-002 controlled Placement review precondition is missing or changed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM backlink_placements
        WHERE candidate_id = '55555555-5555-4555-8555-555555555551'
    ) OR EXISTS (
        SELECT 1
        FROM backlink_outbox_events
        WHERE aggregate_id = '55555555-5555-4555-8555-555555555551'
    ) THEN
        RAISE EXCEPTION 'LIVE-002 final Placement or Outbox fact already exists';
    END IF;
END
$seed$;

RESET ROLE;
COMMIT;

SELECT json_build_object(
    'organizationId', '11111111-1111-4111-8111-111111111111',
    'workspaceA', '22222222-2222-4222-8222-222222222222',
    'projectA', '33333333-3333-4333-8333-333333333333',
    'candidateId', '55555555-5555-4555-8555-555555555551',
    'initialValidationId', '66666666-6666-4666-8666-666666666661',
    'workspaceB', '22222222-2222-4222-8222-222222222223',
    'projectB', '33333333-3333-4333-8333-333333333334'
) AS live002_seed;
'@

foreach ($entry in $replacements.GetEnumerator()) {
    $sql = $sql.Replace($entry.Key, $entry.Value.Replace("'", "''"))
}

$container = docker inspect -f "{{.State.Running}}" $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $container.Trim() -ne "true") {
    throw "PostgreSQL container $PostgresContainer is not running"
}

$output = $sql |
    docker exec -i $PostgresContainer psql -X -A -t `
        -v ON_ERROR_STOP=1 -U postgres -d growthos_live001
if ($LASTEXITCODE -ne 0) {
    throw "LIVE-002 controlled Canary Seed failed"
}

$output | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Last 1
