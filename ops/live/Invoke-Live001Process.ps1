param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("core-api", "worker", "fastapi", "frontend")]
    [string]$Component,

    [Parameter(Mandatory = $true)]
    [ValidateSet("LIVE-001", "LIVE-003", "LIVE-004")]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryRoot,

    [Parameter(Mandatory = $true)]
    [string]$LogPrefix
)

$ErrorActionPreference = "Stop"

function Import-EnvironmentFile([string]$Path) {
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        if ($parts.Length -ne 2 -or $parts[0].Trim().Length -eq 0) {
            throw "Invalid environment line in $Path"
        }
        [Environment]::SetEnvironmentVariable(
            $parts[0].Trim(),
            $parts[1],
            "Process"
        )
    }
}

$environmentFile = switch ($Component) {
    "core-api" { Join-Path $RuntimeRoot "backlinks-api.env" }
    "worker" { Join-Path $RuntimeRoot "backlinks-worker.env" }
    "fastapi" { Join-Path $RuntimeRoot "fastapi.env" }
    "frontend" { Join-Path $RuntimeRoot "frontend.env" }
}
Import-EnvironmentFile $environmentFile

if ($Component -ne "frontend") {
    $expected = if ($Stage -eq "LIVE-004") { "true" } else { "false" }
    foreach ($name in @("GMAIL_SEND_ENABLED", "GMAIL_SYNC_ENABLED")) {
        if (
            [Environment]::GetEnvironmentVariable($name, "Process") -ne
                $expected
        ) {
            throw "$name does not match $Stage"
        }
    }
    foreach ($name in @(
        "DATAFORSEO_ENABLED",
        "AI_PROVIDER_ENABLED",
        "BROWSER_PROVIDER_ENABLED"
    )) {
        if ([Environment]::GetEnvironmentVariable($name, "Process") -ne "false") {
            throw "$name must remain false for $Stage"
        }
    }
    if ($Stage -eq "LIVE-001") {
        if (
            [Environment]::GetEnvironmentVariable(
                "GOOGLE_OAUTH_ENABLED",
                "Process"
            ) -eq "true" `
            -or [Environment]::GetEnvironmentVariable(
                "PLATFORM_SECRET_STORE_ENABLED",
                "Process"
            ) -eq "true"
        ) {
            throw "Google OAuth and Secret Store must remain disabled for LIVE-001"
        }
    }
    else {
        foreach ($name in @(
            "GOOGLE_OAUTH_ENABLED",
            "PLATFORM_SECRET_STORE_ENABLED"
        )) {
            if (
                [Environment]::GetEnvironmentVariable($name, "Process") -ne
                    "true"
            ) {
                throw "$name must be enabled for $Stage"
            }
        }
    }
}

$stdout = "$LogPrefix.stdout.log"
$stderr = "$LogPrefix.stderr.log"

function Invoke-NativeProcess(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
) {
    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -NoNewWindow `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru `
        -Wait
    return $process.ExitCode
}

$exitCode = switch ($Component) {
    "core-api" {
        Invoke-NativeProcess `
            (Get-Command node).Source `
            @("dist/index.js", "api") `
            (Join-Path $RepositoryRoot "backend\core")
    }
    "worker" {
        Invoke-NativeProcess `
            (Get-Command node).Source `
            @("dist/index.js", "worker") `
            (Join-Path $RepositoryRoot "backend\core")
    }
    "fastapi" {
        $python = Join-Path $RuntimeRoot "python\Scripts\python.exe"
        Invoke-NativeProcess `
            $python `
            @("-m", "app.serve") `
            (Join-Path $RepositoryRoot "backend\api")
    }
    "frontend" {
        Invoke-NativeProcess `
            (Get-Command npm.cmd).Source `
            @(
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                "5173",
                "--strictPort"
            ) `
            (Join-Path $RepositoryRoot "frontend")
    }
}

exit $exitCode
