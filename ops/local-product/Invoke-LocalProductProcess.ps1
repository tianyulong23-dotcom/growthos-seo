param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("browser-worker", "core-api", "worker", "fastapi", "frontend")]
    [string]$Component,
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

function Require-ProcessEnvironment([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "LOCAL_PRODUCT_CONFIGURATION_MISSING:$Name"
    }
    return $value.Trim()
}

function Assert-DataForSeoProcessEnvironment {
    $reference = Require-ProcessEnvironment `
        "DATAFORSEO_CREDENTIAL_SECRET_REF"
    if (
        $reference -notmatch
            "^secret://growthos/local-product/dataforseo/.+/v[1-9][0-9]*$"
    ) {
        throw "LOCAL_PRODUCT_DATAFORSEO_SECRET_REFERENCE_INVALID"
    }
    $expectedEndpoint =
        "https://api.dataforseo.com/v3/backlinks/referring_domains/live"
    $parsedAllowlist = (
        Require-ProcessEnvironment "DATAFORSEO_ENDPOINT_ALLOWLIST"
    ) | ConvertFrom-Json
    $allowlist = @($parsedAllowlist)
    if ($allowlist.Count -lt 1 -or $allowlist.Count -gt 16) {
        throw "LOCAL_PRODUCT_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID"
    }
    foreach ($endpoint in $allowlist) {
        try {
            $uri = [uri]([string]$endpoint)
        }
        catch {
            throw "LOCAL_PRODUCT_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID"
        }
        if (
            $uri.Scheme -ne "https" -or
            $uri.Host -ne "api.dataforseo.com" -or
            $uri.Port -ne 443 -or
            $uri.UserInfo.Length -ne 0 -or
            -not $uri.AbsolutePath.StartsWith("/v3/") -or
            $uri.Query.Length -ne 0 -or
            $uri.Fragment.Length -ne 0
        ) {
            throw "LOCAL_PRODUCT_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID"
        }
    }
    if ($expectedEndpoint -notin $allowlist) {
        throw "LOCAL_PRODUCT_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID"
    }
    $maxPaidCalls = [int](
        Require-ProcessEnvironment "DATAFORSEO_MAX_PAID_CALLS"
    )
    if ($maxPaidCalls -lt 1 -or $maxPaidCalls -gt 1000) {
        throw "LOCAL_PRODUCT_DATAFORSEO_CALL_LIMIT_INVALID"
    }
}

$environmentFile = switch ($Component) {
    "browser-worker" { Join-Path $RuntimeRoot "browser-worker.env" }
    "core-api" { Join-Path $RuntimeRoot "backlinks-api.env" }
    "worker" { Join-Path $RuntimeRoot "backlinks-worker.env" }
    "fastapi" { Join-Path $RuntimeRoot "fastapi.env" }
    "frontend" { Join-Path $RuntimeRoot "frontend.env" }
}
Import-EnvironmentFile $environmentFile

if ($Component -in @("core-api", "worker", "fastapi")) {
    if (
        [Environment]::GetEnvironmentVariable(
            "BACKLINKS_RUNTIME_MODE",
            "Process"
        ) -ne "LOCAL_PRODUCT"
    ) {
        throw "BACKLINKS_RUNTIME_MODE must equal LOCAL_PRODUCT"
    }
    if (
        [Environment]::GetEnvironmentVariable(
            "BACKLINKS_LIVE_CANARY_STAGE",
            "Process"
        )
    ) {
        throw "BACKLINKS_LIVE_CANARY_STAGE is forbidden in LOCAL_PRODUCT"
    }
    if (
        [Environment]::GetEnvironmentVariable(
            "GMAIL_CANARY_RECIPIENT_SECRET_REF",
            "Process"
        )
    ) {
        throw "Fixed Canary recipients are forbidden in LOCAL_PRODUCT"
    }
    foreach ($name in @(
        "GOOGLE_OAUTH_ENABLED",
        "PLATFORM_SECRET_STORE_ENABLED"
    )) {
        if (
            [Environment]::GetEnvironmentVariable($name, "Process") -ne
                "true"
        ) {
            throw "$name must be true in LOCAL_PRODUCT"
        }
    }
    foreach ($name in @(
        "GMAIL_SEND_ENABLED",
        "GMAIL_SYNC_ENABLED"
    )) {
        if (
            [Environment]::GetEnvironmentVariable($name, "Process") -notin
                @("true", "false")
        ) {
            throw "$name must be true or false in LOCAL_PRODUCT"
        }
    }
    $browserProviderEnabled = Require-ProcessEnvironment `
        "BROWSER_PROVIDER_ENABLED"
    if ($browserProviderEnabled -notin @("true", "false")) {
        throw "BROWSER_PROVIDER_ENABLED must be true or false in LOCAL_PRODUCT"
    }
    if (
        $browserProviderEnabled -eq "true" -and
        $Component -in @("core-api", "worker")
    ) {
        [void](Require-ProcessEnvironment "BROWSER_WORKER_ENDPOINT")
    }
    $dataForSeoEnabled = Require-ProcessEnvironment "DATAFORSEO_ENABLED"
    if ($dataForSeoEnabled -notin @("true", "false")) {
        throw "DATAFORSEO_ENABLED must be true or false in LOCAL_PRODUCT"
    }
    if (
        $dataForSeoEnabled -eq "true" -and
        $Component -in @("core-api", "worker")
    ) {
        Assert-DataForSeoProcessEnvironment
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
    "browser-worker" {
        Invoke-NativeProcess `
            (Get-Command node).Source `
            @("dist/src/server.js") `
            (Join-Path $RepositoryRoot "backend\browser-worker")
    }
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
        if (-not (Test-Path -LiteralPath $python)) {
            throw "LOCAL_PRODUCT_PYTHON_RUNTIME_MISSING"
        }
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
