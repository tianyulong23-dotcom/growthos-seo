param(
    [Parameter(Mandatory = $true)]
    [string]$ProspectHostname,
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres"
)

$ErrorActionPreference = "Stop"

function Require-Text($Value, [string]$Name) {
    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        throw "LOCAL_PRODUCT_RECOMMENDATION_INPUT_MISSING:${Name}"
    }
    return ([string]$Value).Trim()
}

function Invoke-Postgres([string]$Sql) {
    $output = $Sql | docker exec -i $PostgresContainer `
        psql -X -v ON_ERROR_STOP=1 -U postgres -d growthos_live001 -At
    if ($LASTEXITCODE -ne 0) {
        throw "LOCAL_PRODUCT_RECOMMENDATION_DATABASE_UPDATE_FAILED"
    }
    return @($output)
}

$ProspectHostname = (
    Require-Text $ProspectHostname "ProspectHostname"
).ToLowerInvariant()
if (
    $ProspectHostname -notmatch
        "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
) {
    throw "LOCAL_PRODUCT_RECOMMENDATION_HOSTNAME_INVALID"
}
if (
    $ProspectHostname -match "(?i)(?:^|\.)example\.invalid$" -or
    $ProspectHostname -match "(?i)canary"
) {
    throw "LOCAL_PRODUCT_RECOMMENDATION_CANARY_HOSTNAME_FORBIDDEN"
}

$identityPath = Join-Path $RuntimeRoot "identity.json"
if (-not (Test-Path -LiteralPath $identityPath)) {
    throw "LOCAL_PRODUCT_IDENTITY_NOT_FOUND"
}
$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$organizationId = Require-Text $identity.organizationId `
    "identity.organizationId"
$workspaceId = Require-Text $identity.workspaceId "identity.workspaceId"
$websiteProjectId = Require-Text $identity.websiteProjectId `
    "identity.websiteProjectId"

foreach ($id in @($organizationId, $workspaceId, $websiteProjectId)) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($id, [ref]$parsed)) {
        throw "LOCAL_PRODUCT_RECOMMENDATION_IDENTITY_INVALID"
    }
}

$containerHealth = docker inspect `
    --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
    $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $containerHealth -ne "healthy") {
    throw "LOCAL_PRODUCT_POSTGRES_NOT_HEALTHY"
}

$labels = $ProspectHostname.Split(".")
$registrableDomain = (
    $labels[($labels.Length - 2)..($labels.Length - 1)] -join "."
)
$escapedHostname = $ProspectHostname.Replace("'", "''")
$escapedRegistrableDomain = $registrableDomain.Replace("'", "''")
$prospectId = [guid]::NewGuid().ToString()
$recommendationId = [guid]::NewGuid().ToString()
$scoreId = [guid]::NewGuid().ToString()
$inventoryId = [guid]::NewGuid().ToString()

$sql = @"
\set ON_ERROR_STOP on
BEGIN;

SET LOCAL ROLE growthos_backlinks_canary;
SET LOCAL row_security = on;
SET LOCAL search_path = backlinks, pg_catalog;

SELECT set_config(
    'app.current_organization_id',
    '$organizationId',
    true
);
SELECT set_config(
    'app.current_workspace_id',
    '$workspaceId',
    true
);
SELECT set_config(
    'app.current_website_project_id',
    '$websiteProjectId',
    true
);
SELECT pg_advisory_xact_lock(
    hashtextextended(
        '${workspaceId}:${websiteProjectId}:${escapedHostname}:local-product-recommendation',
        0
    )
);

