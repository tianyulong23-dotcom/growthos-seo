param(
    [string]$EnvironmentFile = "",
    [string]$ComposeProjectName = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "deploy\compose\compose.yaml"
$apiDir = Join-Path $root "backend\api"
$crawlerDir = Join-Path $root "backend\crawler"
$coreDir = Join-Path $root "backend\core"
$frontendDir = Join-Path $root "frontend"
$rolesFile = Join-Path $root "backend\database\roles\0001_growthos_schema_roles.sql"
$deploymentManifestFile = Join-Path $root `
    "backend\database\deployment-manifest.v1.json"
$localProjectTenantReconciliationFile = Join-Path $root `
    "backend\database\operations\reconcile_local_project_tenants.sql"
$backlinksDeploymentManifestRenderer = Join-Path $coreDir `
    "scripts\render-backlinks-deployment-manifest.mjs"
$crawlerExe = Join-Path $root "storage\runtime\crawler-worker-docker.exe"
$crawlerBuildMetadataFile = Join-Path $root `
    "storage\runtime\crawler-worker-docker.build.json"

if (-not $EnvironmentFile) {
    $EnvironmentFile = Join-Path $root "deploy\compose\.env"
}
if (-not (Test-Path -LiteralPath $EnvironmentFile)) {
    throw "Configuration file not found: $EnvironmentFile"
}
if (-not (Test-Path -LiteralPath $deploymentManifestFile)) {
    throw "Deployment manifest not found: $deploymentManifestFile"
}
$composeEnvFile = (Resolve-Path -LiteralPath $EnvironmentFile).Path
$deploymentManifest = Get-Content -LiteralPath $deploymentManifestFile -Raw |
    ConvertFrom-Json
$backlinksTargetHead = [string]$deploymentManifest.heads.backlinks
if ($backlinksTargetHead -notmatch "^\d{4}$") {
    throw "BACKLINKS_MANIFEST_HEAD_INVALID: '$backlinksTargetHead'"
}

function Get-LocalSetting {
    param(
        [string]$Name,
        [string]$Default = ""
    )

    $line = Get-Content -LiteralPath $composeEnvFile |
        Where-Object {
            $_ -match "^\s*$([regex]::Escape($Name))\s*="
        } |
        Select-Object -Last 1
    if (-not $line) {
        return $Default
    }
    $value = ($line -split "=", 2)[1].Trim()
    if (
        $value.Length -ge 2 -and
        (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        )
    ) {
        return $value.Substring(1, $value.Length - 2)
    }
    return $value
}

function Add-NoProxyHost {
    param(
        [string]$NoProxy,
        [string]$HostName
    )

    $hosts = @(
        $NoProxy -split "," |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
    )
    if ($HostName -notin $hosts) {
        $hosts += $HostName
    }
    return $hosts -join ","
}

function ConvertTo-NormalizedProxyUrl {
    param([string]$ProxyValue)

    if (-not $ProxyValue) {
        return ""
    }
    $candidate = $ProxyValue.Trim()
    if ($candidate -notmatch "^[A-Za-z][A-Za-z0-9+.-]*://") {
        $candidate = "http://$candidate"
    }
    try {
        $uri = [System.Uri]::new($candidate)
    }
    catch {
        throw "OUTBOUND_PROXY_URL_INVALID:$ProxyValue"
    }
    if (-not $uri.Host -or $uri.Port -le 0) {
        throw "OUTBOUND_PROXY_URL_INVALID:$ProxyValue"
    }
    return $uri.AbsoluteUri.TrimEnd("/")
}

function Get-WindowsSystemProxyUrl {
    param([ValidateSet("http", "https")][string]$Scheme)

    if ($env:OS -ne "Windows_NT") {
        return ""
    }
    try {
        $settings = Get-ItemProperty `
            "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    }
    catch {
        return ""
    }
    if ([int]$settings.ProxyEnable -ne 1) {
        return ""
    }
    $proxyServer = ([string]$settings.ProxyServer).Trim()
    if (-not $proxyServer) {
        return ""
    }

    $byScheme = @{}
    $fallback = ""
    foreach ($entry in $proxyServer -split ";") {
        $value = $entry.Trim()
        if (-not $value) {
            continue
        }
        if ($value -match "^(?<scheme>[^=]+)=(?<proxy>.+)$") {
            $byScheme[$Matches.scheme.Trim().ToLowerInvariant()] = (
                $Matches.proxy.Trim()
            )
        }
        elseif (-not $fallback) {
            $fallback = $value
        }
    }

    $selected = if ($byScheme.ContainsKey($Scheme)) {
        [string]$byScheme[$Scheme]
    }
    elseif ($Scheme -eq "https" -and $byScheme.ContainsKey("http")) {
        [string]$byScheme["http"]
    }
    else {
        $fallback
    }
    return ConvertTo-NormalizedProxyUrl $selected
}

function Resolve-OutboundProxyUrl {
    param(
        [ValidateSet("explicit", "system")][string]$Mode,
        [string]$ConfiguredProxy,
        [ValidateSet("http", "https")][string]$Scheme
    )

    if ($Mode -eq "system") {
        return Get-WindowsSystemProxyUrl -Scheme $Scheme
    }
    return ConvertTo-NormalizedProxyUrl $ConfiguredProxy
}

function Assert-OutboundProxyEndpointReachable {
    param(
        [string[]]$ProxyUrls,
        [int]$TimeoutMilliseconds = 2000
    )

    $checked = @{}
    foreach ($proxyUrl in $ProxyUrls) {
        if (-not $proxyUrl) {
            continue
        }
        $uri = [System.Uri]::new($proxyUrl)
        $endpointKey = "$($uri.Host):$($uri.Port)"
        if ($checked.ContainsKey($endpointKey)) {
            continue
        }
        $checked[$endpointKey] = $true
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $connection = $client.ConnectAsync($uri.Host, $uri.Port)
            if (
                -not $connection.Wait($TimeoutMilliseconds) -or
                -not $client.Connected
            ) {
                throw "proxy connection timeout"
            }
        }
        catch {
            throw (
                "OUTBOUND_PROXY_UNREACHABLE:" +
                "$($uri.Scheme)://$($uri.Host):$($uri.Port)"
            )
        }
        finally {
            $client.Dispose()
        }
    }
}

if (-not $ComposeProjectName) {
    $ComposeProjectName = Get-LocalSetting "COMPOSE_PROJECT_NAME" "seo-v4"
}
$runtimeProfile = [regex]::Replace(
    $ComposeProjectName,
    "[^A-Za-z0-9_.-]",
    "_"
)
$runtimeDir = Join-Path $root "storage\runtime\m1c\$runtimeProfile"
$pidFile = Join-Path $runtimeDir "processes.json"
$databaseSecretFile = Join-Path $runtimeDir "backlinks-database-url.secret"
$signingKeySecretFile = Join-Path $runtimeDir "platform-context-signing-key.secret"
$managedProcesses = @()

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Get-RequiredSetting {
    param([string]$Name)

    $value = Get-LocalSetting $Name
    if (-not $value) {
        throw "Required configuration is missing: $Name"
    }
    return $value
}

function Read-ManagedEnvironmentSettings {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "LOCAL_PRODUCT_AI_MANAGED_CONFIGURATION_MISSING:$Path"
    }
    $values = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) {
            continue
        }
        $separator = $line.IndexOf("=")
        if ($separator -le 0) {
            throw "LOCAL_PRODUCT_AI_MANAGED_CONFIGURATION_INVALID:$Path"
        }
        $name = $line.Substring(0, $separator).Trim()
        if ($values.ContainsKey($name)) {
            throw "LOCAL_PRODUCT_AI_MANAGED_CONFIGURATION_DUPLICATE:$name"
        }
        $value = $line.Substring($separator + 1).Trim()
        if (
            $value.Length -ge 2 -and
            (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            )
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$name] = $value
    }
    return $values
}

function Get-PortSetting {
    param(
        [string]$Name,
        [int]$Default
    )

    $raw = Get-LocalSetting $Name ([string]$Default)
    $value = 0
    if (
        -not [int]::TryParse($raw, [ref]$value) -or
        $value -lt 1 -or
        $value -gt 65535
    ) {
        throw "Invalid port configuration: $Name"
    }
    return $value
}

function Assert-ProviderDisabled {
    param([string]$Name)

    if ((Get-RequiredSetting $Name) -ne "false") {
        throw "PHASE1_PROVIDER_CONFIGURATION_INVALID:$Name must be false"
    }
}

function Assert-ProviderEnabled {
    param([string]$Name)

    if ((Get-RequiredSetting $Name) -ne "true") {
        throw "PHASE1_PROVIDER_CONFIGURATION_INVALID:$Name must be true"
    }
}

function Assert-ProviderRuntimeStatus {
    param(
        [pscustomobject]$Provider,
        [string]$Name,
        [string]$ExpectedAvailability,
        [string]$UnavailableReason = ""
    )

    if (-not $Provider.configured) {
        throw "PHASE1_PROVIDER_CONFIGURATION_DRIFT:$Name"
    }
    if ($Provider.external_availability -ne $ExpectedAvailability) {
        throw "PHASE1_PROVIDER_AVAILABILITY_DRIFT:$Name"
    }

    $expectedReason = $null
    $expectedRecovery = $null
    if ($ExpectedAvailability -eq "not_checked") {
        $expectedReason = "provider_not_checked"
        $expectedRecovery = "run_provider_diagnostic"
    }
    elseif ($ExpectedAvailability -eq "unavailable") {
        $expectedReason = $UnavailableReason
        $expectedRecovery = switch ($UnavailableReason) {
            "insufficient_balance" { "fund_provider_account" }
            "invalid_credentials" { "repair_provider_credentials" }
            "rate_limited" { "retry_after_rate_limit" }
            "provider_timeout" { "retry_after_timeout" }
            "provider_outage" { "retry_when_provider_recovers" }
            "unknown_charge" { "reconcile_request_fingerprint" }
            "explicit_block" { "remove_explicit_block" }
            default {
                throw "PHASE1_PROVIDER_REASON_INVALID:$Name"
            }
        }
    }

    if (
        $Provider.reason_code -ne $expectedReason -or
        $Provider.recovery_action -ne $expectedRecovery
    ) {
        throw "PHASE1_PROVIDER_DIAGNOSTIC_DRIFT:$Name"
    }
}

function Test-Url {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri $Url `
            -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Wait-ForUrl {
    param(
        [string]$Name,
        [string]$Url
    )

    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        if (Test-Url $Url) {
            Write-Host "$Name is ready: $Url"
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "$Name did not become ready: $Url"
}

$composeArguments = @(
    "compose",
    "--env-file",
    $composeEnvFile,
    "-f",
    $composeFile
)
$composeArguments += @("-p", $ComposeProjectName)

function Invoke-Compose {
    param(
        [string[]]$ExtraArguments,
        [switch]$AllowFailure
    )

    & docker @composeArguments @ExtraArguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "Docker Compose failed: $($ExtraArguments -join ' ')"
    }
    return $exitCode
}

function Wait-ForComposeService {
    param([string]$Service)

    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $containerId = (
            & docker @composeArguments ps -q $Service |
                Select-Object -Last 1
        )
        if ($containerId) {
            $containerId = $containerId.Trim()
            $state = (
                & docker inspect `
                    --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
                    $containerId
            ).Trim()
            if ($state -eq "healthy" -or $state -eq "running") {
                Write-Host "$Service is ready."
                return
            }
        }
        Start-Sleep -Seconds 1
    }
    throw "$Service did not become ready."
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

function Get-RecordedProcess {
    param([pscustomobject]$Record)

    $process = Get-Process `
        -Id ([int]$Record.processId) `
        -ErrorAction SilentlyContinue
    if (-not $process) {
        return $null
    }

    $processInfo = Get-CimInstance Win32_Process `
        -Filter "ProcessId = $($Record.processId)" `
        -ErrorAction SilentlyContinue
    if (
        -not $processInfo -or
        -not $processInfo.CommandLine -or
        -not $processInfo.CommandLine.Contains(
            [string]$Record.expectedCommand
        )
    ) {
        return $null
    }

    if ($Record.startedAtUtc -and $Record.processName) {
        $recordedStart = (
            [datetime]$Record.startedAtUtc
        ).ToUniversalTime()
        $startDeltaSeconds = [Math]::Abs(
            (
                $process.StartTime.ToUniversalTime() -
                $recordedStart
            ).TotalSeconds
        )
        if (
            $process.ProcessName -eq [string]$Record.processName -and
            $startDeltaSeconds -lt 1
        ) {
            return $process
        }
        return $null
    }
    return $process
}

function Stop-RecordedProcesses {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return
    }
    $parsedRecords = (
        Get-Content -LiteralPath $pidFile -Raw |
            ConvertFrom-Json
    )
    $records = @($parsedRecords)
    foreach ($record in $records) {
        if (Get-RecordedProcess -Record $record) {
            Stop-ProcessTree -ProcessId ([int]$record.processId)
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Save-ManagedProcesses {
    $script:managedProcesses |
        ConvertTo-Json |
        Set-Content -LiteralPath $pidFile -Encoding utf8
}

function Register-ManagedProcess {
    param(
        [string]$Name,
        [System.Diagnostics.Process]$Process,
        [string]$ExpectedCommand
    )

    $script:managedProcesses += [pscustomobject]@{
        name = $Name
        processId = $Process.Id
        processName = $Process.ProcessName
        startedAtUtc = $Process.StartTime.ToUniversalTime().ToString("O")
        expectedCommand = $ExpectedCommand
    }
    Save-ManagedProcesses
}

function Assert-PortAvailable {
    param(
        [string]$Name,
        [int]$Port
    )

    $listener = Get-NetTCPConnection `
        -State Listen `
        -LocalPort $Port `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) {
        throw "$Name port $Port is already used by process $($listener.OwningProcess)."
    }
}

function Assert-ManagedProcessRunning {
    param(
        [string]$Name,
        [System.Diagnostics.Process]$Process,
        [string]$StandardErrorPath
    )

    Start-Sleep -Milliseconds 750
    $Process.Refresh()
    if (-not $Process.HasExited) {
        return
    }

    $details = ""
    if (Test-Path -LiteralPath $StandardErrorPath) {
        $details = (
            Get-Content -LiteralPath $StandardErrorPath -Raw
        ).Trim()
    }
    if (-not $details) {
        $details = "no stderr output"
    }
    throw "$Name exited during startup with code $($Process.ExitCode): $details"
}

function Invoke-PostgresSql {
    param(
        [string]$Sql,
        [string[]]$Variables = @()
    )

    $arguments = @(
        "exec",
        "-i",
        $script:postgresContainerId,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "seo"
    )
    foreach ($variable in $Variables) {
        $arguments += @("-v", $variable)
    }
    $Sql | & docker @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL command failed."
    }
}

function Invoke-PostgresScalar {
    param([string]$Sql)

    $output = $Sql |
        & docker exec -i $script:postgresContainerId `
            psql -X -v ON_ERROR_STOP=1 -tA -U postgres -d seo
    if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL query failed."
    }
    return ([string]($output | Select-Object -Last 1)).Trim()
}

function Invoke-BacklinksMigrations {
    param([string]$Start, [string]$Target)

    $renderedMigrationJson = (
        & node $backlinksDeploymentManifestRenderer --start $Start --target $Target 2>&1
    ) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) {
        throw "BACKLINKS_MANIFEST_RENDER_FAILED: $renderedMigrationJson"
    }
    foreach ($migration in @($renderedMigrationJson | ConvertFrom-Json)) {
        Write-Host "Applying $($migration.fileName)"
        Invoke-PostgresSql ([string]$migration.sql)
    }
}

function Repair-BacklinksHybridSchemaGap {
    # A later migration marker does not prove that its prerequisites exist.
    $probe = @"
SELECT CASE
  WHEN to_regclass('backlinks.backlink_project_domain_ratings') IS NOT NULL
    THEN 'ready'
  WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'backlinks'
      AND table_name = 'backlink_recommendation_release_batch_items'
      AND column_name = 'resource_library_snapshot'
  )
    THEN 'missing-0099'
  ELSE 'before-hybrid'
END;
"@
    $state = Invoke-PostgresScalar $probe
    if ($state -eq "missing-0099") {
        Write-Host "Repairing missing Backlinks 0099 prerequisite..."
        Invoke-BacklinksMigrations -Start "0099" -Target "0099"
        if ((Invoke-PostgresScalar $probe) -ne "ready") {
            throw "BACKLINKS_SCHEMA_REPAIR_INCOMPLETE: missing 0099 prerequisite"
        }
    }
    elseif ($state -notin @("ready", "before-hybrid")) {
        throw "BACKLINKS_SCHEMA_UNKNOWN_HYBRID_STATE"
    }
}

function Set-ProcessEnvironment {
    param([hashtable]$Values)

    foreach ($name in $Values.Keys) {
        Set-Item -Path "Env:$name" -Value ([string]$Values[$name])
    }
}

function Convert-ProxyForDockerContainer {
    param([string]$ProxyUrl)

    if (-not $ProxyUrl) {
        return ""
    }
    $builder = [System.UriBuilder]::new($ProxyUrl)
    if ($builder.Host -in @("127.0.0.1", "localhost", "::1")) {
        $builder.Host = "host.docker.internal"
    }
    return $builder.Uri.AbsoluteUri.TrimEnd("/")
}

function Get-CrawlerBuildInputs {
    return @(
        Get-ChildItem -LiteralPath $crawlerDir -Recurse -File |
            Where-Object {
                $_.Extension -eq ".go" -or
                $_.Name -in @("go.mod", "go.sum")
            } |
            Sort-Object FullName
    )
}

function Get-Sha256FileFingerprint {
    param([string]$LiteralPath)

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (
            [BitConverter]::ToString(
                $sha256.ComputeHash($stream)
            ).Replace("-", "").ToLowerInvariant()
        )
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-CrawlerSourceFingerprint {
    $records = @(
        Get-CrawlerBuildInputs |
            ForEach-Object {
                $relativePath = $_.FullName.Substring(
                    $crawlerDir.Length
                ).TrimStart("\").Replace("\", "/")
                $fileHash = Get-Sha256FileFingerprint $_.FullName
                "$relativePath`:$fileHash"
            }
    )
    if ($records.Count -eq 0) {
        throw "Crawler Worker build inputs were not found."
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $payload = [System.Text.Encoding]::UTF8.GetBytes(
            $records -join "`n"
        )
        return (
            [BitConverter]::ToString(
                $sha256.ComputeHash($payload)
            ).Replace("-", "").ToLowerInvariant()
        )
    }
    finally {
        $sha256.Dispose()
    }
}

function Write-CrawlerBuildMetadata {
    param(
        [string]$SourceFingerprint,
        [string]$Provenance
    )

    $metadata = [ordered]@{
        schemaVersion = "growthos.crawler-build.v1"
        sourceFingerprint = $SourceFingerprint
        artifactFingerprint = Get-Sha256FileFingerprint $crawlerExe
        provenance = $Provenance
        builtAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $metadata |
        ConvertTo-Json |
        Set-Content `
            -LiteralPath $crawlerBuildMetadataFile `
            -Encoding utf8
}

function Test-CrawlerBuildCurrent {
    param([string]$SourceFingerprint)

    if (-not (Test-Path -LiteralPath $crawlerExe -PathType Leaf)) {
        return $false
    }
    if (Test-Path -LiteralPath $crawlerBuildMetadataFile -PathType Leaf) {
        try {
            $metadata = Get-Content `
                -LiteralPath $crawlerBuildMetadataFile `
                -Raw |
                ConvertFrom-Json
            $artifactFingerprint = Get-Sha256FileFingerprint $crawlerExe
            return (
                $metadata.schemaVersion -eq "growthos.crawler-build.v1" -and
                $metadata.sourceFingerprint -eq $SourceFingerprint -and
                $metadata.artifactFingerprint -eq $artifactFingerprint
            )
        }
        catch {
            return $false
        }
    }

    $latestInputWrite = (
        Get-CrawlerBuildInputs |
            Measure-Object -Property LastWriteTimeUtc -Maximum
    ).Maximum
    if (
        $latestInputWrite -and
        (Get-Item -LiteralPath $crawlerExe).LastWriteTimeUtc -ge
            $latestInputWrite
    ) {
        Write-CrawlerBuildMetadata `
            -SourceFingerprint $SourceFingerprint `
            -Provenance "legacy_artifact_source_mtime"
        return $true
    }
    return $false
}

function Build-CrawlerWorker {
    New-Item `
        -ItemType Directory `
        -Force `
        -Path (Split-Path -Parent $crawlerExe) |
        Out-Null

    $sourceFingerprint = Get-CrawlerSourceFingerprint
    if (Test-CrawlerBuildCurrent -SourceFingerprint $sourceFingerprint) {
        Write-Host (
            "Crawler Worker build inputs are unchanged; " +
            "reusing the verified executable."
        )
        return
    }

    $go = Get-Command go -ErrorAction SilentlyContinue
    if ($go) {
        Write-Host "Building Crawler Worker with local Go..."
        Push-Location $crawlerDir
        try {
            & $go.Source build -trimpath -o $crawlerExe ./cmd/crawler
            if ($LASTEXITCODE -ne 0) {
                throw "Crawler Worker build failed."
            }
        }
        finally {
            Pop-Location
        }
    }
    else {
        Write-Host "Go is not installed; building Crawler Worker with Docker..."
        $crawlerBuildNoProxy = @(
            $outboundNoProxy -split "," |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ }
            "proxy.golang.org"
            "sum.golang.org"
            "storage.googleapis.com"
        ) |
            Select-Object -Unique
        $dockerProxyArguments = @()
        foreach ($proxySetting in @{
            HTTP_PROXY = Convert-ProxyForDockerContainer $outboundHttpProxy
            HTTPS_PROXY = Convert-ProxyForDockerContainer $outboundHttpsProxy
            NO_PROXY = $crawlerBuildNoProxy -join ","
        }.GetEnumerator()) {
            if ($proxySetting.Value) {
                $dockerProxyArguments += @(
                    "--env",
                    "$($proxySetting.Key)=$($proxySetting.Value)"
                )
            }
        }
        & docker run `
            --rm `
            --mount "type=bind,source=$root,target=/workspace" `
            --workdir /workspace/backend/crawler `
            @dockerProxyArguments `
            --env GOOS=windows `
            --env GOARCH=amd64 `
            --env CGO_ENABLED=0 `
            golang:1.25-bookworm `
            go build `
            -trimpath `
            -o /workspace/storage/runtime/crawler-worker-docker.exe `
            ./cmd/crawler
        if ($LASTEXITCODE -ne 0) {
            throw "Crawler Worker Docker build failed."
        }
    }

    if (-not (Test-Path -LiteralPath $crawlerExe -PathType Leaf)) {
        throw "Crawler Worker executable was not created: $crawlerExe"
    }
    $completedSourceFingerprint = Get-CrawlerSourceFingerprint
    if ($completedSourceFingerprint -ne $sourceFingerprint) {
        throw "Crawler Worker source changed during build."
    }
    Write-CrawlerBuildMetadata `
        -SourceFingerprint $completedSourceFingerprint `
        -Provenance "source_build"
}

$postgresPassword = Get-RequiredSetting "POSTGRES_PASSWORD"
$minioRootUser = Get-RequiredSetting "MINIO_ROOT_USER"
$minioRootPassword = Get-RequiredSetting "MINIO_ROOT_PASSWORD"
$backlinksDatabasePassword = Get-RequiredSetting "BACKLINKS_DB_PASSWORD"
$platformContextSigningKey = Get-RequiredSetting "PLATFORM_CONTEXT_SIGNING_KEY"
if ($platformContextSigningKey.Length -lt 32) {
    throw "PLATFORM_CONTEXT_SIGNING_KEY must contain at least 32 characters."
}

$growthosRuntimeMode = (
    Get-LocalSetting "GROWTHOS_RUNTIME_MODE" "PRODUCT"
).ToUpperInvariant()
switch ($growthosRuntimeMode) {
    "PRODUCT" {
        $desiredWorkerExecutionMode = "normal"
        $desiredPlatformBackgroundDispatchEnabled = "true"
        $desiredBacklinksProjectProjectionEnabled = "true"
    }
    "MAINTENANCE" {
        $desiredWorkerExecutionMode = "quiesced"
        $desiredPlatformBackgroundDispatchEnabled = "false"
        $desiredBacklinksProjectProjectionEnabled = "false"
    }
    "RECOVERY" {
        $desiredWorkerExecutionMode = "recovery"
        $desiredPlatformBackgroundDispatchEnabled = "false"
        $desiredBacklinksProjectProjectionEnabled = "false"
    }
    default {
        throw "GROWTHOS_RUNTIME_MODE_UNSUPPORTED"
    }
}
$workerExecutionMode = Get-LocalSetting `
    "BACKLINKS_WORKER_EXECUTION_MODE" `
    $desiredWorkerExecutionMode
$platformBackgroundDispatchEnabled = Get-LocalSetting `
    "PLATFORM_BACKGROUND_DISPATCH_ENABLED" `
    $desiredPlatformBackgroundDispatchEnabled
$agentBackgroundDispatchEnabled = Get-LocalSetting `
    "AGENT_BACKGROUND_DISPATCH_ENABLED" "false"
$agentSystemTriggerDispatchEnabled = Get-LocalSetting `
    "AGENT_SYSTEM_TRIGGER_DISPATCH_ENABLED" "true"
$backlinksProjectProjectionEnabled = Get-LocalSetting `
    "BACKLINKS_PROJECT_PROJECTION_ENABLED" `
    $desiredBacklinksProjectProjectionEnabled
if ($workerExecutionMode -ne $desiredWorkerExecutionMode) {
    throw "GROWTHOS_RUNTIME_MODE_WORKER_CONFLICT"
}
if (
    $platformBackgroundDispatchEnabled -ne
    $desiredPlatformBackgroundDispatchEnabled
) {
    throw "GROWTHOS_RUNTIME_MODE_BACKGROUND_DISPATCH_CONFLICT"
}
if (
    $backlinksProjectProjectionEnabled -ne
    $desiredBacklinksProjectProjectionEnabled
) {
    throw "GROWTHOS_RUNTIME_MODE_PROJECT_PROJECTION_CONFLICT"
}
$dataForSeoEnabled = Get-LocalSetting "DATAFORSEO_ENABLED" "false"
$browserProviderEnabled = Get-LocalSetting "BROWSER_PROVIDER_ENABLED" "false"
$platformSecretStoreEnabled = Get-LocalSetting `
    "PLATFORM_SECRET_STORE_ENABLED" `
    "false"
$aiProviderEnabled = Get-LocalSetting "AI_PROVIDER_ENABLED" "false"
$googleOauthEnabled = Get-LocalSetting "GOOGLE_OAUTH_ENABLED" "false"
$gmailSendEnabled = Get-LocalSetting "GMAIL_SEND_ENABLED" "false"
$gmailSyncEnabled = Get-LocalSetting "GMAIL_SYNC_ENABLED" "false"
foreach ($providerFlag in @(
    "DATAFORSEO_ENABLED",
    "BROWSER_PROVIDER_ENABLED",
    "PLATFORM_SECRET_STORE_ENABLED",
    "AI_PROVIDER_ENABLED",
    "GOOGLE_OAUTH_ENABLED",
    "GMAIL_SEND_ENABLED",
    "GMAIL_SYNC_ENABLED"
)) {
    $providerFlagValue = Get-LocalSetting $providerFlag "false"
    if ($providerFlagValue -notin @("true", "false")) {
        throw "PRODUCT_PROVIDER_CONFIGURATION_INVALID:$providerFlag"
    }
    if ($growthosRuntimeMode -eq "PRODUCT") {
        Assert-ProviderEnabled $providerFlag
    }
}
$googleOauthClientId = ""
$googleOauthClientSecretReference = ""
$googleOauthRedirectUri = ""
$backlinksOauthFrontendOrigin = ""
if ($googleOauthEnabled -eq "true") {
    $googleOauthClientId = Get-RequiredSetting "GOOGLE_OAUTH_CLIENT_ID"
    $googleOauthClientSecretReference = Get-RequiredSetting `
        "GOOGLE_OAUTH_CLIENT_SECRET_REF"
    $googleOauthRedirectUri = Get-RequiredSetting "GOOGLE_OAUTH_REDIRECT_URI"
    $backlinksOauthFrontendOrigin = Get-RequiredSetting `
        "BACKLINKS_OAUTH_FRONTEND_ORIGIN"
}
$outboundProxyMode = Get-LocalSetting "OUTBOUND_PROXY_MODE" "explicit"
if ($outboundProxyMode -notin @("explicit", "system")) {
    throw "OUTBOUND_PROXY_MODE_INVALID"
}
$outboundHttpProxy = Get-LocalSetting "HTTP_PROXY"
$outboundHttpsProxy = Get-LocalSetting "HTTPS_PROXY"
$outboundHttpProxy = Resolve-OutboundProxyUrl `
    -Mode $outboundProxyMode `
    -ConfiguredProxy $outboundHttpProxy `
    -Scheme "http"
$outboundHttpsProxy = Resolve-OutboundProxyUrl `
    -Mode $outboundProxyMode `
    -ConfiguredProxy $outboundHttpsProxy `
    -Scheme "https"
$outboundNoProxy = Get-LocalSetting "NO_PROXY"
$nodeUseEnvProxy = Get-LocalSetting "NODE_USE_ENV_PROXY"
$backlinksRequestTimeoutSeconds = Get-LocalSetting `
    "BACKLINKS_REQUEST_TIMEOUT_SECONDS" `
    "30"
if ($nodeUseEnvProxy -and $nodeUseEnvProxy -notin @("0", "1")) {
    throw "NODE_USE_ENV_PROXY_INVALID"
}
if ($outboundHttpProxy -or $outboundHttpsProxy) {
    if (
        $dataForSeoEnabled -eq "true" -and
        $nodeUseEnvProxy -eq "1"
    ) {
        $outboundNoProxy = Add-NoProxyHost `
            -NoProxy $outboundNoProxy `
            -HostName "api.dataforseo.com"
    }
    $noProxyHosts = @(
        $outboundNoProxy -split "," |
            ForEach-Object { $_.Trim().ToLowerInvariant() }
    )
    if (
        "localhost" -notin $noProxyHosts -or
        "127.0.0.1" -notin $noProxyHosts
    ) {
        throw "OUTBOUND_PROXY_LOCAL_BYPASS_REQUIRED"
    }
    if ($nodeUseEnvProxy -eq "1") {
        Assert-OutboundProxyEndpointReachable @(
            $outboundHttpProxy,
            $outboundHttpsProxy
        )
    }
}
$dataForSeoDefaultAvailability = if ($growthosRuntimeMode -eq "PRODUCT") {
    "available"
}
else {
    "not_checked"
}
$dataForSeoAvailability = Get-LocalSetting `
    "DATAFORSEO_EXTERNAL_AVAILABILITY" `
    $dataForSeoDefaultAvailability
$browserProviderAvailability = Get-LocalSetting "BROWSER_PROVIDER_EXTERNAL_AVAILABILITY" "not_checked"
$aiProviderAvailability = Get-LocalSetting "AI_PROVIDER_EXTERNAL_AVAILABILITY" "not_checked"
$gmailProviderAvailability = Get-LocalSetting "GMAIL_EXTERNAL_AVAILABILITY" "not_checked"
foreach ($availability in @(
    $dataForSeoAvailability,
    $browserProviderAvailability,
    $aiProviderAvailability,
    $gmailProviderAvailability
)) {
    if ($availability -notin @("not_checked", "available", "unavailable")) {
        throw "PHASE1_PROVIDER_AVAILABILITY_INVALID:$availability"
    }
}
$dataForSeoUnavailableReason = Get-LocalSetting `
    "DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON"
$browserProviderUnavailableReason = Get-LocalSetting `
    "BROWSER_PROVIDER_EXTERNAL_UNAVAILABLE_REASON"
$aiProviderUnavailableReason = Get-LocalSetting `
    "AI_PROVIDER_EXTERNAL_UNAVAILABLE_REASON"
$gmailProviderUnavailableReason = Get-LocalSetting `
    "GMAIL_EXTERNAL_UNAVAILABLE_REASON"
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
if (-not $localAppData) {
    throw "LOCALAPPDATA is unavailable."
}
$secretStoreRoot = Get-LocalSetting "PLATFORM_SECRET_STORE_ROOT"
if (-not $secretStoreRoot) {
    $secretStoreRoot = Join-Path $localAppData "GrowthOS\local-product\secrets"
}
$aiProviderEnvironment = @{}
if ($aiProviderEnabled -eq "true") {
    $managedAiEnvironmentPath = Join-Path `
        (Split-Path -Parent $secretStoreRoot) `
        "backlinks-worker.env"
    $managedAiEnvironment = Read-ManagedEnvironmentSettings `
        $managedAiEnvironmentPath
    $managedAiEnvironmentNames = @(
        "AI_PROVIDER_REF",
        "AI_PROVIDER_BASE_URL",
        "AI_PROVIDER_PROXY_MODE",
        "AI_MODEL_ID",
        "AI_DISCOVERY_MODEL_ID",
        "AI_MODEL_VERSION",
        "AI_PROVIDER_CREDENTIAL_SECRET_REF",
        "AI_PROVIDER_MAX_CALLS",
        "AI_PROVIDER_TIMEOUT_MS",
        "AI_PROVIDER_MAX_INPUT_TOKENS",
        "AI_PROVIDER_MAX_OUTPUT_TOKENS",
        "AI_PROVIDER_ABSOLUTE_BUDGET_USD",
        "AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS",
        "AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS",
        "AI_DISCOVERY_MAX_CALLS",
        "AI_DISCOVERY_ABSOLUTE_BUDGET_USD",
        "AI_DISCOVERY_WINDOW_SECONDS",
        "AI_DISCOVERY_MAX_CONCURRENCY",
        "AI_DISCOVERY_MAX_WORK_ITEMS_PER_GENERATION",
        "AI_OUTREACH_DRAFT_MAX_CALLS",
        "AI_OUTREACH_DRAFT_ABSOLUTE_BUDGET_USD",
        "AI_OUTREACH_DRAFT_WINDOW_SECONDS",
        "AI_OUTREACH_DRAFT_MAX_CONCURRENCY"
    )
    $requiredManagedAiEnvironmentNames = @(
        "AI_PROVIDER_REF",
        "AI_PROVIDER_BASE_URL",
        "AI_MODEL_ID",
        "AI_MODEL_VERSION",
        "AI_PROVIDER_CREDENTIAL_SECRET_REF",
        "AI_PROVIDER_MAX_CALLS",
        "AI_PROVIDER_TIMEOUT_MS",
        "AI_PROVIDER_MAX_INPUT_TOKENS",
        "AI_PROVIDER_MAX_OUTPUT_TOKENS",
        "AI_PROVIDER_ABSOLUTE_BUDGET_USD",
        "AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS",
        "AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS"
    )
    foreach ($name in $requiredManagedAiEnvironmentNames) {
        if (-not $managedAiEnvironment[$name]) {
            throw "LOCAL_PRODUCT_AI_MANAGED_CONFIGURATION_MISSING:$name"
        }
    }
    foreach ($name in $managedAiEnvironmentNames) {
        $value = [string]$managedAiEnvironment[$name]
        if (
            -not $value -and
            (
                $name -eq "AI_PROVIDER_PROXY_MODE" -or
                $name.StartsWith("AI_DISCOVERY_") -or
                $name.StartsWith("AI_OUTREACH_DRAFT_")
            )
        ) {
            $value = Get-LocalSetting $name
        }
        if ($value) {
            $aiProviderEnvironment[$name] = $value
        }
    }
    $aiProviderProxyMode = [string]$aiProviderEnvironment[
        "AI_PROVIDER_PROXY_MODE"
    ]
    if (-not $aiProviderProxyMode) {
        $aiProviderProxyMode = "direct"
        $aiProviderEnvironment["AI_PROVIDER_PROXY_MODE"] = (
            $aiProviderProxyMode
        )
    }
    if ($aiProviderProxyMode -notin @("direct", "inherit")) {
        throw "AI_PROVIDER_PROXY_MODE_INVALID"
    }
}

$recoveryEnvironment = @{}
if ($workerExecutionMode -eq "recovery") {
    $recoveryEnvironment = @{
        BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID = Get-RequiredSetting `
            "BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID"
        BACKLINKS_RECOVERY_REFILL_JOB_ID = Get-RequiredSetting `
            "BACKLINKS_RECOVERY_REFILL_JOB_ID"
        BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID = Get-RequiredSetting `
            "BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID"
    }
}
$platformLocalDevelopmentAuthEnabled = Get-LocalSetting `
    "PLATFORM_LOCAL_DEVELOPMENT_AUTH_ENABLED" `
    "true"
if ($platformLocalDevelopmentAuthEnabled -notin @("true", "false")) {
    throw "PLATFORM_LOCAL_DEVELOPMENT_AUTH_ENABLED_INVALID"
}
$localProductOrganizationId = Get-RequiredSetting `
    "LOCAL_PRODUCT_ORGANIZATION_ID"
$localProductWorkspaceId = Get-RequiredSetting `
    "LOCAL_PRODUCT_WORKSPACE_ID"

$postgresPort = Get-PortSetting "POSTGRES_HOST_PORT" 5432
$redisPort = Get-PortSetting "REDIS_HOST_PORT" 6379
$minioApiPort = Get-PortSetting "MINIO_API_HOST_PORT" 9000
$temporalPort = Get-PortSetting "TEMPORAL_HOST_PORT" 7233
$temporalUiPort = Get-PortSetting "TEMPORAL_UI_HOST_PORT" 8233
$platformPort = Get-PortSetting "API_HOST_PORT" 8000
$frontendPort = Get-PortSetting "FRONTEND_DEV_HOST_PORT" 5173
$backlinksApiPort = Get-PortSetting "BACKLINKS_API_HOST_PORT" 7301
$backlinksWorkerHealthPort = Get-PortSetting `
    "BACKLINKS_WORKER_HEALTH_PORT" `
    7302
$browserWorkerEndpoint = Get-RequiredSetting "BROWSER_WORKER_ENDPOINT"
$browserWorkerUri = [Uri]::new($browserWorkerEndpoint)
if (
    $browserWorkerUri.Scheme -ne "http" -or
    $browserWorkerUri.Host -notin @("localhost", "127.0.0.1", "::1") -or
    $browserWorkerUri.Port -le 0
) {
    throw "BACKLINKS_BROWSER_WORKER_ENDPOINT_INVALID"
}
$crawlerProbeListenAddress = (
    "$($browserWorkerUri.Host):$($browserWorkerUri.Port)"
)

if ($googleOauthEnabled -eq "true") {
    $expectedGoogleOauthRedirectUri = (
        "http://localhost:$platformPort" +
        "/api/v1/backlinks/gmail-connections/callback"
    )
    if ($googleOauthRedirectUri -ne $expectedGoogleOauthRedirectUri) {
        throw "GMAIL_OAUTH_REDIRECT_URI_LOCAL_RUNTIME_MISMATCH"
    }
    $expectedBacklinksOauthFrontendOrigin = (
        "http://localhost:$frontendPort"
    )
    if (
        $backlinksOauthFrontendOrigin -ne
        $expectedBacklinksOauthFrontendOrigin
    ) {
        throw "GMAIL_OAUTH_FRONTEND_ORIGIN_LOCAL_RUNTIME_MISMATCH"
    }
}
$env:BACKLINKS_OAUTH_CALLBACK_URL = $googleOauthRedirectUri

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is not available. Start Docker Desktop first."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not installed."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm is not installed."
}

$runtimeStartMutex = [Threading.Mutex]::new(
    $false,
    "Local\GrowthOS.LocalProduct.$runtimeProfile"
)
$runtimeStartLockAcquired = $false
try {
    $runtimeStartLockAcquired = $runtimeStartMutex.WaitOne(0)
}
catch [Threading.AbandonedMutexException] {
    $runtimeStartLockAcquired = $true
}
if (-not $runtimeStartLockAcquired) {
    $runtimeStartMutex.Dispose()
    throw "LOCAL_PRODUCT_RUNTIME_START_IN_PROGRESS:$runtimeProfile"
}

try {
    Stop-RecordedProcesses
    Assert-PortAvailable "Backlinks Core API" $backlinksApiPort
    Assert-PortAvailable "Backlinks Core Worker" $backlinksWorkerHealthPort
    if ($browserProviderEnabled -eq "true") {
        Assert-PortAvailable "Crawler Browser Worker" $browserWorkerUri.Port
    }
    Assert-PortAvailable "Platform API" $platformPort
    Assert-PortAvailable "Frontend" $frontendPort

    Write-Host "Stopping Docker application containers..."
    Invoke-Compose `
        -ExtraArguments @(
            "stop",
            "api",
            "agent-worker",
            "content-worker",
            "crawler-worker",
            "keyword-worker",
            "frontend"
        ) `
        -AllowFailure | Out-Null

    Write-Host "Starting Docker infrastructure..."
    Invoke-Compose `
        -ExtraArguments @(
            "up",
            "-d",
            "postgres",
            "redis",
            "minio",
            "minio-init",
            "temporal"
        ) | Out-Null

    Wait-ForComposeService "postgres"
    Wait-ForComposeService "redis"
    Wait-ForComposeService "minio"
    Wait-ForComposeService "temporal"

    Build-CrawlerWorker

    $postgresContainerId = (
        & docker @composeArguments ps -q postgres |
            Select-Object -Last 1
    ).Trim()
    if (-not $postgresContainerId) {
        throw "PostgreSQL container was not found."
    }

    Write-Host "Applying shared database roles and Platform migrations..."
    Invoke-PostgresSql (Get-Content -LiteralPath $rolesFile -Raw)

    $encodedPostgresPassword = [Uri]::EscapeDataString($postgresPassword)
    Set-ProcessEnvironment @{
        DATABASE_URL = "postgresql+asyncpg://postgres:$encodedPostgresPassword@127.0.0.1:$postgresPort/seo"
    }
    $platformPython = Join-Path $apiDir ".venv\Scripts\python.exe"
    $uvicorn = Join-Path $apiDir ".venv\Scripts\uvicorn.exe"
    $alembic = Join-Path $apiDir ".venv\Scripts\alembic.exe"
    if (-not (Test-Path -LiteralPath $uvicorn)) {
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            throw "uv is not installed."
        }
        Push-Location $apiDir
        try {
            & uv sync
            if ($LASTEXITCODE -ne 0) {
                throw "uv sync failed."
            }
        }
        finally {
            Pop-Location
        }
    }
    Push-Location $apiDir
    try {
        & $alembic upgrade head
        if ($LASTEXITCODE -ne 0) {
            throw "Platform database migration failed."
        }
    }
    finally {
        Pop-Location
    }

    Repair-BacklinksHybridSchemaGap
    $backlinksHead = Invoke-PostgresScalar @"
  SELECT CASE
    WHEN to_regclass('backlinks.backlink_generation_input_pins') IS NULL
      THEN 'missing'
    WHEN (
      SELECT count(*) = 2 FROM information_schema.columns
      WHERE table_schema = 'backlinks'
        AND table_name = 'backlink_contact_enrichment_pages'
        AND column_name IN ('observed_page_url','contact_page_kind')
    )
      THEN '0103'
    WHEN to_regclass('backlinks.backlink_mail_reply_drafts') IS NOT NULL
      THEN '0102'
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'backlinks'
        AND table_name = 'provider_batch_requests'
        AND column_name = 'recommendation_job_id'
    )
      THEN '0101'
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'backlinks'
        AND table_name = 'backlink_recommendation_release_batch_items'
        AND column_name = 'resource_library_snapshot'
    )
      THEN '0100'
    WHEN to_regclass('backlinks.backlink_project_domain_ratings') IS NOT NULL
      THEN '0099'
    WHEN (
      SELECT count(*) = 2
        FROM pg_catalog.pg_policies
       WHERE schemaname = 'backlinks'
         AND policyname IN (
           'backlink_contact_recovery_candidate_read_policy',
           'backlink_contact_recovery_evidence_read_policy'
         )
         AND cmd = 'SELECT'
         AND roles = ARRAY['growthos_backlinks_owner']::name[]
         AND qual = 'true'
    )
      THEN '0095'
    WHEN (
      SELECT count(*) = 3
        FROM pg_catalog.pg_policies
       WHERE schemaname = 'backlinks'
         AND policyname IN (
           'backlink_contact_recovery_job_read_policy',
           'backlink_contact_recovery_inventory_read_policy',
           'backlink_contact_recovery_recommendation_read_policy'
         )
         AND cmd = 'SELECT'
         AND roles = ARRAY['growthos_backlinks_owner']::name[]
         AND qual = 'true'
    )
      THEN '0094'
    WHEN to_regprocedure(
      'backlinks.backlink_pool_v2_candidate_fact_reconciliation_verify()'
    ) IS NOT NULL
      THEN '0093'
    WHEN to_regclass(
      'backlinks.backlink_recommendation_pool_v2_timing_events'
    ) IS NOT NULL
    THEN '0092'
  WHEN to_regclass(
    'backlinks.backlink_recommendation_generation_candidates'
  ) IS NOT NULL
    THEN '0091'
  WHEN to_regprocedure(
    'backlinks.backlink_recommendation_pool_v2_generation_rotation_verify()'
  ) IS NOT NULL
    THEN '0090'
  WHEN to_regprocedure(
    'backlinks.backlink_recommendation_pool_v2_cross_generation_blueprint_verify()'
  ) IS NOT NULL
    THEN '0089'
  WHEN to_regprocedure(
    'backlinks.backlink_recommendation_pool_v2_evidence_replay_verify()'
  ) IS NOT NULL
    THEN '0088'
  WHEN to_regclass(
    'backlinks.backlink_send_intent_active_logical_message_uq'
  ) IS NOT NULL
    THEN '0079'
  WHEN to_regprocedure(
    'backlinks.backlink_list_contact_enrichment_recovery_scopes(integer)'
  ) IS NOT NULL
    THEN '0078'
  WHEN to_regprocedure(
    'backlinks.backlink_close_invalid_project_analysis_jobs(text,timestamp with time zone,integer)'
  ) IS NOT NULL
    THEN '0076'
  WHEN to_regprocedure(
    'backlinks.backlink_rearm_stale_project_analysis_events(text,timestamp with time zone,integer)'
  ) IS NOT NULL
    THEN '0075'
  WHEN to_regclass('backlinks.backlink_recommendation_generation_contracts') IS NULL
    THEN '0061'
  WHEN to_regclass('backlinks.backlink_recommendation_cooperation_path_facts') IS NULL
    THEN '0062'
  WHEN to_regclass('backlinks.backlink_ai_capability_windows') IS NULL
    THEN '0063'
  WHEN NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname IN (
       'backlink_rec_qualification_values_v3_2_ck',
       'backlink_rec_qualification_values_v3_3_ck'
     )
       AND conrelid =
         'backlinks.backlink_recommendation_qualification_facts'::regclass
  )
    THEN '0064'
  WHEN NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_commercial_discovery_batches'
       AND column_name='refill_job_id'
  )
    THEN '0065'
  WHEN to_regclass(
    'backlinks.backlink_commercial_batch_unowned_refill_idx'
  ) IS NULL
    THEN '0066'
  WHEN (
    EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname =
         'backlink_reply_match_candidate_scoped_assignment_uq'
         AND conrelid =
           'backlinks.backlink_reply_match_candidates'::regclass
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'backlinks'
         AND table_name = 'backlink_placement_candidates'
         AND column_name = 'planned_placement_id'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_placement_full_lineage_fk'
         AND conrelid = 'backlinks.backlink_placements'::regclass
    )
    AND EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgname =
         'backlink_placement_candidate_reply_lineage_guard'
         AND tgrelid =
           'backlinks.backlink_placement_candidates'::regclass
         AND NOT tgisinternal
    )
  )
    THEN '0074'
  WHEN (
    EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_commercial_refill_state_check'
         AND conrelid =
           'backlinks.backlink_commercial_inventory_policies'::regclass
         AND pg_get_constraintdef(oid) NOT LIKE '%waiting_contact%'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_commercial_visible_pool_target_check'
         AND conrelid =
           'backlinks.backlink_commercial_inventory_policies'::regclass
         AND pg_get_constraintdef(oid) LIKE '%100%'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_rec_refill_watermark_check'
         AND conrelid =
           'backlinks.backlink_recommendation_refills'::regclass
         AND pg_get_constraintdef(oid) LIKE '%100%'
    )
  )
    THEN '0073'
  WHEN (
    to_regclass(
      'backlinks.backlink_commercial_supply_operations'
    ) IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'backlinks'
         AND tablename = 'backlink_commercial_supply_operations'
         AND policyname = 'backlink_supply_operation_tenant_policy'
    )
  )
    THEN '0072'
  WHEN (
    EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_rec_inventory_fit_version_check'
         AND conrelid =
           'backlinks.backlink_recommendation_inventory'::regclass
         AND pg_get_constraintdef(oid) LIKE
           '%recommendation-commercial-fit.v4%'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgname =
         'backlink_rec_inventory_legacy_v3_publication_guard'
         AND tgrelid =
           'backlinks.backlink_recommendation_inventory'::regclass
         AND NOT tgisinternal
    )
  )
    THEN '0071'
  WHEN EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'backlink_rec_qualification_values_v3_3_ck'
       AND conrelid =
         'backlinks.backlink_recommendation_qualification_facts'::regclass
  )
    THEN '0070'
  WHEN EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'backlink_commercial_candidate_state_check'
       AND conrelid =
         'backlinks.backlink_commercial_candidates'::regclass
       AND pg_get_constraintdef(oid) LIKE '%enrichment_eligible%'
  )
    THEN '0069'
  WHEN (
    EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_rec_cooperation_tenant_identity_uq'
         AND conrelid =
           'backlinks.backlink_recommendation_cooperation_path_facts'::regclass
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'backlinks'
         AND table_name = 'backlink_opportunities'
         AND column_name = 'engagement_channel'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'backlinks'
         AND table_name = 'backlink_opportunities'
         AND column_name = 'source_cooperation_path_fact_id'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_opportunity_source_cooperation_path_fk'
         AND conrelid = 'backlinks.backlink_opportunities'::regclass
    )
    AND to_regclass(
      'backlinks.backlink_opportunity_source_cooperation_path_idx'
    ) IS NOT NULL
    AND to_regclass(
      'backlinks.backlink_opportunity_manual_actions'
    ) IS NOT NULL
    AND to_regclass(
      'backlinks.backlink_opportunity_manual_action_events'
    ) IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM pg_trigger
       WHERE tgname =
         'backlink_opportunity_manual_action_events_immutable'
         AND tgrelid =
           'backlinks.backlink_opportunity_manual_action_events'::regclass
         AND NOT tgisinternal
    )
    AND EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'backlinks'
         AND tablename = 'backlink_opportunity_manual_actions'
         AND policyname =
           'backlink_opportunity_manual_action_tenant_policy'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'backlinks'
         AND tablename = 'backlink_opportunity_manual_action_events'
         AND policyname =
           'backlink_opportunity_manual_event_tenant_policy'
    )
  )
    THEN '0068'
  WHEN (
    NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'backlink_rec_cooperation_tenant_identity_uq'
         AND conrelid =
           'backlinks.backlink_recommendation_cooperation_path_facts'::regclass
    )
    AND NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'backlinks'
         AND table_name = 'backlink_opportunities'
         AND column_name IN (
           'engagement_channel',
           'source_cooperation_path_fact_id'
         )
    )
    AND to_regclass(
      'backlinks.backlink_opportunity_manual_actions'
    ) IS NULL
    AND to_regclass(
      'backlinks.backlink_opportunity_manual_action_events'
    ) IS NULL
  )
    THEN '0067'
  ELSE '0068-partial'
