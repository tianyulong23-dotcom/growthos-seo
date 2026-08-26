param(
    [string]$EnvironmentFile = "",
    [string]$ComposeProjectName = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "deploy\compose\compose.yaml"
if (-not $EnvironmentFile) {
    $EnvironmentFile = Join-Path $root "deploy\compose\.env"
}
if (-not (Test-Path -LiteralPath $EnvironmentFile)) {
    throw "Configuration file not found: $EnvironmentFile"
}
$composeEnvFile = (Resolve-Path -LiteralPath $EnvironmentFile).Path

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

if (Test-Path -LiteralPath $pidFile) {
    $parsedRecords = (
        Get-Content -LiteralPath $pidFile -Raw |
            ConvertFrom-Json
    )
    $records = @($parsedRecords)
    foreach ($record in $records) {
        if (Get-RecordedProcess -Record $record) {
            Write-Host "Stopping $($record.name)..."
            Stop-ProcessTree -ProcessId ([int]$record.processId)
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$composeArguments = @(
    "compose",
    "--env-file",
    $composeEnvFile,
    "-f",
    $composeFile
)
$composeArguments += @("-p", $ComposeProjectName)

Write-Host "Stopping Docker services..."
& docker @composeArguments stop
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose stop failed."
}

Write-Host "Project stopped. Docker data was kept."
