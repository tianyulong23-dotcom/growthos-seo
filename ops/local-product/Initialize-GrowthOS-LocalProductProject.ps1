param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres",
    [string]$ProjectKey = "elephtv",
    [string]$ProjectName = "ElephTV",
    [string]$ProjectDomain = "elephtv.com",
    [string]$Locale = "en-US",
    [string]$CountryCode = "US",
    [string]$Language = "en"
)

$ErrorActionPreference = "Stop"

function Require-Text($Value, [string]$Name) {
    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        throw "LOCAL_PRODUCT_PROJECT_INPUT_MISSING:$Name"
    }
    return ([string]$Value).Trim()
}

function Write-Utf8Json([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $json = $Value | ConvertTo-Json -Depth 16
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        $json,
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Invoke-Postgres([string]$Sql) {
    $output = $Sql | docker exec -i $PostgresContainer `
        psql -X -v ON_ERROR_STOP=1 -U postgres -d growthos_live001 -At
    if ($LASTEXITCODE -ne 0) {
        throw "LOCAL_PRODUCT_PROJECT_DATABASE_UPDATE_FAILED"
    }
    return @($output)
}

$ProjectKey = Require-Text $ProjectKey "ProjectKey"
$ProjectName = Require-Text $ProjectName "ProjectName"
$ProjectDomain = (
    Require-Text $ProjectDomain "ProjectDomain"
).ToLowerInvariant()
$Locale = Require-Text $Locale "Locale"
$CountryCode = (Require-Text $CountryCode "CountryCode").ToUpperInvariant()
$Language = (Require-Text $Language "Language").ToLowerInvariant()

if ($ProjectKey -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "LOCAL_PRODUCT_PROJECT_KEY_INVALID"
}
if (
    $ProjectKey -match "(?i)(?:^live\d|canary)" -or
    $ProjectName -match "(?i)canary" -or
    $ProjectDomain -match "(?i)(?:^|\.)example\.invalid$"
) {
    throw "LOCAL_PRODUCT_CANARY_IDENTITY_FORBIDDEN"
}
if (
    $ProjectDomain -notmatch
        "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
) {
    throw "LOCAL_PRODUCT_PROJECT_DOMAIN_INVALID"
}
if ($CountryCode -notmatch "^[A-Z]{2}$") {
    throw "LOCAL_PRODUCT_PROJECT_COUNTRY_INVALID"
}

$identityPath = Join-Path $RuntimeRoot "identity.json"
if (-not (Test-Path -LiteralPath $identityPath)) {
    throw "LOCAL_PRODUCT_IDENTITY_NOT_FOUND"
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "LOCAL_PRODUCT_AUTH_MANIFEST_NOT_FOUND"
}

$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json

$organizationId = Require-Text $identity.organizationId `
    "identity.organizationId"
$workspaceId = Require-Text $identity.workspaceId "identity.workspaceId"
$websiteProjectId = Require-Text $identity.websiteProjectId `
    "identity.websiteProjectId"
$existingProjectKey = Require-Text $identity.websiteProjectKey `
    "identity.websiteProjectKey"

foreach ($id in @($organizationId, $workspaceId, $websiteProjectId)) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($id, [ref]$parsed)) {
        throw "LOCAL_PRODUCT_PROJECT_IDENTITY_INVALID"
    }
}

$containerHealth = docker inspect `
    --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
    $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $containerHealth -ne "healthy") {
    throw "LOCAL_PRODUCT_POSTGRES_NOT_HEALTHY"
}

$escapedName = $ProjectName.Replace("'", "''")
$escapedDomain = $ProjectDomain.Replace("'", "''")
$escapedLocale = $Locale.Replace("'", "''")
$escapedCountry = $CountryCode.Replace("'", "''")
$escapedLanguage = $Language.Replace("'", "''")
$profileVersionId = "$ProjectKey-profile-v1".Replace("'", "''")
$promotionTargetVersionId = "$ProjectKey-home-v1".Replace("'", "''")
$snapshotId = [guid]::NewGuid().ToString()

$sql = @"
\set ON_ERROR_STOP on
BEGIN;

DO `$guard`$
DECLARE
    current_name text;
    current_domain text;
BEGIN
    SELECT name, domain
      INTO current_name, current_domain
      FROM platform.projects
     WHERE id = '$websiteProjectId'
       AND organization_id = '$organizationId'
     FOR UPDATE;

    IF current_domain IS NULL THEN
        RAISE EXCEPTION 'LOCAL_PRODUCT_PROJECT_NOT_FOUND';
    END IF;

    IF current_domain NOT IN (
        'live001-canary.example.invalid',
        '$escapedDomain'
    ) THEN
        RAISE EXCEPTION 'LOCAL_PRODUCT_PROJECT_IDENTITY_GUARD_FAILED';
    END IF;

    IF current_name NOT IN ('LIVE-001 Canary', '$escapedName') THEN
        RAISE EXCEPTION 'LOCAL_PRODUCT_PROJECT_NAME_GUARD_FAILED';
    END IF;
END
`$guard`$;

UPDATE platform.projects
   SET name = '$escapedName',
       domain = '$escapedDomain',
       country = '$escapedCountry',
       workspace_id = '$workspaceId',
       project_key = '$ProjectKey',
       target_market = COALESCE(NULLIF(target_market, ''), '$escapedCountry'),
       language = '$escapedLanguage',
       updated_at = now()
 WHERE id = '$websiteProjectId'
   AND organization_id = '$organizationId';

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

INSERT INTO backlink_project_context_snapshots (
    id,
    organization_id,
    workspace_id,
    website_project_id,
    snapshot_version,
    project_status,
    canonical_domain,
    locale,
    country_code,
    profile_version_id,
    promotion_target_version_id,
    created_by
)
SELECT
    '$snapshotId',
    '$organizationId',
    '$workspaceId',
    '$websiteProjectId',
    COALESCE(MAX(snapshot_version), 0) + 1,
    'ACTIVE',
    '$escapedDomain',
    '$escapedLocale',
    '$escapedCountry',
    '$profileVersionId',
    '$promotionTargetVersionId',
    'local-product-project-initializer'
FROM backlink_project_context_snapshots
HAVING COALESCE(
    (
        array_agg(
            canonical_domain
            ORDER BY snapshot_version DESC
        )
    )[1],
    ''
) <> '$escapedDomain';

COMMIT;
"@

[void](Invoke-Postgres $sql)

$identity.websiteProjectKey = $ProjectKey
if ($identity.PSObject.Properties.Name -contains "websiteProjectName") {
    $identity.websiteProjectName = $ProjectName
}
else {
    $identity | Add-Member -NotePropertyName websiteProjectName `
        -NotePropertyValue $ProjectName
}
if ($identity.PSObject.Properties.Name -contains "websiteProjectDomain") {
    $identity.websiteProjectDomain = $ProjectDomain
}
else {
    $identity | Add-Member -NotePropertyName websiteProjectDomain `
        -NotePropertyValue $ProjectDomain
}

$publicBaseUrl = "http://localhost:7200"
$redirectUri = "$publicBaseUrl/api/v1/backlinks/gmail-connections/callback"
$manifest.runtime.mode = "LOCAL_PRODUCT"
$manifest.runtime.publicBaseUrl = $publicBaseUrl
$manifest.runtime.websiteProjectKey = $ProjectKey
$manifest.google.redirectUri = $redirectUri

Write-Utf8Json $identityPath $identity
Write-Utf8Json $ManifestPath $manifest

[pscustomobject]@{
    status = "ok"
    websiteProjectId = $websiteProjectId
    previousProjectKey = $existingProjectKey
    websiteProjectKey = $ProjectKey
    websiteProjectName = $ProjectName
    websiteProjectDomain = $ProjectDomain
    redirectUri = $redirectUri
    projectIdentityPreserved = $true
}
