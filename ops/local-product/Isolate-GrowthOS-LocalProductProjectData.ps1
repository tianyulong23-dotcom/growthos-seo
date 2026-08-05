param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres",
    [string]$DatabaseName = "growthos_live001",
    [string]$ProjectKey = "elephtv",
    [string]$ProjectName = "ElephTV",
    [string]$ProjectDomain = "elephtv.com",
    [string]$Locale = "en-US",
    [string]$CountryCode = "US",
    [string]$Language = "en"
)

$ErrorActionPreference = "Stop"

function Require-Text([object]$Value, [string]$Name) {
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "LOCAL_REAL_001_REQUIRED_VALUE_MISSING:$Name"
    }
    return $text.Trim()
}

function Quote-SqlLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-Psql([string]$Sql) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(
            & docker exec $PostgresContainer psql `
                -X `
                -U postgres `
                -d $DatabaseName `
                -v ON_ERROR_STOP=1 `
                -At `
                -c $Sql 2>&1
        )
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "LOCAL_REAL_001_POSTGRES_COMMAND_FAILED:$exitCode"
    }
    return @($output | ForEach-Object { [string]$_ })
}

function Invoke-DockerChecked([string[]]$Arguments) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & docker @Arguments 2>&1 | Out-Null
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "LOCAL_REAL_001_DOCKER_COMMAND_FAILED:$exitCode"
    }
}

function Get-ScopedTableCounts(
    [string]$OrganizationId,
    [string]$WorkspaceId,
    [string]$WebsiteProjectId
) {
    $tables = Invoke-Psql @"
SELECT table_schema || '.' || table_name
FROM information_schema.columns
WHERE table_schema = 'backlinks'
  AND column_name IN (
    'organization_id',
    'workspace_id',
    'website_project_id'
  )
GROUP BY table_schema, table_name
HAVING count(DISTINCT column_name) = 3
ORDER BY table_schema, table_name;
"@
    $counts = foreach ($table in $tables) {
        if ($table -notmatch '^backlinks\.[a-z0-9_]+$') {
            throw "LOCAL_REAL_001_UNSAFE_TABLE_NAME:$table"
        }
        $count = Invoke-Psql @"
SELECT count(*)
FROM $table
WHERE organization_id = $(Quote-SqlLiteral $OrganizationId)::uuid
  AND workspace_id = $(Quote-SqlLiteral $WorkspaceId)::uuid
  AND website_project_id = $(Quote-SqlLiteral $WebsiteProjectId)::uuid;
"@
        [pscustomobject]@{
            table = $table
            rows = [int64]($count | Select-Object -Last 1)
        }
    }
    return @($counts)
}

function Set-JsonProperty(
    [object]$Object,
    [string]$Name,
    [object]$Value
) {
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
        return
    }
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
}

function Get-MaskedId([string]$Prefix, [string]$Value) {
    if ($Value.Length -lt 8) {
        throw "LOCAL_REAL_001_ID_TOO_SHORT:$Prefix"
    }
    return (
        "$Prefix-" +
        $Value.Substring(0, 4) +
        "..." +
        $Value.Substring($Value.Length - 4)
    )
}

function Write-Utf8Json([string]$Path, [object]$Value) {
    $json = $Value | ConvertTo-Json -Depth 16
    [System.IO.File]::WriteAllText(
        $Path,
        $json,
        [System.Text.UTF8Encoding]::new($false)
    )
}

$ProjectKey = Require-Text $ProjectKey "ProjectKey"
$ProjectName = Require-Text $ProjectName "ProjectName"
$ProjectDomain = (Require-Text $ProjectDomain "ProjectDomain").ToLowerInvariant()
$Locale = Require-Text $Locale "Locale"
$CountryCode = (Require-Text $CountryCode "CountryCode").ToUpperInvariant()
$Language = (Require-Text $Language "Language").ToLowerInvariant()

