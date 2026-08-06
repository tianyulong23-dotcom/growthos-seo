param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..\..")
    ).Path,
    [switch]$EnableAi,
    [switch]$EnableGmailSend,
    [switch]$EnableGmailSync,
    [switch]$EnableDataForSeo,
    [switch]$EnableBrowser,
    [ValidateRange(1, 10000)]
    [int]$AiMaxCalls = 25,
    [ValidateRange(1, 1000)]
    [int]$DataForSeoMaxPaidCalls = 25,
    [ValidateRange(1, 1000)]
    [int]$GmailRolling24HourSendLimit = 20,
    [ValidateRange(0, 86400)]
    [int]$GmailMinimumIntervalSeconds = 120,
    [ValidateRange(15, 3600)]
    [int]$GmailPollingIntervalSeconds = 60
)

$ErrorActionPreference = "Stop"

function Require-Text($Value, [string]$Name) {
    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        throw "LOCAL_PRODUCT_CONFIGURATION_MISSING:$Name"
    }
    return ([string]$Value).Trim()
}

function Read-EnvironmentFile([string]$Path) {
    $values = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $values
    }
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        if ($parts.Length -ne 2 -or $parts[0].Trim().Length -eq 0) {
            throw "Invalid environment line in $Path"
        }
        $values[$parts[0].Trim()] = $parts[1]
    }
    return $values
}

