[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$PostgresImage = "postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
$UvImage = "ghcr.io/astral-sh/uv:python3.13-bookworm-slim"
$Suffix = [Guid]::NewGuid().ToString("N").Substring(0, 10)
$ContainerName = "seo4-int-004-pg-$Suffix"
$NetworkName = "seo4-int-004-net-$Suffix"
$ContainerLabel = "growthos.task=SEO4-INT-004"

$BootstrapPath = Join-Path $RepositoryRoot "backend\database\roles\0001_growthos_schema_roles.sql"
$BacklinksMigrationPath = Join-Path $RepositoryRoot "backend\core\src\modules\backlinks\db\migrations"

function Assert-LastExitCode {
    param([string]$Operation)

    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Docker {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Operation
    )

    & docker @Arguments
    Assert-LastExitCode $Operation
}

function Invoke-PsqlCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database,
        [Parameter(Mandatory = $true)]
        [string]$Sql
    )

    Invoke-Docker -Operation "psql command on $Database" -Arguments @(
        "exec", $ContainerName,
        "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", $Database,
        "-c", $Sql
    )
}

function Invoke-PsqlFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    Get-Content -LiteralPath $Path -Raw |
        & docker exec -i $ContainerName psql -v ON_ERROR_STOP=1 -U postgres -d $Database
    Assert-LastExitCode "psql file $Path on $Database"
}

function Invoke-Alembic {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database,
        [Parameter(Mandatory = $true)]
        [string]$Revision
    )

    $DatabaseUrl = "postgresql+psycopg://postgres:postgres@${ContainerName}:5432/$Database"
    Invoke-Docker -Operation "Alembic upgrade $Revision on $Database" -Arguments @(
        "run", "--rm",
        "--network", $NetworkName,
        "-e", "DATABASE_URL=$DatabaseUrl",
        "-e", "UV_PROJECT_ENVIRONMENT=/tmp/venv",
        "-e", "UV_CACHE_DIR=/tmp/uv-cache",
        "-e", "UV_HTTP_TIMEOUT=600",
        "-e", "UV_CONCURRENT_DOWNLOADS=1",
        "-v", "${RepositoryRoot}:/workspace:ro",
        "-w", "/workspace/backend/api",
        $UvImage,
        "uv", "run", "--frozen", "alembic", "upgrade", $Revision
    )
}

function Invoke-BacklinksMigrations {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database,
        [Parameter(Mandatory = $true)]
        [int]$First,
        [Parameter(Mandatory = $true)]
        [int]$Last
    )

    Get-ChildItem -LiteralPath $BacklinksMigrationPath -Filter "*.sql" |
        Sort-Object Name |
        Where-Object {
            $Number = [int]$_.BaseName.Substring(0, 4)
            $Number -ge $First -and $Number -le $Last
        } |
        ForEach-Object {
            Invoke-PsqlFile -Database $Database -Path $_.FullName
        }
}

function Invoke-IntegratedParallelBlockMigrations {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database
    )

    Invoke-BacklinksMigrations -Database $Database -First 12 -Last 16
    Invoke-PsqlFile -Database $Database -Path (
        Join-Path $BacklinksMigrationPath "0022_backlink_draft_documents.sql"
    )
    Invoke-PsqlFile -Database $Database -Path (
        Join-Path $BacklinksMigrationPath "0023_backlink_send_quota_connection_scope.sql"
    )
    Invoke-PsqlFile -Database $Database -Path (
        Join-Path $BacklinksMigrationPath "0024_backlink_send_attempt_settlement.sql"
    )
    Invoke-PsqlFile -Database $Database -Path (
        Join-Path $BacklinksMigrationPath "0025_backlink_send_reconciliation.sql"
    )
    Invoke-PsqlFile -Database $Database -Path (
        Join-Path $BacklinksMigrationPath "0026_backlink_suppression_feedback.sql"
    )
    Invoke-PsqlFile -Database $Database -Path (
        Join-Path $BacklinksMigrationPath "0027_backlink_negotiation_facts.sql"
    )
    Invoke-BacklinksMigrations -Database $Database -First 28 -Last 42
}