if ($ProjectKey -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "LOCAL_REAL_001_PROJECT_KEY_INVALID"
}
if (
    $ProjectDomain -notmatch "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$" `
    -or $ProjectDomain -match "(?:^|\.)example\.invalid$"
) {
    throw "LOCAL_REAL_001_REAL_PROJECT_DOMAIN_INVALID"
}

$listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object LocalPort -In 5173, 7200, 7301
)
if ($listeners.Count -gt 0) {
    throw "LOCAL_REAL_001_PRODUCT_MUST_BE_STOPPED"
}

$containerHealth = docker inspect `
    --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
    $PostgresContainer 2>$null
if ($LASTEXITCODE -ne 0 -or $containerHealth -ne "healthy") {
    throw "LOCAL_REAL_001_POSTGRES_NOT_HEALTHY"
}

$identityPath = Join-Path $RuntimeRoot "identity.json"
if (-not (Test-Path -LiteralPath $identityPath)) {
    throw "LOCAL_REAL_001_IDENTITY_NOT_FOUND"
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "LOCAL_REAL_001_MANIFEST_NOT_FOUND"
}

$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json

$organizationId = Require-Text $identity.organizationId `
    "identity.organizationId"
$currentWorkspaceId = Require-Text $identity.workspaceId `
    "identity.workspaceId"
$currentProjectId = Require-Text $identity.websiteProjectId `
    "identity.websiteProjectId"
foreach ($idValue in @(
    $organizationId,
    $currentWorkspaceId,
    $currentProjectId
)) {
    if ($idValue -notmatch "^[0-9a-fA-F-]{36}$") {
        throw "LOCAL_REAL_001_IDENTITY_UUID_INVALID"
    }
}

$backupDirectory = Join-Path $RuntimeRoot "backups"
[System.IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $backupDirectory `
    "LOCAL-REAL-001-$timestamp.dump"
$containerBackupPath = "/tmp/local-real-001-$timestamp.dump"

Invoke-DockerChecked @(
    "exec",
    $PostgresContainer,
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    $DatabaseName,
    "--format=custom",
    "--file=$containerBackupPath"
)
Invoke-DockerChecked @(
    "exec",
    $PostgresContainer,
    "pg_restore",
    "--list",
    $containerBackupPath
)
Invoke-DockerChecked @(
    "cp",
    "${PostgresContainer}:$containerBackupPath",
    $backupPath
)
if (
    -not (Test-Path -LiteralPath $backupPath) `
    -or (Get-Item -LiteralPath $backupPath).Length -le 0
) {
    throw "LOCAL_REAL_001_BACKUP_COPY_INVALID"
}

$archivedCounts = Get-ScopedTableCounts `
    $organizationId `
    $currentWorkspaceId `
    $currentProjectId
$currentState = (
    Invoke-Psql @"
SELECT concat_ws(
  E'\t',
  p.name,
  p.domain,
  COALESCE((
    SELECT s.created_by
    FROM backlinks.backlink_project_context_snapshots AS s
    WHERE s.organization_id = $(Quote-SqlLiteral $organizationId)::uuid
      AND s.workspace_id = $(Quote-SqlLiteral $currentWorkspaceId)::uuid
      AND s.website_project_id = $(Quote-SqlLiteral $currentProjectId)::uuid
    ORDER BY s.snapshot_version DESC
    LIMIT 1
  ), '')
)
FROM platform.projects AS p
WHERE p.organization_id = $(Quote-SqlLiteral $organizationId)
  AND p.id = $(Quote-SqlLiteral $currentProjectId);
"@ | Select-Object -Last 1
)
if ([string]::IsNullOrWhiteSpace($currentState)) {
    throw "LOCAL_REAL_001_CURRENT_PROJECT_NOT_FOUND"
}
$stateParts = $currentState.Split("`t")
$alreadyIsolated = (
    $stateParts.Count -ge 3 `
    -and $stateParts[0] -eq $ProjectName `
    -and $stateParts[1] -eq $ProjectDomain `
    -and $stateParts[2] -eq "local-real-001-project-isolation"
)

if ($alreadyIsolated) {
    $newWorkspaceId = $currentWorkspaceId
    $newProjectId = $currentProjectId
    $archivedWorkspaceId = $null
    $archivedProjectId = $null
}
else {
    $newWorkspaceId = [guid]::NewGuid().ToString()
    $newProjectId = [guid]::NewGuid().ToString()
    $newSnapshotId = [guid]::NewGuid().ToString()
    $archiveName = "LIVE-001 Canary Archive"
    $archiveDomain = "live001-canary.example.invalid"

    Invoke-Psql @"
BEGIN;
LOCK TABLE platform.projects IN SHARE ROW EXCLUSIVE MODE;

DO `$guard`$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM platform.projects
    WHERE organization_id = $(Quote-SqlLiteral $organizationId)
      AND id = $(Quote-SqlLiteral $currentProjectId)
      AND name = $(Quote-SqlLiteral $ProjectName)
      AND domain = $(Quote-SqlLiteral $ProjectDomain)
  ) THEN
    RAISE EXCEPTION 'LOCAL_REAL_001_CURRENT_PROJECT_CHANGED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM platform.projects
    WHERE organization_id = $(Quote-SqlLiteral $organizationId)
      AND domain = $(Quote-SqlLiteral $archiveDomain)
      AND id <> $(Quote-SqlLiteral $currentProjectId)
  ) THEN
    RAISE EXCEPTION 'LOCAL_REAL_001_ARCHIVE_DOMAIN_CONFLICT';
  END IF;
END
`$guard`$;

UPDATE platform.projects
SET name = $(Quote-SqlLiteral $archiveName),
    domain = $(Quote-SqlLiteral $archiveDomain),
    health = 0,
    updated_at = now()
WHERE organization_id = $(Quote-SqlLiteral $organizationId)
  AND id = $(Quote-SqlLiteral $currentProjectId);

INSERT INTO platform.projects (
  id,
  organization_id,
  name,
  domain,
  country,
  language,
  health
) VALUES (
  $(Quote-SqlLiteral $newProjectId),
  $(Quote-SqlLiteral $organizationId),
  $(Quote-SqlLiteral $ProjectName),
  $(Quote-SqlLiteral $ProjectDomain),
  $(Quote-SqlLiteral $CountryCode),
  $(Quote-SqlLiteral $Language),
  100
);

SET LOCAL ROLE growthos_backlinks_canary;
SELECT set_config(
  'app.current_organization_id',
  $(Quote-SqlLiteral $organizationId),
  true
);
SELECT set_config(
  'app.current_workspace_id',
  $(Quote-SqlLiteral $newWorkspaceId),
  true
);
SELECT set_config(
  'app.current_website_project_id',
  $(Quote-SqlLiteral $newProjectId),
  true
);

INSERT INTO backlinks.backlink_project_context_snapshots (
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
) VALUES (
  $(Quote-SqlLiteral $newSnapshotId)::uuid,
  $(Quote-SqlLiteral $organizationId)::uuid,
  $(Quote-SqlLiteral $newWorkspaceId)::uuid,
  $(Quote-SqlLiteral $newProjectId)::uuid,
  1,
  'ACTIVE',
  $(Quote-SqlLiteral $ProjectDomain),
  $(Quote-SqlLiteral $Locale),
  $(Quote-SqlLiteral $CountryCode),
  'elephtv-profile-v1',
  'elephtv-home-v1',
  'local-real-001-project-isolation'
);

COMMIT;
"@ | Out-Null

    $archivedWorkspaceId = $currentWorkspaceId
    $archivedProjectId = $currentProjectId
}

Set-JsonProperty $identity "environment" "local-product"
Set-JsonProperty $identity "organizationId" $organizationId
Set-JsonProperty $identity "workspaceId" $newWorkspaceId
Set-JsonProperty $identity "websiteProjectId" $newProjectId
Set-JsonProperty $identity "websiteProjectKey" $ProjectKey
Set-JsonProperty $identity "userId" "local-product-operator"
if (-not $alreadyIsolated) {
    Set-JsonProperty $identity `
        "sessionId" `
        "local-product-session-$timestamp"
}
Set-JsonProperty $identity "websiteProjectName" $ProjectName
Set-JsonProperty $identity "websiteProjectDomain" $ProjectDomain

$manifest.runtime.mode = "LOCAL_PRODUCT"
$manifest.runtime.publicBaseUrl = "http://localhost:7200"
$manifest.runtime.websiteProjectKey = $ProjectKey
$manifest.runtime.organizationMaskedId = Get-MaskedId "org" $organizationId
$manifest.runtime.workspaceMaskedId = Get-MaskedId "ws" $newWorkspaceId

Write-Utf8Json $identityPath $identity
Write-Utf8Json $ManifestPath $manifest

$activeCounts = Get-ScopedTableCounts `
    $organizationId `
    $newWorkspaceId `
    $newProjectId
$unexpectedActiveRows = @(
    $activeCounts |
        Where-Object {
            (
                $_.table -eq
                    "backlinks.backlink_project_context_snapshots" `
                -and $_.rows -ne 1
            ) `
            -or (
                $_.table -ne
                    "backlinks.backlink_project_context_snapshots" `
                -and $_.rows -ne 0
            )
        }
)
if ($unexpectedActiveRows.Count -gt 0) {
    throw "LOCAL_REAL_001_NEW_PROJECT_NOT_CLEAN"
}

$result = [pscustomobject]@{
    status = if ($alreadyIsolated) { "already_isolated" } else { "isolated" }
    isolatedAt = Get-Date -Format o
    backup = [pscustomobject]@{
        path = $backupPath
        format = "postgres-custom"
        validated = $true
        bytes = (Get-Item -LiteralPath $backupPath).Length
    }
    archivedContext = [pscustomobject]@{
        workspaceId = $archivedWorkspaceId
        websiteProjectId = $archivedProjectId
        tableCounts = $archivedCounts
    }
    activeContext = [pscustomobject]@{
        organizationId = $organizationId
        workspaceId = $newWorkspaceId
        websiteProjectId = $newProjectId
        websiteProjectKey = $ProjectKey
        name = $ProjectName
        domain = $ProjectDomain
        tableCounts = $activeCounts
    }
    providerCalls = [pscustomobject]@{
        dataForSeo = $false
        ai = $false
        gmail = $false
    }
}
$receiptPath = Join-Path $RuntimeRoot "local-real-001-isolation.json"
Write-Utf8Json $receiptPath $result
$result | ConvertTo-Json -Depth 16