function Write-Utf8File(
    [string]$Path,
    [string[]]$Lines
) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllLines(
        $temporaryPath,
        $Lines,
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-EnvironmentFile(
    [string]$Path,
    [System.Collections.IDictionary]$Values
) {
    $lines = @(
        foreach ($entry in $Values.GetEnumerator()) {
            "$($entry.Key)=$($entry.Value)"
        }
    )
    Write-Utf8File $Path $lines
}

function Set-Values(
    [System.Collections.IDictionary]$Target,
    [System.Collections.IDictionary]$Updates
) {
    foreach ($entry in $Updates.GetEnumerator()) {
        $Target[$entry.Key] = [string]$entry.Value
    }
}

function Remove-Values(
    [System.Collections.IDictionary]$Target,
    [string[]]$Names
) {
    foreach ($name in $Names) {
        if ($Target.Contains($name)) {
            $Target.Remove($name)
        }
    }
}

function Assert-LocalProductSecretReference(
    [string]$Value,
    [string]$KindPrefix,
    [string]$ErrorCode
) {
    $normalized = Require-Text $Value $ErrorCode
    $pattern = "^secret://growthos/local-product/" +
        [regex]::Escape($KindPrefix) + "/.+/v[1-9][0-9]*$"
    if ($normalized -notmatch $pattern) {
        throw $ErrorCode
    }
}

function Get-LoopbackWebProxy {
    $internetSettings = Get-ItemProperty `
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" `
        -ErrorAction SilentlyContinue
    if (
        $null -eq $internetSettings `
        -or -not [bool]$internetSettings.ProxyEnable
    ) {
        return $null
    }

    $configured = ([string]$internetSettings.ProxyServer).Trim()
    if ($configured.Length -eq 0) {
        return $null
    }
    if ($configured.Contains(";")) {
        $entries = @{}
        foreach ($entry in $configured.Split(";")) {
            $parts = $entry.Split("=", 2)
            if ($parts.Length -eq 2) {
                $entries[$parts[0].Trim().ToLowerInvariant()] =
                    $parts[1].Trim()
            }
        }
        if ($entries.ContainsKey("https")) {
            $configured = $entries["https"]
        }
        elseif ($entries.ContainsKey("http")) {
            $configured = $entries["http"]
        }
        else {
            throw "LOCAL_PRODUCT_LOOPBACK_PROXY_REQUIRED"
        }
    }

    if ($configured -notmatch "^[a-z][a-z0-9+.-]*://") {
        $configured = "http://$configured"
    }
    $proxy = [uri]$configured
    if (
        $proxy.Scheme -ne "http" `
        -or $proxy.UserInfo.Length -ne 0 `
        -or $proxy.Host -notin @("127.0.0.1", "localhost", "::1") `
        -or $proxy.Port -lt 1 `
        -or $proxy.Port -gt 65535 `
        -or $proxy.AbsolutePath -ne "/"
    ) {
        throw "LOCAL_PRODUCT_LOOPBACK_PROXY_REQUIRED"
    }
    $listener = Get-NetTCPConnection `
        -State Listen `
        -LocalPort $proxy.Port `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LocalAddress -in @(
                "127.0.0.1",
                "0.0.0.0",
                "::1",
                "::"
            )
        } |
        Select-Object -First 1
    if ($null -eq $listener) {
        throw "LOCAL_PRODUCT_LOOPBACK_PROXY_UNAVAILABLE"
    }
    return $proxy.AbsoluteUri.TrimEnd("/")
}

function Assert-AiEnvironment(
    [System.Collections.IDictionary]$Values
) {
    foreach ($name in @(
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
    )) {
        [void](Require-Text $Values[$name] $name)
    }
    Assert-LocalProductSecretReference `
        $Values["AI_PROVIDER_CREDENTIAL_SECRET_REF"] `
        "ai" `
        "LOCAL_PRODUCT_AI_SECRET_REFERENCE_INVALID"
    $maxCalls = [int]$Values["AI_PROVIDER_MAX_CALLS"]
    if ($maxCalls -lt 1 -or $maxCalls -gt 10000) {
        throw "LOCAL_PRODUCT_AI_MAX_CALLS_INVALID"
    }
}

function Assert-DataForSeoEnvironment(
    [System.Collections.IDictionary]$Values
) {
    foreach ($name in @(
        "DATAFORSEO_CREDENTIAL_SECRET_REF",
        "DATAFORSEO_ENDPOINT_ALLOWLIST",
        "DATAFORSEO_REQUEST_TIMEOUT_MS",
        "DATAFORSEO_ESTIMATED_COST_MICROS",
        "DATAFORSEO_ABSOLUTE_BUDGET_MICROS",
        "DATAFORSEO_MAX_PAID_CALLS",
        "DATAFORSEO_CANDIDATE_LIMIT",
        "DATAFORSEO_LOCATION_CODE",
        "DATAFORSEO_LANGUAGE_CODE",
        "DATAFORSEO_DISCOVERY_TARGETS_JSON",
        "DATAFORSEO_PROJECT_KEYWORDS_JSON",
        "DATAFORSEO_PROJECT_PRODUCTS_JSON",
        "DATAFORSEO_TARGET_URLS_JSON"
    )) {
        [void](Require-Text $Values[$name] $name)
    }
    Assert-LocalProductSecretReference `
        $Values["DATAFORSEO_CREDENTIAL_SECRET_REF"] `
        "dataforseo" `
        "LOCAL_PRODUCT_DATAFORSEO_SECRET_REFERENCE_INVALID"
    $expectedEndpoints = @(
        "https://api.dataforseo.com/v3/serp/google/organic/task_post",
        "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
        "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced",
        "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
        "https://api.dataforseo.com/v3/backlinks/competitors/live",
        "https://api.dataforseo.com/v3/backlinks/referring_domains/live"
    )
    $parsedEndpoints =
        $Values["DATAFORSEO_ENDPOINT_ALLOWLIST"] | ConvertFrom-Json
    $endpoints = @($parsedEndpoints)
    if ($endpoints.Count -lt 1 -or $endpoints.Count -gt 16) {
        throw "LOCAL_PRODUCT_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID"
    }
    foreach ($endpoint in $endpoints) {
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
    foreach ($expectedEndpoint in $expectedEndpoints) {
        if ($expectedEndpoint -notin $endpoints) {
            throw "LOCAL_PRODUCT_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID"
        }
    }
    $maxPaidCalls = [int]$Values["DATAFORSEO_MAX_PAID_CALLS"]
    if ($maxPaidCalls -lt 1 -or $maxPaidCalls -gt 1000) {
        throw "LOCAL_PRODUCT_DATAFORSEO_CALL_LIMIT_INVALID"
    }
    $estimatedCost = [int64]$Values["DATAFORSEO_ESTIMATED_COST_MICROS"]
    $absoluteBudget = [int64]$Values["DATAFORSEO_ABSOLUTE_BUDGET_MICROS"]
    if (
        $estimatedCost -le 0 -or
        $absoluteBudget -lt $estimatedCost -or
        $absoluteBudget -gt 100000000
    ) {
        throw "LOCAL_PRODUCT_DATAFORSEO_BUDGET_INVALID"
    }
    foreach ($name in @(
        "DATAFORSEO_DISCOVERY_TARGETS_JSON",
        "DATAFORSEO_PROJECT_KEYWORDS_JSON",
        "DATAFORSEO_PROJECT_PRODUCTS_JSON",
        "DATAFORSEO_TARGET_URLS_JSON"
    )) {
        $items = $Values[$name] | ConvertFrom-Json
        if ($items.Count -lt 1) {
            throw "LOCAL_PRODUCT_DATAFORSEO_INPUT_REQUIRED:$name"
        }
    }
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "LOCAL_PRODUCT_AUTH_MANIFEST_NOT_FOUND"
}
$identityPath = Join-Path $RuntimeRoot "identity.json"
if (-not (Test-Path -LiteralPath $identityPath)) {
    throw "LOCAL_PRODUCT_IDENTITY_NOT_FOUND"
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
    ConvertFrom-Json

$projectKey = Require-Text $identity.websiteProjectKey `
    "identity.websiteProjectKey"
$projectName = Require-Text $identity.websiteProjectName `
    "identity.websiteProjectName"
$projectDomain = (
    Require-Text $identity.websiteProjectDomain `
        "identity.websiteProjectDomain"
).ToLowerInvariant()
if (
    $projectKey -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
) {
    throw "LOCAL_PRODUCT_PROJECT_KEY_INVALID"
}
if (
    $projectKey -match "(?i)(?:^live\d|canary)" -or
    $projectName -match "(?i)canary" -or
    $projectDomain -match "(?i)(?:^|\.)example\.invalid$"
) {
    throw "LOCAL_PRODUCT_CANARY_IDENTITY_FORBIDDEN"
}
if (
    $projectDomain -notmatch
        "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
) {
    throw "LOCAL_PRODUCT_PROJECT_DOMAIN_INVALID"
}
if (
    (Require-Text $manifest.runtime.websiteProjectKey `
        "runtime.websiteProjectKey") -ne $projectKey
) {
    throw "LOCAL_PRODUCT_PROJECT_CONTEXT_MISMATCH"
}
$publicBaseUrl = Require-Text $manifest.runtime.publicBaseUrl `
    "runtime.publicBaseUrl"
if ($publicBaseUrl -ne "http://localhost:7200") {
    throw "LOCAL_PRODUCT_PUBLIC_BASE_URL_INVALID"
}
$expectedRedirectUri =
    "$publicBaseUrl/api/v1/backlinks/gmail-connections/callback"
$configuredRedirectUri = Require-Text `
    $manifest.google.redirectUri `
    "google.redirectUri"
if (
    $configuredRedirectUri -ne $expectedRedirectUri `
    -and $configuredRedirectUri -notmatch (
        "^http://localhost:7200/api/v1/projects/" +
        "[A-Za-z0-9][A-Za-z0-9._-]{0,127}/" +
        "backlinks/gmail-connections/callback$"
    )
) {
    throw "LOCAL_PRODUCT_REDIRECT_URI_INVALID"
}
$clientId = Require-Text $manifest.google.oauthClientId `
    "google.oauthClientId"
if ($clientId -notlike "*.apps.googleusercontent.com") {
    throw "LOCAL_PRODUCT_GOOGLE_CLIENT_ID_INVALID"
}
$clientSecretReference = Require-Text `
    $manifest.google.oauthClientSecretRef `
    "google.oauthClientSecretRef"
Assert-LocalProductSecretReference `
    $clientSecretReference `
    "google" `
    "LOCAL_PRODUCT_GOOGLE_CLIENT_SECRET_REFERENCE_INVALID"
$secretStoreProvider = Require-Text `
    $manifest.google.secretStoreProvider `
    "google.secretStoreProvider"
if ($secretStoreProvider -ne "platform-secret-store") {
    throw "LOCAL_PRODUCT_SECRET_STORE_PROVIDER_INVALID"
}

$manifest.runtime.mode = "LOCAL_PRODUCT"
$manifest.runtime.publicBaseUrl = "http://localhost:7200"
$manifest.runtime.websiteProjectKey = $projectKey
$manifest.google.redirectUri = $expectedRedirectUri
$manifest.gmail.maxSendCalls = $GmailRolling24HourSendLimit
$manifestJson = $manifest | ConvertTo-Json -Depth 16
Write-Utf8File $ManifestPath @($manifestJson)

$secretRoot = Join-Path $RuntimeRoot "secrets"
$runtimeModule = Join-Path $RepositoryRoot `
    "backend\core\dist\modules\backlinks\runtime\production-runtime.js"
$commonCore = [ordered]@{
    BACKLINKS_RUNTIME_MODULE = $runtimeModule
    BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT"
    LOCAL_PRODUCT_ORGANIZATION_ID = (
        Require-Text $identity.organizationId "identity.organizationId"
    )
    LOCAL_PRODUCT_WORKSPACE_ID = (
        Require-Text $identity.workspaceId "identity.workspaceId"
    )
    LOCAL_PRODUCT_WEBSITE_PROJECT_ID = (
        Require-Text $identity.websiteProjectId "identity.websiteProjectId"
    )
    LOCAL_PRODUCT_WEBSITE_PROJECT_KEY = $projectKey
    LOCAL_PRODUCT_USER_ID = (
        Require-Text $identity.userId "identity.userId"
    )
    GOOGLE_OAUTH_ENABLED = "true"
    PLATFORM_SECRET_STORE_ENABLED = "true"
    PLATFORM_SECRET_STORE_PROVIDER = $secretStoreProvider
    PLATFORM_SECRET_STORE_ROOT = $secretRoot
    GOOGLE_OAUTH_CLIENT_ID = $clientId
    GOOGLE_OAUTH_CLIENT_SECRET_REF = $clientSecretReference
    GOOGLE_OAUTH_REDIRECT_URI = $expectedRedirectUri
    GMAIL_SEND_ENABLED = $(if ($EnableGmailSend) { "true" } else { "false" })
    GMAIL_SYNC_ENABLED = $(if ($EnableGmailSync) { "true" } else { "false" })
    GMAIL_POLLING_INTERVAL_SECONDS = [string]$GmailPollingIntervalSeconds
    GMAIL_ROLLING_24_HOUR_SEND_LIMIT = [string]$GmailRolling24HourSendLimit
    GMAIL_MINIMUM_INTERVAL_SECONDS = [string]$GmailMinimumIntervalSeconds
    DATAFORSEO_ENABLED = $(if ($EnableDataForSeo) { "true" } else { "false" })
    DATAFORSEO_MAX_PAID_CALLS = [string]$DataForSeoMaxPaidCalls
    AI_PROVIDER_ENABLED = $(if ($EnableAi) { "true" } else { "false" })
    AI_PROVIDER_MAX_CALLS = [string]$AiMaxCalls
    BROWSER_PROVIDER_ENABLED = $(if ($EnableBrowser) { "true" } else { "false" })
    BROWSER_WORKER_ENDPOINT = "http://127.0.0.1:7401"
    BROWSER_WORKER_TIMEOUT_MS = "20000"
    CONTACT_ENRICHMENT_FETCH_TIMEOUT_MS = "12000"
    CONTACT_ENRICHMENT_MAX_PAGES = "8"
    CONTACT_ENRICHMENT_MAX_DEPTH = "2"
    CONTACT_ENRICHMENT_MAX_ATTEMPTS = "3"
}
$proxyEnvironmentNames = @(
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY"
)
$loopbackProxy = Get-LoopbackWebProxy
if ($null -ne $loopbackProxy) {
    Set-Values $commonCore ([ordered]@{
        HTTP_PROXY = $loopbackProxy
        HTTPS_PROXY = $loopbackProxy
        NO_PROXY = "localhost,127.0.0.1,::1"
        NODE_USE_ENV_PROXY = "1"
    })
}

foreach ($name in @("backlinks-api.env", "backlinks-worker.env")) {
    $path = Join-Path $RuntimeRoot $name
    $values = Read-EnvironmentFile $path
    Set-Values $values $commonCore
    Remove-Values $values @(
        "BACKLINKS_LIVE_CANARY_STAGE",
        "GMAIL_CANARY_RECIPIENT_SECRET_REF",
        "DATAFORSEO_CANARY_MAX_PAID_CALLS"
    )
    if ($name -eq "backlinks-worker.env") {
        Remove-Values $values @(
            "LOCAL_PRODUCT_WEBSITE_PROJECT_ID",
            "LOCAL_PRODUCT_WEBSITE_PROJECT_KEY"
        )
    }
    if ($null -eq $loopbackProxy) {
        Remove-Values $values $proxyEnvironmentNames
    }
    if ($EnableAi) {
        Assert-AiEnvironment $values
    }
    if ($EnableDataForSeo) {
        Assert-DataForSeoEnvironment $values
    }
    Write-EnvironmentFile $path $values
}

$fastApiPath = Join-Path $RuntimeRoot "fastapi.env"
$fastApi = Read-EnvironmentFile $fastApiPath
Set-Values $fastApi ([ordered]@{
    API_HOST = "127.0.0.1"
    API_PORT = "7200"
    CORS_ORIGINS = '["http://localhost:5173"]'
    BACKLINKS_PRIVATE_BASE_URL = "http://127.0.0.1:7301"
    BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT"
    LOCAL_PRODUCT_FRONTEND_ORIGIN = "http://localhost:5173"
    LOCAL_PRODUCT_ORGANIZATION_ID = (
        Require-Text $identity.organizationId "identity.organizationId"
    )
    LOCAL_PRODUCT_WORKSPACE_ID = (
        Require-Text $identity.workspaceId "identity.workspaceId"
    )
    LOCAL_PRODUCT_WEBSITE_PROJECT_ID = (
        Require-Text $identity.websiteProjectId "identity.websiteProjectId"
    )
    LOCAL_PRODUCT_WEBSITE_PROJECT_KEY = $projectKey
    LOCAL_PRODUCT_USER_ID = (
        Require-Text $identity.userId "identity.userId"
    )
    LOCAL_PRODUCT_SESSION_ID = (
        Require-Text $identity.sessionId "identity.sessionId"
    )
    GOOGLE_OAUTH_ENABLED = "true"
    PLATFORM_SECRET_STORE_ENABLED = "true"
    GMAIL_SEND_ENABLED = $(if ($EnableGmailSend) { "true" } else { "false" })
    GMAIL_SYNC_ENABLED = $(if ($EnableGmailSync) { "true" } else { "false" })
    DATAFORSEO_ENABLED = $(if ($EnableDataForSeo) { "true" } else { "false" })
    AI_PROVIDER_ENABLED = $(if ($EnableAi) { "true" } else { "false" })
    BROWSER_PROVIDER_ENABLED = $(if ($EnableBrowser) { "true" } else { "false" })
})
Remove-Values $fastApi @("BACKLINKS_LIVE_CANARY_STAGE")
Write-EnvironmentFile $fastApiPath $fastApi

Write-EnvironmentFile (Join-Path $RuntimeRoot "browser-worker.env") ([ordered]@{
    BROWSER_WORKER_HOST = "127.0.0.1"
    BROWSER_WORKER_PORT = "7401"
    BROWSER_WORKER_TIMEOUT_MS = "20000"
    BROWSER_WORKER_MAX_HTML_BYTES = "2000000"
})

Write-EnvironmentFile (Join-Path $RuntimeRoot "frontend.env") ([ordered]@{
    VITE_API_BASE_URL = "http://localhost:7200"
    VITE_WEBSITE_PROJECT_KEY = $projectKey
    VITE_WEBSITE_PROJECT_NAME = $projectName
    VITE_WEBSITE_PROJECT_DOMAIN = $projectDomain
})

& (Join-Path $RepositoryRoot "ops\live\Set-LocalProductSecretAcl.ps1") `
    -SecretRoot $secretRoot | Out-Null

[Environment]::SetEnvironmentVariable(
    "LIVE_AUTH_MANIFEST_PATH",
    $ManifestPath,
    "Process"
)
[Environment]::SetEnvironmentVariable(
    "LIVE_AUTH_MANIFEST_PATH",
    $ManifestPath,
    "User"
)

[pscustomobject]@{
    runtimeMode = "LOCAL_PRODUCT"
    projectKey = $projectKey
    frontend = "http://localhost:5173"
    fastApi = "http://localhost:7200"
    privateCore = "http://127.0.0.1:7301"
    googleOauth = $true
    gmailSend = [bool]$EnableGmailSend
    gmailSync = [bool]$EnableGmailSync
    gmailRolling24HourSendLimit = $GmailRolling24HourSendLimit
    gmailMinimumIntervalSeconds = $GmailMinimumIntervalSeconds
    gmailPollingIntervalSeconds = $GmailPollingIntervalSeconds
    aiProvider = [bool]$EnableAi
    aiMaxCalls = $AiMaxCalls
    dataForSeo = [bool]$EnableDataForSeo
    dataForSeoMaxPaidCalls = $DataForSeoMaxPaidCalls
    browserProvider = [bool]$EnableBrowser
}