function Invoke-DatabaseContract {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database
    )

    $DatabaseUrl = "postgresql://postgres:postgres@${ContainerName}:5432/$Database"
    Invoke-Docker -Operation "PostgreSQL 18 contract on $Database" -Arguments @(
        "run", "--rm",
        "--network", $NetworkName,
        "-e", "SEO4_INT_004_DATABASE_URL=$DatabaseUrl",
        "-e", "UV_PROJECT_ENVIRONMENT=/tmp/venv",
        "-e", "UV_CACHE_DIR=/tmp/uv-cache",
        "-e", "UV_HTTP_TIMEOUT=600",
        "-e", "UV_CONCURRENT_DOWNLOADS=1",
        "-v", "${RepositoryRoot}:/workspace:ro",
        "-w", "/workspace/backend/api",
        $UvImage,
        "uv", "run", "--frozen", "--group", "dev", "pytest",
        "tests/test_postgresql18_database_contract.py", "-q"
    )
}

function Assert-DataForSeoUsable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database
    )

    Invoke-PsqlCommand -Database $Database -Sql @"
DO `$proof`$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM backlinks.backlink_provider_requests
    WHERE id = '018f0000-0000-7000-8000-000000000411'
      AND provider = 'dataforseo'
  ) THEN
    RAISE EXCEPTION 'DataForSEO provider request was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM backlinks.backlink_seo_snapshots
    WHERE id = '018f0000-0000-7000-8000-000000000415'
      AND provider = 'dataforseo'
  ) THEN
    RAISE EXCEPTION 'DataForSEO snapshot was not preserved';
  END IF;
  UPDATE backlinks.backlink_provider_requests
    SET status = status
    WHERE id = '018f0000-0000-7000-8000-000000000411';
END;
`$proof`$;
"@
}

function Get-BacklinksRecoveryFactCounts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Database
    )

    $TableNames = & docker exec $ContainerName psql -At -U postgres -d $Database -c @"
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'backlinks'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
"@
    Assert-LastExitCode "list Backlinks recovery fact tables on $Database"

    $Counts = [ordered]@{}
    foreach ($TableName in $TableNames) {
        if ($TableName -notmatch '^[a-z0-9_]+$') {
            throw "Unexpected Backlinks recovery fact table name: $TableName"
        }
        $Count = & docker exec $ContainerName psql -At -U postgres -d $Database -c (
            "SELECT count(*) FROM backlinks.""$TableName"";"
        )
        Assert-LastExitCode "count Backlinks recovery facts for $TableName on $Database"
        $Counts[$TableName] = [long](($Count -join "").Trim())
    }
    return $Counts
}

function Remove-TestResources {
    $ExistingContainer = & docker ps -aq --filter "name=^/${ContainerName}$"
    if (-not [string]::IsNullOrWhiteSpace(($ExistingContainer -join ""))) {
        & docker rm -f $ContainerName | Out-Null
    }

    $ExistingNetwork = & docker network ls -q --filter "name=^${NetworkName}$"
    if (-not [string]::IsNullOrWhiteSpace(($ExistingNetwork -join ""))) {
        & docker network rm $NetworkName | Out-Null
    }
}

Push-Location $RepositoryRoot
try {
    Invoke-Docker -Operation "deployment manifest gate" -Arguments @(
        "run", "--rm",
        "-e", "UV_PROJECT_ENVIRONMENT=/tmp/venv",
        "-e", "UV_CACHE_DIR=/tmp/uv-cache",
        "-e", "UV_HTTP_TIMEOUT=600",
        "-e", "UV_CONCURRENT_DOWNLOADS=1",
        "-v", "${RepositoryRoot}:/workspace:ro",
        "-w", "/workspace/backend/api",
        $UvImage,
        "uv", "run", "--frozen", "--group", "dev", "pytest",
        "tests/test_database_migration_system.py", "-q"
    )

    Invoke-Docker -Operation "create disposable Docker network" -Arguments @(
        "network", "create", "--label", $ContainerLabel, $NetworkName
    )
    Invoke-Docker -Operation "start disposable PostgreSQL 18" -Arguments @(
        "run", "-d",
        "--name", $ContainerName,
        "--network", $NetworkName,
        "--label", $ContainerLabel,
        "-e", "POSTGRES_PASSWORD=postgres",
        $PostgresImage
    )

    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        & docker exec $ContainerName pg_isready -U postgres -d postgres 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $Ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $Ready) {
        throw "Disposable PostgreSQL 18 did not become ready"
    }

    foreach ($Database in @("seo_clean", "seo_upgrade")) {
        Invoke-Docker -Operation "create $Database" -Arguments @(
            "exec", $ContainerName, "createdb", "-U", "postgres", $Database
        )
    }

    Invoke-PsqlFile -Database "seo_clean" -Path $BootstrapPath
    Invoke-Alembic -Database "seo_clean" -Revision "head"
    Invoke-BacklinksMigrations -Database "seo_clean" -First 1 -Last 11
    Invoke-IntegratedParallelBlockMigrations -Database "seo_clean"
    Invoke-DatabaseContract -Database "seo_clean"

    Invoke-Alembic -Database "seo_upgrade" -Revision "20260722_0006"
    Invoke-BacklinksMigrations -Database "seo_upgrade" -First 1 -Last 4
    Invoke-PsqlCommand -Database "seo_upgrade" -Sql @"
