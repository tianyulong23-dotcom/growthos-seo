param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..\..")
    ).Path,
    [int]$TimeoutSeconds = 45,
    [switch]$KeepInfrastructure
)

$ErrorActionPreference = "Stop"
$statePath = Join-Path $RuntimeRoot "local-product-processes.json"

function Get-ProcessTree([uint32]$RootPid) {
    $processes = Get-CimInstance Win32_Process
    $ids = [System.Collections.Generic.List[uint32]]::new()
    $queue = [System.Collections.Generic.Queue[uint32]]::new()
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if (-not $ids.Contains($parent)) {
            $ids.Add($parent)
        }
        foreach (
            $child in $processes |
                Where-Object ParentProcessId -eq $parent
        ) {
            $queue.Enqueue([uint32]$child.ProcessId)
        }
    }
    return $ids.ToArray()
}

function Stop-ProcessGroup([string]$Name, [uint32]$GroupPid) {
    if (
        $GroupPid -eq 0 `
        -or -not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)
    ) {
        return
    }
    $processTree = Get-ProcessTree $GroupPid
    $servicePids = @(
        $processTree | Where-Object {
            $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
            $process -and $process.ProcessName -in @(
                "node",
                "python",
                "pythonw"
            )
        }
    )
    if ($servicePids.Count -eq 0) {
        foreach ($processId in $processTree) {
            Stop-Process `
                -Id $processId `
                -Force `
                -ErrorAction SilentlyContinue
        }
        return
    }

    $signalScript = Join-Path $PSScriptRoot `
        "Send-LocalProductConsoleBreak.ps1"
    $signalArguments = (
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass " +
        "-File `"$signalScript`" -GroupPid $GroupPid"
    )
    $signalProcess = Start-Process `
        -FilePath (Get-Command powershell.exe).Source `
        -ArgumentList $signalArguments `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($signalProcess.ExitCode -ne 0) {
        throw "$Name graceful shutdown signal failed"
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $active = @(
            $servicePids | Where-Object {
                Get-Process -Id $_ -ErrorAction SilentlyContinue
            }
        )
        if ($active.Count -eq 0) {
            foreach ($processId in $processTree) {
                Stop-Process `
                    -Id $processId `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "$Name did not stop gracefully; active PIDs: $($active -join ',')"
}

if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
        ConvertFrom-Json
    Stop-ProcessGroup "Frontend" ([uint32]$state.frontendGroupPid)
    Stop-ProcessGroup "FastAPI" ([uint32]$state.fastApiGroupPid)
    Stop-ProcessGroup "Backlinks Worker" ([uint32]$state.workerGroupPid)
    Stop-ProcessGroup "Backlinks Core API" ([uint32]$state.coreApiGroupPid)
    Stop-ProcessGroup "Browser Worker" ([uint32]$state.browserGroupPid)
}

$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object LocalPort -In 5173, 7200, 7301, 7401
if ($listeners) {
    throw "LOCAL_PRODUCT_LISTENERS_REMAIN_AFTER_SHUTDOWN"
}
if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath
}

if (-not $KeepInfrastructure) {
    $env:GROWTHOS_LIVE001_SECRET_DIR = Join-Path $RuntimeRoot "secrets"
    $composeFile = Join-Path $RepositoryRoot `
        "deploy\live\docker-compose.live001.yml"
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        docker compose -f $composeFile stop postgres temporal 2>&1 | Out-Null
        $composeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($composeExitCode -ne 0) {
        throw "LOCAL_PRODUCT_INFRASTRUCTURE_STOP_FAILED:$composeExitCode"
    }
}

[pscustomobject]@{
    stoppedAt = Get-Date -Format o
    graceful = $true
    infrastructureRunning = [bool]$KeepInfrastructure
    persistentVolumesRemoved = $false
}
