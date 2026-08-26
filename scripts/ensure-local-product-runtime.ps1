param(
    [string]$EnvironmentFile = "",
    [string]$ComposeProjectName = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$devUp = Join-Path $PSScriptRoot "dev-up.ps1"
$devDown = Join-Path $PSScriptRoot "dev-down.ps1"
$coreDir = Join-Path $root "backend\core"
if (-not $EnvironmentFile) {
    $EnvironmentFile = Join-Path $root "deploy\compose\.env"
}
$resolvedEnvironmentFile = (
    Resolve-Path -LiteralPath $EnvironmentFile
).Path

function Get-LocalSetting {
    param(
        [string]$Name,
        [string]$Default = ""
    )

    $line = Get-Content -LiteralPath $resolvedEnvironmentFile |
        Where-Object {
            $_ -match "^\s*$([regex]::Escape($Name))\s*="
        } |
        Select-Object -Last 1
    if (-not $line) {
        return $Default
    }
    return ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
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
$logPath = Join-Path $runtimeDir "runtime-watchdog.log"
$platformPort = Get-LocalSetting "API_HOST_PORT" "8000"
$runtimeStatusUrl = (
    "http://127.0.0.1:$platformPort/api/v1/runtime-status"
)

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if (
    (Test-Path -LiteralPath $logPath) -and
    (Get-Item -LiteralPath $logPath).Length -gt 5MB
) {
    Move-Item `
        -LiteralPath $logPath `
        -Destination "$logPath.previous" `
        -Force
}

function Write-WatchdogLog {
    param([string]$Message)

    Add-Content `
        -LiteralPath $logPath `
        -Value "$(Get-Date -Format o) $Message" `
        -Encoding utf8
}

function Copy-ManagedOutputToWatchdogLog {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    for ($attempt = 1; $attempt -le 20; $attempt += 1) {
        $stream = $null
        $reader = $null
        try {
            $stream = [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite
            )
            $reader = [System.IO.StreamReader]::new($stream)
            $content = $reader.ReadToEnd()
            $reader.Dispose()
            $reader = $null
            $stream = $null
            if ($content) {
                Add-Content `
                    -LiteralPath $logPath `
                    -Value $content.TrimEnd("`r", "`n") `
                    -Encoding utf8
            }
            try {
                Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
            }
            catch [System.IO.IOException] {
                Write-WatchdogLog (
                    "Managed output retained because it is still shared. " +
                    "path=$Path"
                )
            }
            return
        }
        catch [System.IO.IOException] {
            if ($attempt -eq 20) {
                Write-WatchdogLog (
                    "Managed output unavailable; recovery result preserved. " +
                    "path=$Path"
                )
                return
            }
            Start-Sleep -Milliseconds 250
        }
        finally {
            if ($null -ne $reader) {
                $reader.Dispose()
            }
            elseif ($null -ne $stream) {
                $stream.Dispose()
            }
        }
    }
}

function Invoke-ManagedRuntimeScript {
    param([string]$ScriptPath)

    $scriptName = [System.IO.Path]::GetFileNameWithoutExtension($ScriptPath)
    foreach (
        $staleOutput in @(
            Get-ChildItem `
                -LiteralPath $runtimeDir `
                -Filter "$scriptName.*.tmp.log" `
                -File `
                -ErrorAction SilentlyContinue
        )
    ) {
        try {
            Remove-Item `
                -LiteralPath $staleOutput.FullName `
                -Force `
                -ErrorAction Stop
        }
        catch [System.IO.IOException] {
        }
    }
    $invocationId = [guid]::NewGuid().ToString("N")
    $stdoutPath = Join-Path `
        $runtimeDir `
        "$scriptName.$invocationId.stdout.tmp.log"
    $stderrPath = Join-Path `
        $runtimeDir `
        "$scriptName.$invocationId.stderr.tmp.log"

    $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "`"$ScriptPath`"",
        "-EnvironmentFile",
        "`"$resolvedEnvironmentFile`"",
        "-ComposeProjectName",
        "`"$ComposeProjectName`""
    )

    try {
        $process = Start-Process `
            -FilePath $powershellPath `
            -ArgumentList $arguments `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        $process.WaitForExit()
        $exitCode = [int]$process.ExitCode
        $process.Dispose()
        return $exitCode
    }
    finally {
        foreach ($outputPath in @($stdoutPath, $stderrPath)) {
            if (-not (Test-Path -LiteralPath $outputPath)) {
                continue
            }
            Copy-ManagedOutputToWatchdogLog $outputPath
        }
    }
}

function Get-RuntimeSnapshot {
    try {
        return Invoke-RestMethod `
            -Uri $runtimeStatusUrl `
            -TimeoutSec 5
    }
    catch {
        return $null
    }
}

function Test-LocalProductBuildCurrent {
    Push-Location $coreDir
    try {
        & npm.cmd run local-product:build-identity:check *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
    finally {
        Pop-Location
    }
}

function Get-ExpectedLocalProductBuildId {
    $identityPath = Join-Path `
        $coreDir `
        "dist\local-product-build-identity.json"
    if (-not (Test-Path -LiteralPath $identityPath -PathType Leaf)) {
        return ""
    }
    try {
        $identity = Get-Content -LiteralPath $identityPath -Raw |
            ConvertFrom-Json
        return [string]$identity.buildId
    }
    catch {
        return ""
    }
}

function Test-ProductConfiguration {
    return (
        (Get-LocalSetting "GROWTHOS_RUNTIME_MODE") -eq "PRODUCT" -and
        (Get-LocalSetting "BACKLINKS_WORKER_EXECUTION_MODE") -eq "normal" -and
        (Get-LocalSetting "PLATFORM_BACKGROUND_DISPATCH_ENABLED") -eq "true" -and
        (Get-LocalSetting "BACKLINKS_PROJECT_PROJECTION_ENABLED") -eq "true" -and
        (Get-LocalSetting "DATAFORSEO_ENABLED") -eq "true" -and
        (Get-LocalSetting "BROWSER_PROVIDER_ENABLED") -eq "true" -and
        (Get-LocalSetting "AI_PROVIDER_ENABLED") -eq "true" -and
        (Get-LocalSetting "GOOGLE_OAUTH_ENABLED") -eq "true" -and
        (Get-LocalSetting "GMAIL_SEND_ENABLED") -eq "true" -and
        (Get-LocalSetting "GMAIL_SYNC_ENABLED") -eq "true"
    )
}

function Test-ProcessRuntimeReady {
    param(
        [object]$Runtime,
        [string]$ExpectedBuildId
    )

    return (
        $null -ne $Runtime -and
        $ExpectedBuildId -and
        $Runtime.status -eq "ok" -and
        $Runtime.mode -eq "PRODUCT" -and
        $Runtime.business_consumers_running -eq $true -and
        $Runtime.core_api.running -eq $true -and
        $Runtime.core_api.build_id -eq $ExpectedBuildId -and
        $Runtime.worker.process_running -eq $true -and
        $Runtime.worker.build_id -eq $ExpectedBuildId -and
        $Runtime.worker.execution_mode -eq "normal" -and
        $Runtime.worker.postgres_ready -eq $true -and
        $Runtime.worker.temporal_ready -eq $true -and
        $Runtime.build.current -eq $true -and
        $Runtime.platform.background_dispatch_enabled -eq $true -and
        $Runtime.platform.project_context_projection_enabled -eq $true -and
        $Runtime.platform.project_context_dispatcher_running -eq $true
    )
}

function Write-ProviderDegradation {
    param([object]$Runtime)

    if ($null -eq $Runtime -or $null -eq $Runtime.providers) {
        return
    }
    foreach ($providerName in @("data_for_seo", "browser", "ai", "gmail")) {
        $provider = $Runtime.providers.$providerName
        if (
            $null -eq $provider -or
            $provider.configured -ne $true -or
            $provider.external_availability -ne "available"
        ) {
            $reasonCode = if ($null -ne $provider) {
                [string]$provider.reason_code
            }
            else {
                "provider_status_unavailable"
            }
            $recoveryAction = if ($null -ne $provider) {
                [string]$provider.recovery_action
            }
            else {
                "run_provider_diagnostic"
            }
            Write-WatchdogLog (
                "Provider degraded; no process restart. " +
                "provider=$providerName reason=$reasonCode " +
                "recovery=$recoveryAction"
            )
        }
    }
}

$mutex = [System.Threading.Mutex]::new(
    $false,
    "Local\GrowthOS.LocalProduct.RuntimeWatchdog"
)
$lockTaken = $false
try {
    $lockTaken = $mutex.WaitOne(0)
    if (-not $lockTaken) {
        Write-WatchdogLog "Skipped because another watchdog run is active."
        exit 0
    }

    $runtimeMode = (
        Get-LocalSetting "GROWTHOS_RUNTIME_MODE" "MAINTENANCE"
    ).ToUpperInvariant()
    if ($runtimeMode -ne "PRODUCT") {
        Write-WatchdogLog (
            "Skipped process recovery because runtime mode is $runtimeMode."
        )
        exit 0
    }
    if (-not (Test-ProductConfiguration)) {
        Write-WatchdogLog (
            "Product runtime configuration invalid; no restart attempted."
        )
        exit 1
    }

    $runtime = Get-RuntimeSnapshot
    $buildCurrent = Test-LocalProductBuildCurrent
    $expectedBuildId = Get-ExpectedLocalProductBuildId
    if (
        $buildCurrent -and
        (Test-ProcessRuntimeReady $runtime $expectedBuildId)
    ) {
        Write-ProviderDegradation $runtime
        exit 0
    }
    if ($buildCurrent) {
        Start-Sleep -Seconds 5
        $runtime = Get-RuntimeSnapshot
        $buildCurrent = Test-LocalProductBuildCurrent
        $expectedBuildId = Get-ExpectedLocalProductBuildId
        if (
            $buildCurrent -and
            (Test-ProcessRuntimeReady $runtime $expectedBuildId)
        ) {
            Write-WatchdogLog "Recovered without restart after transient failure."
            Write-ProviderDegradation $runtime
            exit 0
        }
    }
    else {
        Write-WatchdogLog (
            "LOCAL_PRODUCT_STALE_BUILD; starting managed recovery."
        )
    }

    Write-WatchdogLog "Runtime unhealthy; starting managed recovery."
    $stopExitCode = Invoke-ManagedRuntimeScript $devDown
    if ($stopExitCode -ne 0) {
        Write-WatchdogLog (
            "Managed stop reported exit_code=$stopExitCode; continuing recovery."
        )
    }
    $startExitCode = Invoke-ManagedRuntimeScript $devUp
    if ($startExitCode -ne 0) {
        throw "LOCAL_PRODUCT_RUNTIME_START_FAILED exit_code=$startExitCode"
    }
    if (-not (Test-LocalProductBuildCurrent)) {
        throw "LOCAL_PRODUCT_RUNTIME_RECOVERY_BUILD_STALE"
    }
    $runtime = Get-RuntimeSnapshot
    $expectedBuildId = Get-ExpectedLocalProductBuildId
    if (-not (Test-ProcessRuntimeReady $runtime $expectedBuildId)) {
        throw "LOCAL_PRODUCT_RUNTIME_RECOVERY_HEALTH_INVALID"
    }
    Write-WatchdogLog "Managed recovery completed."
    Write-ProviderDegradation $runtime
}
catch {
    Write-WatchdogLog "Recovery failed: $($_.Exception.Message)"
    exit 1
}
finally {
    if ($lockTaken) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