INSERT INTO public.projects (
  id, organization_id, name, domain, country, language
) VALUES (
  'seo4-int-004-legacy-project',
  'seo4-int-004-legacy-organization',
  'Legacy project',
  'legacy-seo4-int-004.example',
  'US',
  'en'
);
INSERT INTO public.crawl_runs (
  run_id, organization_id, project_id, task_type, status
) VALUES (
  'seo4-int-004-legacy-run',
  'seo4-int-004-legacy-organization',
  'seo4-int-004-legacy-project',
  'technical_audit',
  'completed'
);
INSERT INTO public.backlink_idempotency_records (
  id, organization_id, workspace_id, website_project_id,
  idempotency_key, command_type, request_hash, expires_at,
  created_by, updated_by
) VALUES (
  '018f0000-0000-7000-8000-000000000401',
  '018f0000-0000-7000-8000-000000000402',
  '018f0000-0000-7000-8000-000000000403',
  '018f0000-0000-7000-8000-000000000404',
  'seo4-int-004-legacy',
  'migration-proof',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  now() + interval '1 day',
  'seo4-int-004',
  'seo4-int-004'
);
INSERT INTO public.backlink_provider_requests (
  id, organization_id, workspace_id, website_project_id, provider, endpoint,
  request_fingerprint, active_request_bucket, request_schema_version,
  request_payload, status, finished_at, created_by
) VALUES (
  '018f0000-0000-7000-8000-000000000411',
  '018f0000-0000-7000-8000-000000000412',
  '018f0000-0000-7000-8000-000000000413',
  '018f0000-0000-7000-8000-000000000414',
  'dataforseo',
  '/legacy/summary',
  '3333333333333333333333333333333333333333333333333333333333333333',
  'legacy-completed',
  1,
  jsonb_build_object('legacy', true),
  'succeeded',
  now(),
  'seo4-int-004'
);
INSERT INTO public.backlink_seo_snapshots (
  id, organization_id, workspace_id, website_project_id,
  provider_request_id, provider, target, target_type, snapshot_type,
  normalized_payload, payload_hash, observed_at, schema_version, created_by
) VALUES (
  '018f0000-0000-7000-8000-000000000415',
  '018f0000-0000-7000-8000-000000000412',
  '018f0000-0000-7000-8000-000000000413',
  '018f0000-0000-7000-8000-000000000414',
  '018f0000-0000-7000-8000-000000000411',
  'dataforseo',
  'legacy-dataforseo.example',
  'domain',
  'legacy-provider-summary',
  jsonb_build_object('legacy', true),
  '4444444444444444444444444444444444444444444444444444444444444444',
  now(),
  1,
  'seo4-int-004'
);
"@
    Invoke-PsqlFile -Database "seo_upgrade" -Path $BootstrapPath
    Invoke-Alembic -Database "seo_upgrade" -Revision "head"
    Invoke-BacklinksMigrations -Database "seo_upgrade" -First 5 -Last 11
    Invoke-IntegratedParallelBlockMigrations -Database "seo_upgrade"
    Invoke-PsqlCommand -Database "seo_upgrade" -Sql @"
