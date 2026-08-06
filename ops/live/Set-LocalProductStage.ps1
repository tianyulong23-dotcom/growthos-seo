param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("LIVE-003", "LIVE-004")]
    [string]$Stage,

    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),

    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),

    [string]$RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..\..")
    ).Path
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

function Write-EnvironmentFile([string]$Path, [System.Collections.IDictionary]$Values) {
    $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    $lines = foreach ($entry in $Values.GetEnumerator()) {
        "$($entry.Key)=$($entry.Value)"
    }
    [System.IO.File]::WriteAllLines(
        $temporaryPath,
        $lines,
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Set-Values(
    [System.Collections.IDictionary]$Target,
    [System.Collections.IDictionary]$Updates
) {
    foreach ($entry in $Updates.GetEnumerator()) {
        $Target[$entry.Key] = [string]$entry.Value
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
    return $proxy.AbsoluteUri.TrimEnd("/")
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "LIVE_AUTH_MANIFEST_NOT_FOUND"
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$identityPath = Join-Path $RuntimeRoot "identity.json"
if (-not (Test-Path -LiteralPath $identityPath)) {
    throw "LOCAL_PRODUCT_IDENTITY_NOT_FOUND"
}
$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
    ConvertFrom-Json

$publicBaseUrl = Require-Text $manifest.runtime.publicBaseUrl `
    "runtime.publicBaseUrl"
$projectKey = Require-Text $manifest.runtime.websiteProjectKey `
    "runtime.websiteProjectKey"
$clientId = Require-Text $manifest.google.oauthClientId `
    "google.oauthClientId"
$clientSecretRef = Require-Text $manifest.google.oauthClientSecretRef `
    "google.oauthClientSecretRef"
$redirectUri = Require-Text $manifest.google.redirectUri `
    "google.redirectUri"
$secretStoreProvider = Require-Text $manifest.google.secretStoreProvider `
    "google.secretStoreProvider"

if ($publicBaseUrl -ne "http://localhost:7200") {
    throw "LOCAL_PRODUCT_PUBLIC_BASE_URL_INVALID"
}
if ($projectKey -ne "live001-canary") {
    throw "LOCAL_PRODUCT_PROJECT_KEY_INVALID"
}
$expectedRedirectUri =
    "http://localhost:7200/api/v1/backlinks/gmail-connections/callback"
if ($redirectUri -ne $expectedRedirectUri) {
    throw "LOCAL_PRODUCT_REDIRECT_URI_INVALID"
}
if (
    $clientSecretRef -ne
        "secret://growthos/local-product/google/oauth-client-secret/v1"
) {
    throw "LOCAL_PRODUCT_CLIENT_SECRET_REFERENCE_INVALID"
}
if ($secretStoreProvider -ne "platform-secret-store") {
    throw "LOCAL_PRODUCT_SECRET_STORE_PROVIDER_INVALID"
}

$gmailEnabled = if ($Stage -eq "LIVE-004") { "true" } else { "false" }
$secretRoot = Join-Path $RuntimeRoot "secrets"
$runtimeModule = Join-Path $RepositoryRoot `
    "backend\core\dist\modules\backlinks\runtime\production-runtime.js"
$commonCore = [ordered]@{
    BACKLINKS_RUNTIME_MODULE = $runtimeModule
    BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT_ACCEPTANCE"
    BACKLINKS_LIVE_CANARY_STAGE = $Stage
    GOOGLE_OAUTH_ENABLED = "true"
    PLATFORM_SECRET_STORE_ENABLED = "true"
    PLATFORM_SECRET_STORE_PROVIDER = $secretStoreProvider
    PLATFORM_SECRET_STORE_ROOT = $secretRoot
    GOOGLE_OAUTH_CLIENT_ID = $clientId
    GOOGLE_OAUTH_CLIENT_SECRET_REF = $clientSecretRef
    GOOGLE_OAUTH_REDIRECT_URI = $redirectUri
    GMAIL_SEND_ENABLED = $gmailEnabled
    GMAIL_SYNC_ENABLED = $gmailEnabled
    DATAFORSEO_ENABLED = "false"
    AI_PROVIDER_ENABLED = "false"
    BROWSER_PROVIDER_ENABLED = "false"
}
if ($Stage -eq "LIVE-004") {
    $commonCore["GMAIL_CANARY_RECIPIENT_SECRET_REF"] =
        "secret://growthos/local-product/gmail/canary-recipient/v1"
}
$loopbackProxy = Get-LoopbackWebProxy
if ($null -ne $loopbackProxy) {
    Set-Values $commonCore ([ordered]@{
        HTTP_PROXY = $loopbackProxy
        HTTPS_PROXY = $loopbackProxy
        NO_PROXY = "localhost,127.0.0.1,::1"
    })
}

foreach ($name in @("backlinks-api.env", "backlinks-worker.env")) {
    $path = Join-Path $RuntimeRoot $name
    $values = Read-EnvironmentFile $path
    Set-Values $values $commonCore
    Write-EnvironmentFile $path $values
}

$fastApiPath = Join-Path $RuntimeRoot "fastapi.env"
$fastApi = Read-EnvironmentFile $fastApiPath
Set-Values $fastApi ([ordered]@{
    API_HOST = "127.0.0.1"
    API_PORT = "7200"
    CORS_ORIGINS = '["http://localhost:5173"]'
    BACKLINKS_PRIVATE_BASE_URL = "http://127.0.0.1:7301"
    BACKLINKS_RUNTIME_MODE = "LOCAL_PRODUCT_ACCEPTANCE"
    BACKLINKS_LIVE_CANARY_STAGE = $Stage
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
    LOCAL_PRODUCT_WEBSITE_PROJECT_KEY = (
        Require-Text $identity.websiteProjectKey "identity.websiteProjectKey"
    )
    LOCAL_PRODUCT_USER_ID = (
        Require-Text $identity.userId "identity.userId"
    )
    LOCAL_PRODUCT_SESSION_ID = (
        Require-Text $identity.sessionId "identity.sessionId"
    )
    GOOGLE_OAUTH_ENABLED = "true"
    PLATFORM_SECRET_STORE_ENABLED = "true"
    GMAIL_SEND_ENABLED = $gmailEnabled
    GMAIL_SYNC_ENABLED = $gmailEnabled
    DATAFORSEO_ENABLED = "false"
    AI_PROVIDER_ENABLED = "false"
    BROWSER_PROVIDER_ENABLED = "false"
})
Write-EnvironmentFile $fastApiPath $fastApi

$frontendPath = Join-Path $RuntimeRoot "frontend.env"
$frontend = [ordered]@{
    VITE_API_BASE_URL = "http://localhost:7200"
    VITE_WEBSITE_PROJECT_KEY = $projectKey
}
Write-EnvironmentFile $frontendPath $frontend

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
    stage = $Stage
    runtimeMode = "LOCAL_PRODUCT_ACCEPTANCE"
    fastApi = "http://localhost:7200"
    privateCore = "http://127.0.0.1:7301"
    frontend = "http://localhost:5173"
    gmailSendEnabled = ($gmailEnabled -eq "true")
    gmailSyncEnabled = ($gmailEnabled -eq "true")
}
