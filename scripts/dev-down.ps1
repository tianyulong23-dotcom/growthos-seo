$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "deploy\compose\compose.yaml"
$apiDir = Join-Path $root "backend\api"
$apiMarker = Join-Path $root "backend\api\.venv\Scripts\uvicorn.exe"
$frontendMarker = Join-Path $root "frontend\node_modules"
$crawlerMarker = Join-Path $root "storage\runtime\crawler-worker-docker.exe"

function Stop-ProcessTree {
    param([int]$ProcessId)

    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

$projectProcesses = Get-CimInstance Win32_Process -Property ProcessId, Name, CommandLine |
Where-Object {
    $commandLine = $_.CommandLine
    ($_.Name -eq "crawler-worker-docker.exe") -or
    ($commandLine -and (
            $commandLine.Contains($apiMarker) -or
            ($commandLine.Contains($apiDir) -and $commandLine -match "(?i)\buvicorn\b\s+app\.main:app\b") -or
            $commandLine.Contains($frontendMarker) -or
            $commandLine.Contains($crawlerMarker) -or
            $commandLine -match "(?i)\bgo(?:\.exe)?\b.*\brun\b.*cmd[\\/]+crawler"
        )
    )
}

foreach ($process in $projectProcesses) {
    Stop-ProcessTree -ProcessId $process.ProcessId
}

Start-Sleep -Milliseconds 500

Write-Host "Stopping Docker services..."
& docker compose -f $composeFile stop
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose stop failed."
}

Write-Host "Project stopped. Docker data was kept."