DO `$proof`$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform.projects
    WHERE id = 'seo4-int-004-legacy-project'
  ) THEN
    RAISE EXCEPTION 'Platform legacy row was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crawling.crawl_runs
    WHERE run_id = 'seo4-int-004-legacy-run'
  ) THEN
    RAISE EXCEPTION 'Crawler legacy row was not preserved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM backlinks.backlink_idempotency_records
    WHERE id = '018f0000-0000-7000-8000-000000000401'
  ) THEN
    RAISE EXCEPTION 'Backlinks legacy row was not preserved';
  END IF;
END;
`$proof`$;
"@
    Assert-DataForSeoUsable -Database "seo_upgrade"
    Invoke-DatabaseContract -Database "seo_upgrade"
    $SourceFactCounts = Get-BacklinksRecoveryFactCounts -Database "seo_upgrade"
    $SourceFactTotal = (
        $SourceFactCounts.Values | Measure-Object -Sum
    ).Sum
    if ($SourceFactCounts.Count -eq 0 -or $SourceFactTotal -le 0) {
        throw "Source database contains no Backlinks recovery facts"
    }

    $BackupCreatedAt = Get-Date
    Invoke-Docker -Operation "backup upgraded database" -Arguments @(
        "exec", $ContainerName,
        "pg_dump", "-U", "postgres", "-d", "seo_upgrade",
        "--format=custom", "--file=/tmp/seo4-int-004.dump"
    )
    $ValidationStartedAt = Get-Date
    Invoke-Docker -Operation "create restore database" -Arguments @(
        "exec", $ContainerName, "createdb", "-U", "postgres", "seo_restore"
    )
    Invoke-Docker -Operation "restore upgraded database" -Arguments @(
        "exec", $ContainerName,
        "pg_restore", "-U", "postgres", "-d", "seo_restore",
        "--exit-on-error", "/tmp/seo4-int-004.dump"
    )
    Invoke-DatabaseContract -Database "seo_restore"
    Assert-DataForSeoUsable -Database "seo_restore"
    $RestoredFactCounts = Get-BacklinksRecoveryFactCounts -Database "seo_restore"
    if ($RestoredFactCounts.Count -ne $SourceFactCounts.Count) {
        throw "Restored Backlinks recovery fact table count differs"
    }
    foreach ($TableName in $SourceFactCounts.Keys) {
        if (
            -not $RestoredFactCounts.Contains($TableName) -or
            $RestoredFactCounts[$TableName] -ne $SourceFactCounts[$TableName]
        ) {
            throw "Restored Backlinks recovery fact count differs for $TableName"
        }
    }
    $ValidationCompletedAt = Get-Date
    $RecoveryPointAge = $ValidationStartedAt - $BackupCreatedAt
    $RecoveryDuration = $ValidationCompletedAt - $ValidationStartedAt
    if (
        $RecoveryPointAge.TotalMinutes -lt 0 -or
        $RecoveryPointAge.TotalMinutes -gt 60
    ) {
        throw "BL-AI-194 recovery drill exceeded the 60-minute RPO"
    }
    if (
        $RecoveryDuration.TotalHours -lt 0 -or
        $RecoveryDuration.TotalHours -gt 4
    ) {
        throw "BL-AI-194 recovery drill exceeded the 4-hour RTO"
    }

    $Version = & docker exec $ContainerName psql -At -U postgres -d seo_clean -c "SHOW server_version"
    Assert-LastExitCode "read PostgreSQL version"
    Write-Output "SEO4-INT-004 PostgreSQL version: $Version"
    Write-Output "SEO4-INT-004 clean install: PASS"
    Write-Output "SEO4-INT-004 existing upgrade and DataForSEO write compatibility: PASS"
    Write-Output "SEO4-INT-004 backup and restore: PASS"
    Write-Output (
        "BL-AI-194 recovery fact counts: PASS " +
        "($($SourceFactCounts.Count) tables, $SourceFactTotal facts)"
    )
    Write-Output (
        "BL-AI-194 recovery objectives: PASS " +
        "(RPO $([math]::Round($RecoveryPointAge.TotalSeconds, 3))s, " +
        "RTO $([math]::Round($RecoveryDuration.TotalSeconds, 3))s)"
    )
}
finally {
    Pop-Location
    Remove-TestResources
}
