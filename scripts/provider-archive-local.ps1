param(
    [ValidateSet("setup", "start", "stop", "status", "verify")]
    [string]$Action = "status",
    [string]$DataDirectory = "",
    [switch]$CenterOnly
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$core = Join-Path $root "backend\core"
if (-not $DataDirectory) { $DataDirectory = Join-Path $root "storage\provider-archive" }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$env:PROVIDER_ARCHIVE_LOCAL_DIR = $DataDirectory
$entry = Join-Path $core "scripts\provider-archive-local.mjs"
$node = (Get-Command node).Source
$configPath = Join-Path $DataDirectory "local-config.json"

function Get-OwnedProcess([string]$Mode) {
    $file = Join-Path $DataDirectory "$Mode.pid"
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $processId = [int](Get-Content -LiteralPath $file -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $process) { return $null }
    if ($process.CommandLine -notlike "*$entry* $Mode*") {
        throw "Refuse to control reused PID: $processId"
    }
    return $process
}

if ($Action -eq "setup") {
    & $node $entry setup
    if ($LASTEXITCODE -ne 0) { throw "Local archive setup failed; inspect existing state before retry." }
    # Restrict credentials and captured data to the current Windows account.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $DataDirectory /inheritance:r /grant:r "${identity}:(OI)(CI)F" /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Archive directory ACL restriction failed" }
    return
}
if (-not (Test-Path -LiteralPath $configPath)) { throw "Run setup first." }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($Action -eq "start") {
    $modes = @("serve")
    if (-not $CenterOnly) { $modes += "upload" }
    foreach ($mode in $modes) {
        if (Get-OwnedProcess $mode) { continue }
        $process = Start-Process -FilePath $node `
            -ArgumentList @("`"$entry`"", $mode) -WorkingDirectory $core `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $DataDirectory "$mode.stdout.log") `
            -RedirectStandardError (Join-Path $DataDirectory "$mode.stderr.log")
        [IO.File]::WriteAllText((Join-Path $DataDirectory "$mode.pid"), [string]$process.Id)
        Start-Sleep -Milliseconds 700
        $process.Refresh()
        if ($process.HasExited) { throw "Archive $mode exited; inspect its local log." }
    }
    $health = Invoke-RestMethod "$($config.PROVIDER_ARCHIVE_CENTER_URL)/health"
    if ($health.status -ne "ready") { throw "Archive center not ready" }
    Write-Output "Local archive ready: $($config.PROVIDER_ARCHIVE_CENTER_URL)"
} elseif ($Action -eq "stop") {
    foreach ($mode in @("upload", "serve")) {
        $process = Get-OwnedProcess $mode
        if ($process) { Stop-Process -Id $process.ProcessId }
    }
    Write-Output "Local archive processes stopped; database and spool retained."
} elseif ($Action -eq "verify") {
    & $node $entry verify
    if ($LASTEXITCODE -ne 0) { throw "Local archive verification failed" }
} else {
    Invoke-RestMethod "$($config.PROVIDER_ARCHIVE_CENTER_URL)/health" | ConvertTo-Json -Compress
    & $node $entry status
    if ($LASTEXITCODE -ne 0) { throw "Local archive status failed" }
}