END;
"@
    $backlinksMigrationStart = $null
    if ($backlinksHead -eq "missing") {
        $backlinksFoundation = Invoke-PostgresScalar @"
SELECT CASE
  WHEN to_regclass('backlinks.backlink_project_context_snapshots') IS NOT NULL
    OR to_regclass('public.backlink_project_context_snapshots') IS NOT NULL
    THEN 'present'
  ELSE 'absent'
END;
"@
        if ($backlinksFoundation -ne "absent") {
            throw "BACKLINKS_SCHEMA_PARTIAL: apply the reviewed M1B forward upgrade before startup"
        }
        $backlinksMigrationStart = "0001"
    }
    elseif ($backlinksHead -eq $backlinksTargetHead) {
        $backlinksMigrationStart = $null
    }
    elseif (
        $backlinksHead -match "^\d{4}$" -and
        [int]$backlinksHead -lt [int]$backlinksTargetHead
    ) {
        $backlinksMigrationStart = "{0:D4}" -f (
            [int]$backlinksHead + 1
        )
    }
    else {
        throw "BACKLINKS_SCHEMA_UNKNOWN_HEAD: detected '$backlinksHead'"
    }
    if ($null -ne $backlinksMigrationStart) {
        Write-Host "Applying Backlinks migrations from $backlinksMigrationStart through $backlinksTargetHead..."
        Invoke-BacklinksMigrations -Start $backlinksMigrationStart -Target $backlinksTargetHead
    }

    if ($platformLocalDevelopmentAuthEnabled -eq "true") {
        Write-Host "Reconciling legacy local project tenants..."
        Invoke-PostgresSql `
            -Sql (
                Get-Content `
                    -LiteralPath $localProjectTenantReconciliationFile `
                    -Raw
            ) `
            -Variables @(
                "canonical_organization_id=$localProductOrganizationId",
                "canonical_workspace_id=$localProductWorkspaceId"
            )
    }

    $localRoleSql = @'