WITH latest_context AS (
    SELECT id
      FROM backlink_project_context_snapshots
     WHERE organization_id = '$organizationId'
       AND workspace_id = '$workspaceId'
       AND website_project_id = '$websiteProjectId'
       AND project_status = 'ACTIVE'
     ORDER BY snapshot_version DESC
     LIMIT 1
),
inserted AS (
    INSERT INTO backlink_prospects (
        id,
        organization_id,
        workspace_id,
        website_project_id,
        recommendation_context_version_id,
        hostname_ascii,
        registrable_domain,
        normalization_version,
        created_by,
        updated_by
    )
    SELECT
        '$prospectId',
        '$organizationId',
        '$workspaceId',
        '$websiteProjectId',
        latest_context.id,
        '$escapedHostname',
        '$escapedRegistrableDomain',
        'local-product-hostname-v1',
        'local-product-recommendation-initializer',
        'local-product-recommendation-initializer'
      FROM latest_context
    ON CONFLICT (
        organization_id,
        workspace_id,
        website_project_id,
        recommendation_context_version_id,
        hostname_ascii
    ) DO NOTHING
    RETURNING id
)
SELECT count(*) FROM inserted;

WITH prospect AS (
    SELECT id, recommendation_context_version_id
      FROM backlink_prospects
     WHERE organization_id = '$organizationId'
       AND workspace_id = '$workspaceId'
       AND website_project_id = '$websiteProjectId'
       AND hostname_ascii = '$escapedHostname'
     ORDER BY created_at DESC
     LIMIT 1
)
INSERT INTO backlink_recommendations (
    id,
    organization_id,
    workspace_id,
    website_project_id,
    prospect_id,
    recommendation_context_version_id,
    status,
    created_by,
    updated_by
)
SELECT
    '$recommendationId',
    '$organizationId',
    '$workspaceId',
    '$websiteProjectId',
    prospect.id,
    prospect.recommendation_context_version_id,
    'shown',
    'local-product-recommendation-initializer',
    'local-product-recommendation-initializer'
  FROM prospect
ON CONFLICT (
    organization_id,
    workspace_id,
    website_project_id,
    prospect_id,
    recommendation_context_version_id
) DO NOTHING;

WITH recommendation AS (
    SELECT
        recommendation.id,
        recommendation.prospect_id,
        recommendation.recommendation_context_version_id
      FROM backlink_recommendations AS recommendation
      JOIN backlink_prospects AS prospect
        ON (
            prospect.organization_id,
            prospect.workspace_id,
            prospect.website_project_id,
            prospect.id
        ) = (
            recommendation.organization_id,
            recommendation.workspace_id,
            recommendation.website_project_id,
            recommendation.prospect_id
        )
     WHERE recommendation.organization_id = '$organizationId'
       AND recommendation.workspace_id = '$workspaceId'
       AND recommendation.website_project_id = '$websiteProjectId'
       AND prospect.hostname_ascii = '$escapedHostname'
     ORDER BY recommendation.created_at DESC
     LIMIT 1
)
INSERT INTO backlink_recommendation_scores (
    id,
    organization_id,
    workspace_id,
    website_project_id,
    recommendation_id,
    prospect_id,
    recommendation_context_version_id,
    score_model_version,
    rule_version,
    total_score,
    components,
    weights,
    evidence,
    generated_at,
    created_by
)
SELECT
    '$scoreId',
    '$organizationId',
    '$workspaceId',
    '$websiteProjectId',
    recommendation.id,
    recommendation.prospect_id,
    recommendation.recommendation_context_version_id,
    'local-product-manual.v1',
    'local-product-manual.v1',
    50,
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_object(
        'sourceEvidenceIds',
        jsonb_build_array('local-product:manual-recommendation'),
        'sourceReleaseId',
        'local-product-manual-v1'
    ),
    now(),
    'local-product-recommendation-initializer'
  FROM recommendation
 WHERE NOT EXISTS (
    SELECT 1
      FROM backlink_recommendation_scores AS existing
     WHERE existing.organization_id = '$organizationId'
       AND existing.workspace_id = '$workspaceId'
       AND existing.website_project_id = '$websiteProjectId'
       AND existing.recommendation_id = recommendation.id
);

WITH recommendation AS (
    SELECT
        recommendation.id,
        recommendation.prospect_id,
        recommendation.recommendation_context_version_id
      FROM backlink_recommendations AS recommendation
      JOIN backlink_prospects AS prospect
        ON (
            prospect.organization_id,
            prospect.workspace_id,
            prospect.website_project_id,
            prospect.id
        ) = (
            recommendation.organization_id,
            recommendation.workspace_id,
            recommendation.website_project_id,
            recommendation.prospect_id
        )
     WHERE recommendation.organization_id = '$organizationId'
       AND recommendation.workspace_id = '$workspaceId'
       AND recommendation.website_project_id = '$websiteProjectId'
       AND prospect.hostname_ascii = '$escapedHostname'
     ORDER BY recommendation.created_at DESC
     LIMIT 1
)
INSERT INTO backlink_recommendation_inventory (
    id,
    organization_id,
    workspace_id,
    website_project_id,
    recommendation_id,
    prospect_id,
    recommendation_context_version_id,
    status,
    created_by,
    updated_by
)
SELECT
    '$inventoryId',
    '$organizationId',
    '$workspaceId',
    '$websiteProjectId',
    recommendation.id,
    recommendation.prospect_id,
    recommendation.recommendation_context_version_id,
    'ready',
    'local-product-recommendation-initializer',
    'local-product-recommendation-initializer'
  FROM recommendation
ON CONFLICT (
    organization_id,
    workspace_id,
    website_project_id,
    recommendation_id,
    recommendation_context_version_id
) DO NOTHING;

UPDATE backlink_recommendation_inventory AS inventory
   SET status = 'ready',
       updated_at = now(),
       updated_by = 'local-product-recommendation-initializer'
  FROM backlink_recommendations AS recommendation
  JOIN backlink_prospects AS prospect
    ON (
        prospect.organization_id,
        prospect.workspace_id,
        prospect.website_project_id,
        prospect.id
    ) = (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.prospect_id
    )
 WHERE (
        inventory.organization_id,
        inventory.workspace_id,
        inventory.website_project_id,
        inventory.recommendation_id
    ) = (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.id
    )
   AND inventory.organization_id = '$organizationId'
   AND inventory.workspace_id = '$workspaceId'
   AND inventory.website_project_id = '$websiteProjectId'
   AND inventory.status = 'shown'
   AND inventory.created_by = 'local-product-recommendation-initializer'
   AND prospect.hostname_ascii = '$escapedHostname';

SELECT json_build_object(
    'recommendationId',
    recommendation.id,
    'recommendationVersion',
    inventory.version,
    'inventoryStatus',
    inventory.status,
    'prospectId',
    prospect.id,
    'prospectHostname',
    prospect.hostname_ascii,
    'recommendationContextVersionId',
    recommendation.recommendation_context_version_id
)::text
  FROM backlink_recommendations AS recommendation
  JOIN backlink_prospects AS prospect
    ON (
        prospect.organization_id,
        prospect.workspace_id,
        prospect.website_project_id,
        prospect.id
    ) = (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.prospect_id
    )
  JOIN backlink_recommendation_inventory AS inventory
    ON (
        inventory.organization_id,
        inventory.workspace_id,
        inventory.website_project_id,
        inventory.recommendation_id
    ) = (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.id
    )
 WHERE recommendation.organization_id = '$organizationId'
   AND recommendation.workspace_id = '$workspaceId'
   AND recommendation.website_project_id = '$websiteProjectId'
   AND prospect.hostname_ascii = '$escapedHostname'
 ORDER BY recommendation.created_at DESC
 LIMIT 1;

COMMIT;
"@

$output = Invoke-Postgres $sql
$resultLine = $output |
    Where-Object { $_ -match '^\s*\{' -and $_ -match '"recommendationId"' } |
    Select-Object -Last 1
if ($null -eq $resultLine) {
    throw "LOCAL_PRODUCT_RECOMMENDATION_RESULT_MISSING"
}
$result = $resultLine | ConvertFrom-Json
[pscustomobject]@{
    status = "ok"
    recommendationId = $result.recommendationId
    recommendationVersion = $result.recommendationVersion
    inventoryStatus = $result.inventoryStatus
    prospectId = $result.prospectId
    prospectHostname = $result.prospectHostname
    recommendationContextVersionId = $result.recommendationContextVersionId
    providerCalls = 0
}