DO $roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'growthos_backlinks_local'
  ) THEN
    CREATE ROLE growthos_backlinks_local;
  END IF;
END;
$roles$;
ALTER ROLE growthos_backlinks_local
  WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
       NOREPLICATION NOBYPASSRLS PASSWORD :'login_password';
GRANT growthos_backlinks_writer TO growthos_backlinks_local;
ALTER ROLE growthos_backlinks_local SET row_security = on;
ALTER ROLE growthos_backlinks_local
  SET search_path = backlinks, pg_catalog;
'@
    Invoke-PostgresSql `
        -Sql $localRoleSql `
        -Variables @("login_password=$backlinksDatabasePassword")

    $encodedBacklinksPassword = [Uri]::EscapeDataString(
        $backlinksDatabasePassword
    )
    $backlinksDatabaseUrl = (
        "postgresql://growthos_backlinks_local:" +
        "$encodedBacklinksPassword@127.0.0.1:$postgresPort/seo"
    )
    Set-Content `
        -LiteralPath $databaseSecretFile `
        -Value $backlinksDatabaseUrl `
        -NoNewline `
        -Encoding utf8
    Set-Content `
        -LiteralPath $signingKeySecretFile `
        -Value $platformContextSigningKey `
        -NoNewline `
        -Encoding utf8

    if (-not (Test-Path -LiteralPath (Join-Path $coreDir "node_modules"))) {
        Push-Location $coreDir
        try {
            & npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "Backlinks Core npm ci failed."
            }
        }
        finally {
            Pop-Location
        }
    }
    Push-Location $coreDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Backlinks Core build failed."
        }
        & npm run local-product:build-identity:check
        if ($LASTEXITCODE -ne 0) {
            throw "Backlinks Core build identity check failed."
        }
    }
    finally {
        Pop-Location
    }
    $buildIdentity = Get-Content `
        -LiteralPath (Join-Path $coreDir "dist\local-product-build-identity.json") `
        -Raw |
        ConvertFrom-Json
    $buildId = [string]$buildIdentity.buildId

    $providerEnvironment = @{
        BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT"
        BACKLINKS_PROFILE_SYNC_MODE = Get-LocalSetting "BACKLINKS_PROFILE_SYNC_MODE" "automatic"
        DATAFORSEO_ENABLED = $dataForSeoEnabled
        DATAFORSEO_EXTERNAL_AVAILABILITY = $dataForSeoAvailability
        DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON = (
            $dataForSeoUnavailableReason
        )
        DATAFORSEO_CREDENTIAL_SECRET_REF = Get-RequiredSetting `
            "DATAFORSEO_CREDENTIAL_SECRET_REF"
        DATAFORSEO_ENDPOINT_ALLOWLIST = Get-RequiredSetting `
            "DATAFORSEO_ENDPOINT_ALLOWLIST"
        DATAFORSEO_REQUEST_TIMEOUT_MS = Get-RequiredSetting `
            "DATAFORSEO_REQUEST_TIMEOUT_MS"
        DATAFORSEO_ESTIMATED_COST_MICROS = Get-RequiredSetting `
            "DATAFORSEO_ESTIMATED_COST_MICROS"
        DATAFORSEO_ABSOLUTE_BUDGET_MICROS = Get-RequiredSetting `
            "DATAFORSEO_ABSOLUTE_BUDGET_MICROS"
        DATAFORSEO_MAX_PAID_CALLS = Get-RequiredSetting `
            "DATAFORSEO_MAX_PAID_CALLS"
        DATAFORSEO_CANDIDATE_LIMIT = Get-RequiredSetting `
            "DATAFORSEO_CANDIDATE_LIMIT"
        DATAFORSEO_DISCOVERY_CONCURRENCY = Get-LocalSetting `
            "DATAFORSEO_DISCOVERY_CONCURRENCY" `
            "2"
        DATAFORSEO_QUALIFICATION_CONCURRENCY = Get-LocalSetting `
            "DATAFORSEO_QUALIFICATION_CONCURRENCY" `
            "2"
        BROWSER_PROVIDER_ENABLED = $browserProviderEnabled
        BROWSER_PROVIDER_EXTERNAL_AVAILABILITY = (
            $browserProviderAvailability
        )
        BROWSER_PROVIDER_EXTERNAL_UNAVAILABLE_REASON = (
            $browserProviderUnavailableReason
        )
        BROWSER_WORKER_ENDPOINT = $browserWorkerEndpoint
        BROWSER_WORKER_TIMEOUT_MS = Get-LocalSetting `
            "BROWSER_WORKER_TIMEOUT_MS" `
            "20000"
        AI_PROVIDER_ENABLED = $aiProviderEnabled
        AI_PROVIDER_EXTERNAL_AVAILABILITY = $aiProviderAvailability
        AI_PROVIDER_EXTERNAL_UNAVAILABLE_REASON = (
            $aiProviderUnavailableReason
        )
        GOOGLE_OAUTH_ENABLED = $googleOauthEnabled
        GOOGLE_OAUTH_CLIENT_ID = $googleOauthClientId
        GOOGLE_OAUTH_CLIENT_SECRET_REF = (
            $googleOauthClientSecretReference
        )
        GOOGLE_OAUTH_REDIRECT_URI = $googleOauthRedirectUri
        GMAIL_SEND_ENABLED = $gmailSendEnabled
        GMAIL_SYNC_ENABLED = $gmailSyncEnabled
        GMAIL_EXTERNAL_AVAILABILITY = $gmailProviderAvailability
        GMAIL_EXTERNAL_UNAVAILABLE_REASON = (
            $gmailProviderUnavailableReason
        )
        PLATFORM_SECRET_STORE_ENABLED = $platformSecretStoreEnabled
        PLATFORM_SECRET_STORE_PROVIDER = Get-RequiredSetting `
            "PLATFORM_SECRET_STORE_PROVIDER"
        PLATFORM_SECRET_STORE_ROOT = $secretStoreRoot
        RESOURCE_LIBRARY_SQLITE_PATH = Get-LocalSetting "RESOURCE_LIBRARY_SQLITE_PATH"
        RESOURCE_LIBRARY_ENABLED = Get-LocalSetting "RESOURCE_LIBRARY_ENABLED" "true"
        AHREFS_CREDENTIAL_SECRET_REF = Get-LocalSetting "AHREFS_CREDENTIAL_SECRET_REF"
        LOCALAPPDATA = $localAppData
    }
    foreach ($aiSetting in $aiProviderEnvironment.GetEnumerator()) {
        $providerEnvironment[$aiSetting.Key] = $aiSetting.Value
    }
    foreach ($proxySetting in @{
        HTTP_PROXY = $outboundHttpProxy
        HTTPS_PROXY = $outboundHttpsProxy
        NO_PROXY = $outboundNoProxy
        NODE_USE_ENV_PROXY = $nodeUseEnvProxy
    }.GetEnumerator()) {
        if ($proxySetting.Value) {
            $providerEnvironment[$proxySetting.Key] = $proxySetting.Value
        }
    }
    $coreEnvironment = @{
        BACKLINKS_RUNTIME_MODULE = (
            Join-Path $coreDir `
                "dist\modules\backlinks\runtime\production-runtime.js"
        )
        DATABASE_URL_SECRET_REF = "local/m1c/backlinks-database-url"
        DATABASE_URL_FILE = $databaseSecretFile
        BACKLINK_DB_STATEMENT_TIMEOUT_MS = "30000"
        BACKLINK_DB_LOCK_TIMEOUT_MS = "5000"
        BACKLINK_DB_POOL_MAX = "10"
        BACKLINK_DB_IDLE_TIMEOUT_MS = "30000"
        BACKLINK_DB_CONNECT_TIMEOUT_MS = "10000"
        TEMPORAL_ADDRESS = "127.0.0.1:$temporalPort"
        TEMPORAL_NAMESPACE = "default"
        TEMPORAL_BACKLINKS_TASK_QUEUE = "growthos.backlinks.v1"
        TEMPORAL_BUILD_ID = $buildId
        BACKLINK_API_BODY_LIMIT = "1048576"
        BACKLINK_API_REQUEST_TIMEOUT_MS = "30000"
        BACKLINKS_HOST = "127.0.0.1"
        BACKLINKS_PORT = [string]$backlinksApiPort
        BACKLINKS_WORKER_EXECUTION_MODE = $workerExecutionMode
        BACKLINKS_WORKER_HEALTH_HOST = "127.0.0.1"
        BACKLINKS_WORKER_HEALTH_PORT = [string]$backlinksWorkerHealthPort
        PLATFORM_CONTEXT_SIGNING_KEY_SECRET_REF = (
            "local/m1c/platform-context-signing-key"
        )
        PLATFORM_CONTEXT_SIGNING_KEY_FILE = $signingKeySecretFile
        LOCAL_PRODUCT_ORGANIZATION_ID = $localProductOrganizationId
        LOCAL_PRODUCT_WORKSPACE_ID = $localProductWorkspaceId
        LOCAL_PRODUCT_USER_ID = Get-RequiredSetting "LOCAL_PRODUCT_USER_ID"
    }
    foreach ($recoveryName in @(
        "BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID",
        "BACKLINKS_RECOVERY_REFILL_JOB_ID",
        "BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID"
    )) {
        Remove-Item -Path "Env:$recoveryName" -ErrorAction SilentlyContinue
    }
    foreach ($recoverySetting in $recoveryEnvironment.GetEnumerator()) {
        $coreEnvironment[$recoverySetting.Key] = $recoverySetting.Value
    }
    Set-ProcessEnvironment $providerEnvironment
    Set-ProcessEnvironment $coreEnvironment
    $archiveLocalDirectory = Get-LocalSetting "PROVIDER_ARCHIVE_LOCAL_DIR" (
        Join-Path $root "storage\provider-archive"
    )
    $archiveLocalConfigPath = Join-Path $archiveLocalDirectory "local-config.json"
    $archiveLocalConfig = $null
    if (
        (Test-Path -LiteralPath $archiveLocalConfigPath) -and
        -not (Get-LocalSetting "PROVIDER_ARCHIVE_CENTER_URL") -and
        (Get-LocalSetting "PROVIDER_ARCHIVE_ENABLED") -ne "false"
    ) {
        $archiveLocalConfig = Get-Content -LiteralPath $archiveLocalConfigPath -Raw |
            ConvertFrom-Json
    }
    $archiveEnvironment = @{
        PROVIDER_ARCHIVE_ENABLED = Get-LocalSetting "PROVIDER_ARCHIVE_ENABLED" "false"
        PROVIDER_ARCHIVE_DEPLOYMENT_ID = Get-LocalSetting "PROVIDER_ARCHIVE_DEPLOYMENT_ID"
        PROVIDER_ARCHIVE_SPOOL_DIR = Get-LocalSetting "PROVIDER_ARCHIVE_SPOOL_DIR"
        PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES = Get-LocalSetting "PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES" "33554432"
        PROVIDER_ARCHIVE_MAX_PENDING = Get-LocalSetting "PROVIDER_ARCHIVE_MAX_PENDING" "100000"
        PROVIDER_ARCHIVE_CENTER_URL = Get-LocalSetting "PROVIDER_ARCHIVE_CENTER_URL"
        PROVIDER_ARCHIVE_UPLOAD_TOKEN_FILE = Get-LocalSetting "PROVIDER_ARCHIVE_UPLOAD_TOKEN_FILE"
        PROVIDER_ARCHIVE_UPLOAD_TIMEOUT_MS = Get-LocalSetting "PROVIDER_ARCHIVE_UPLOAD_TIMEOUT_MS" "30000"
        PROVIDER_ARCHIVE_UPLOAD_BATCH_SIZE = Get-LocalSetting "PROVIDER_ARCHIVE_UPLOAD_BATCH_SIZE" "20"
        PROVIDER_ARCHIVE_RETRY_BASE_MS = Get-LocalSetting "PROVIDER_ARCHIVE_RETRY_BASE_MS" "5000"
        PROVIDER_ARCHIVE_RETRY_MAX_MS = Get-LocalSetting "PROVIDER_ARCHIVE_RETRY_MAX_MS" "300000"
        PROVIDER_ARCHIVE_UPLOAD_INTERVAL_MS = Get-LocalSetting "PROVIDER_ARCHIVE_UPLOAD_INTERVAL_MS" "5000"
    }
    if ($archiveLocalConfig) {
        foreach ($key in @(
            "PROVIDER_ARCHIVE_ENABLED", "PROVIDER_ARCHIVE_DEPLOYMENT_ID",
            "PROVIDER_ARCHIVE_SPOOL_DIR", "PROVIDER_ARCHIVE_CENTER_URL",
            "PROVIDER_ARCHIVE_UPLOAD_TOKEN_FILE"
        )) {
            $archiveEnvironment[$key] = [string]$archiveLocalConfig.$key
        }
    }
    Set-ProcessEnvironment $archiveEnvironment
    $archivePythonPath = Join-Path $root "backend\provider_archive"
    $pythonPaths = @($archivePythonPath, $env:PYTHONPATH) | Where-Object { $_ }
    $env:PYTHONPATH = $pythonPaths -join [IO.Path]::PathSeparator
    if ($archiveLocalConfig -and $archiveEnvironment.PROVIDER_ARCHIVE_ENABLED -eq "true") {
        & (Join-Path $root "scripts\provider-archive-local.ps1") `
            -Action start -DataDirectory $archiveLocalDirectory
    }
    elseif ($archiveEnvironment.PROVIDER_ARCHIVE_ENABLED -eq "true") {
        $archiveErrorLog = Join-Path $runtimeDir "provider-archive.stderr.log"
        $archiveProcess = Start-Process `
            -FilePath (Get-Command node).Source `
            -ArgumentList @("dist/modules/provider-archive/cli.js", "upload") `
            -WorkingDirectory $coreDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $runtimeDir "provider-archive.stdout.log") `
            -RedirectStandardError $archiveErrorLog `
            -PassThru
        Register-ManagedProcess `
            -Name "Provider Archive Uploader" `
            -Process $archiveProcess `
            -ExpectedCommand "dist/modules/provider-archive/cli.js upload"
        Assert-ManagedProcessRunning `
            -Name "Provider Archive Uploader" `
            -Process $archiveProcess `
            -StandardErrorPath $archiveErrorLog
    }

    $env:BACKLINKS_API_ENABLED = "true"
    $env:BACKLINKS_WORKER_ENABLED = "false"
    $coreApiErrorLog = Join-Path $runtimeDir "core-api.stderr.log"
    $coreApiProcess = Start-Process `
        -FilePath (Get-Command node).Source `
        -ArgumentList @("dist/index.js", "api") `
        -WorkingDirectory $coreDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "core-api.stdout.log") `
        -RedirectStandardError $coreApiErrorLog `
        -PassThru
    Register-ManagedProcess `
        -Name "Backlinks Core API" `
        -Process $coreApiProcess `
        -ExpectedCommand "dist/index.js api"
    Assert-ManagedProcessRunning `
        -Name "Backlinks Core API" `
        -Process $coreApiProcess `
        -StandardErrorPath $coreApiErrorLog

    $env:BACKLINKS_API_ENABLED = "false"
    $env:BACKLINKS_WORKER_ENABLED = "true"
    if ($workerExecutionMode -eq "quiesced") {
        $workerArguments = @("scripts/local-product-quiesced-worker.mjs")
        $workerExpectedCommand = "local-product-quiesced-worker.mjs"
    }
    else {
        $workerArguments = @("dist/index.js", "worker")
        $workerExpectedCommand = "dist/index.js worker"
    }
    $coreWorkerErrorLog = Join-Path $runtimeDir "core-worker.stderr.log"
    $coreWorkerProcess = Start-Process `
        -FilePath (Get-Command node).Source `
        -ArgumentList $workerArguments `
        -WorkingDirectory $coreDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "core-worker.stdout.log") `
        -RedirectStandardError $coreWorkerErrorLog `
        -PassThru
    Register-ManagedProcess `
        -Name "Backlinks Core Worker" `
        -Process $coreWorkerProcess `
        -ExpectedCommand $workerExpectedCommand
    Assert-ManagedProcessRunning `
        -Name "Backlinks Core Worker" `
        -Process $coreWorkerProcess `
        -StandardErrorPath $coreWorkerErrorLog

    Set-ProcessEnvironment @{
        APP_ENV = "development"
        GROWTHOS_RUNTIME_MODE = $growthosRuntimeMode
        PLATFORM_BACKGROUND_DISPATCH_ENABLED = (
            $platformBackgroundDispatchEnabled
        )
        AGENT_BACKGROUND_DISPATCH_ENABLED = $agentBackgroundDispatchEnabled
        AGENT_SYSTEM_TRIGGER_DISPATCH_ENABLED = $agentSystemTriggerDispatchEnabled
        PLATFORM_LOCAL_DEVELOPMENT_AUTH_ENABLED = (
            $platformLocalDevelopmentAuthEnabled
        )
        DATABASE_URL = "postgresql+asyncpg://postgres:$encodedPostgresPassword@127.0.0.1:$postgresPort/seo"
        REDIS_URL = "redis://127.0.0.1:$redisPort/0"
        TEMPORAL_ADDRESS = "127.0.0.1:$temporalPort"
        TEMPORAL_NAMESPACE = "default"
        CRAWLER_WORKER_EXECUTABLE = $crawlerExe
        CRAWLER_WORKER_START_ON_BOOT = $browserProviderEnabled
        CRAWLER_WORKER_IDLE_TIMEOUT_SECONDS = "0"
        CRAWLER_PROBE_LISTEN_ADDRESS = $crawlerProbeListenAddress
        S3_ENDPOINT_URL = "http://127.0.0.1:$minioApiPort"
        S3_REGION = "us-east-1"
        S3_BUCKET = "seo-crawler"
        S3_ACCESS_KEY_ID = $minioRootUser
        S3_SECRET_ACCESS_KEY = $minioRootPassword
        S3_USE_PATH_STYLE = "true"
        S3_CREATE_BUCKET = "true"
        BACKLINKS_PRIVATE_BASE_URL = "http://127.0.0.1:$backlinksApiPort"
        BACKLINKS_WORKER_HEALTH_URL = (
            "http://127.0.0.1:$backlinksWorkerHealthPort/health"
        )
        BACKLINKS_EXPECTED_BUILD_ID = $buildId
        BACKLINKS_TASK_QUEUE = "growthos.backlinks.v1"
        BACKLINKS_PROJECT_PROJECTION_ENABLED = (
            $backlinksProjectProjectionEnabled
        )
        BACKLINKS_OAUTH_FRONTEND_ORIGIN = (
            $backlinksOauthFrontendOrigin
        )
        BACKLINKS_OAUTH_CALLBACK_URL = (
            $googleOauthRedirectUri
        )
        BACKLINKS_REQUEST_TIMEOUT_SECONDS = (
            $backlinksRequestTimeoutSeconds
        )
        PLATFORM_CONTEXT_SIGNING_KEY = $platformContextSigningKey
        LOCAL_PRODUCT_ORGANIZATION_ID = $localProductOrganizationId
        LOCAL_PRODUCT_WORKSPACE_ID = $localProductWorkspaceId
        LOCAL_PRODUCT_USER_ID = Get-RequiredSetting "LOCAL_PRODUCT_USER_ID"
        DATAFORSEO_LOGIN = ""
        DATAFORSEO_PASSWORD = ""
        BUSINESS_PROFILE_AI_BASE_URL = Get-LocalSetting "BUSINESS_PROFILE_AI_BASE_URL"
        BUSINESS_PROFILE_AI_API_KEY = Get-LocalSetting "BUSINESS_PROFILE_AI_API_KEY"
        BUSINESS_PROFILE_AI_MODEL = Get-LocalSetting "BUSINESS_PROFILE_AI_MODEL" "gpt-5.5"
        BUSINESS_PROFILE_AI_MAX_RETRIES = Get-LocalSetting "BUSINESS_PROFILE_AI_MAX_RETRIES" "1"
        ARTICLE_RESEARCH_PROVIDER = ""
        ARTICLE_RESEARCH_API_KEY = ""
        ARTICLE_AI_IMAGE_BASE_URL = ""
        ARTICLE_AI_IMAGE_API_KEY = ""
        GOOGLE_PAGESPEED_API_KEY = ""
    }
    $platformApiErrorLog = Join-Path $runtimeDir "platform-api.stderr.log"
    $platformApiProcess = Start-Process `
        -FilePath $platformPython `
        -ArgumentList @(
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            [string]$platformPort
        ) `
        -WorkingDirectory $apiDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "platform-api.stdout.log") `
        -RedirectStandardError $platformApiErrorLog `
        -PassThru
    Register-ManagedProcess `
        -Name "Platform API" `
        -Process $platformApiProcess `
        -ExpectedCommand "-m uvicorn app.main:app"
    Assert-ManagedProcessRunning `
        -Name "Platform API" `
        -Process $platformApiProcess `
        -StandardErrorPath $platformApiErrorLog

    $agentWorkerErrorLog = Join-Path $runtimeDir "agent-worker.stderr.log"
    $agentWorkerProcess = Start-Process `
        -FilePath $platformPython `
        -ArgumentList @("-m", "app.workflows.agent_worker") `
        -WorkingDirectory $apiDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "agent-worker.stdout.log") `
        -RedirectStandardError $agentWorkerErrorLog `
        -PassThru
    Register-ManagedProcess `
        -Name "Agent Worker" `
        -Process $agentWorkerProcess `
        -ExpectedCommand "-m app.workflows.agent_worker"
    Assert-ManagedProcessRunning `
        -Name "Agent Worker" `
        -Process $agentWorkerProcess `
        -StandardErrorPath $agentWorkerErrorLog

    if (-not (Test-Path -LiteralPath (Join-Path $frontendDir "node_modules"))) {
        Push-Location $frontendDir
        try {
            & npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "Frontend npm ci failed."
            }
        }
        finally {
            Pop-Location
        }
    }
    $env:VITE_API_PROXY_TARGET = "http://127.0.0.1:$platformPort"
    $frontendErrorLog = Join-Path $runtimeDir "frontend.stderr.log"
    $viteCli = Join-Path $frontendDir "node_modules\vite\bin\vite.js"
    $frontendProcess = Start-Process `
        -FilePath (Get-Command node).Source `
        -ArgumentList @(
            $viteCli,
            "--host",
            "localhost",
            "--port",
            [string]$frontendPort
        ) `
        -WorkingDirectory $frontendDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "frontend.stdout.log") `
        -RedirectStandardError $frontendErrorLog `
        -PassThru
    Register-ManagedProcess `
        -Name "Frontend" `
        -Process $frontendProcess `
        -ExpectedCommand "vite.js"
    Assert-ManagedProcessRunning `
        -Name "Frontend" `
        -Process $frontendProcess `
        -StandardErrorPath $frontendErrorLog

    $coreApiHealthUrl = "http://127.0.0.1:$backlinksApiPort/health"
    $workerHealthUrl = (
        "http://127.0.0.1:$backlinksWorkerHealthPort/health"
    )
    $platformHealthUrl = "http://127.0.0.1:$platformPort/health"
    $frontendUrl = "http://localhost:$frontendPort"
    $runtimeStatusUrl = (
        "http://127.0.0.1:$platformPort/api/v1/runtime-status"
    )

    Wait-ForUrl "Backlinks Core API" $coreApiHealthUrl
    Wait-ForUrl "Backlinks Core Worker" $workerHealthUrl
    Wait-ForUrl "Platform API" $platformHealthUrl
    Wait-ForUrl "Frontend" $frontendUrl

    Assert-ManagedProcessRunning `
        -Name "Backlinks Core API" `
        -Process $coreApiProcess `
        -StandardErrorPath $coreApiErrorLog
    Assert-ManagedProcessRunning `
        -Name "Backlinks Core Worker" `
        -Process $coreWorkerProcess `
        -StandardErrorPath $coreWorkerErrorLog
    Assert-ManagedProcessRunning `
        -Name "Platform API" `
        -Process $platformApiProcess `
        -StandardErrorPath $platformApiErrorLog
    Assert-ManagedProcessRunning `
        -Name "Frontend" `
        -Process $frontendProcess `
        -StandardErrorPath $frontendErrorLog

    $runtimeStatus = Invoke-RestMethod `
        -Uri $runtimeStatusUrl `
        -TimeoutSec 5
    if (-not $runtimeStatus.core_api.running) {
        throw "M1C_CORE_API_HEALTH_INVALID"
    }
    if (-not $runtimeStatus.worker.process_running) {
        throw "M1C_WORKER_HEALTH_INVALID"
    }
    if (
        -not $runtimeStatus.worker.postgres_ready -or
        -not $runtimeStatus.worker.temporal_ready
    ) {
        throw "M1C_WORKER_INFRASTRUCTURE_HEALTH_INVALID"
    }
    if (
        $runtimeStatus.core_api.build_id -ne $buildId -or
        $runtimeStatus.worker.build_id -ne $buildId
    ) {
        throw "M1C_BUILD_IDENTITY_DRIFT"
    }
    if ($runtimeStatus.worker.execution_mode -ne $workerExecutionMode) {
        throw "M1C_WORKER_DESIRED_STATE_DRIFT"
    }
    if ($runtimeStatus.mode -ne $growthosRuntimeMode) {
        throw "M1C_RUNTIME_MODE_DRIFT"
    }
    if ($growthosRuntimeMode -eq "PRODUCT") {
        if (
            -not $runtimeStatus.platform.background_dispatch_enabled -or
            -not $runtimeStatus.platform.project_context_projection_enabled -or
            -not $runtimeStatus.platform.project_context_dispatcher_running
        ) {
            throw "M1C_PLATFORM_PRODUCT_DISPATCH_INVALID"
        }
    }
    elseif (
        $runtimeStatus.platform.background_dispatch_enabled -or
        $runtimeStatus.platform.project_context_projection_enabled -or
        $runtimeStatus.platform.project_context_dispatcher_running
    ) {
        throw "M1C_PLATFORM_NON_PRODUCT_DISPATCH_INVALID"
    }
    if ($workerExecutionMode -ne "normal") {
        if ($runtimeStatus.status -ne "maintenance") {
            throw "M1C_MAINTENANCE_STATUS_INVALID"
        }
        if ($runtimeStatus.business_consumers_running) {
            throw "M1C_MAINTENANCE_CONSUMERS_INVALID"
        }
    }
    else {
        if (
            $runtimeStatus.status -ne "ok" -or
            -not $runtimeStatus.business_consumers_running
        ) {
            throw "M1C_NORMAL_STATUS_INVALID"
        }
    }
    Assert-ProviderRuntimeStatus `
        -Provider $runtimeStatus.providers.data_for_seo `
        -Name "data_for_seo" `
        -ExpectedAvailability $dataForSeoAvailability `
        -UnavailableReason $dataForSeoUnavailableReason
    Assert-ProviderRuntimeStatus `
        -Provider $runtimeStatus.providers.browser `
        -Name "browser" `
        -ExpectedAvailability $browserProviderAvailability `
        -UnavailableReason $browserProviderUnavailableReason
    if ($aiProviderEnabled -eq "true") {
        Assert-ProviderRuntimeStatus `
            -Provider $runtimeStatus.providers.ai `
            -Name "ai" `
            -ExpectedAvailability $aiProviderAvailability `
            -UnavailableReason $aiProviderUnavailableReason
    }
    else {
        $provider = $runtimeStatus.providers.ai
        if (
            $provider.configured -or
            $provider.external_availability -ne "disabled" -or
            $provider.reason_code -ne "provider_disabled" -or
            $provider.recovery_action -ne "enable_provider"
        ) {
            throw "PHASE1_PROVIDER_ACTION_BLOCKED:ai"
        }
    }
    if ($googleOauthEnabled -eq "true") {
        Assert-ProviderRuntimeStatus `
            -Provider $runtimeStatus.providers.gmail `
            -Name "gmail" `
            -ExpectedAvailability $gmailProviderAvailability `
            -UnavailableReason $gmailProviderUnavailableReason
    }
    else {
        $gmailProvider = $runtimeStatus.providers.gmail
        if (
            $gmailProvider.configured -or
            $gmailProvider.external_availability -ne "disabled" -or
            $gmailProvider.reason_code -ne "provider_disabled" -or
            $gmailProvider.recovery_action -ne "enable_provider"
        ) {
            throw "PHASE1_PROVIDER_ACTION_BLOCKED:gmail"
        }
    }

    Write-Host ""
    Write-Host "SEO workspace:      $frontendUrl"
    Write-Host "Platform API:       http://127.0.0.1:$platformPort"
    Write-Host "Backlinks Core API: http://127.0.0.1:$backlinksApiPort"
    Write-Host "Worker health:      $workerHealthUrl"
    Write-Host "Temporal UI:        http://127.0.0.1:$temporalUiPort"
    Write-Host "Runtime status:"
    $runtimeStatus | ConvertTo-Json -Depth 6
}
catch {
    Stop-RecordedProcesses
    throw
}
finally {
    if ($runtimeStartLockAcquired) {
        $runtimeStartMutex.ReleaseMutex()
    }
    $runtimeStartMutex.Dispose()
}
