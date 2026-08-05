[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$CredentialSecretReference = (
        "secret://growthos/local-product/dataforseo/provider-credential/v1"
    ),
    [string[]]$EndpointAllowlist = @(
        "https://api.dataforseo.com/v3/backlinks/referring_domains/live"
    ),
    [Alias("DiscoveryTarget")]
    [string[]]$DiscoveryTargets = @("showmax.com"),
    [string[]]$Keywords = @(
        "live sports",
        "streaming movies",
        "TV series",
        "live channels",
        "African entertainment"
    ),
    [string[]]$Products = @(
        "ElephTV Android streaming app",
        "live sports and channels streaming",
        "movies and TV series streaming"
    ),
    [string[]]$TargetUrls = @("https://elephtv.com/"),
    [int]$TimeoutMs = 60000,
    [int64]$EstimatedCostMicros = 100000,
    [int64]$AbsoluteBudgetMicros = 100000,
    [ValidateRange(1, 1000)]
    [int]$MaxPaidCalls = 25,
    [int]$CandidateLimit = 100,
    [string]$LocationCode = "ZA",
    [string]$LanguageCode = "en"
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot `
    "ops\local-product\Import-GrowthOS-LocalProductDataForSeoCredential.ps1") `
    -RuntimeRoot $RuntimeRoot `
    -ManifestPath $ManifestPath `
    -RepositoryRoot $PSScriptRoot `
    -CredentialSecretReference $CredentialSecretReference `
    -EndpointAllowlist $EndpointAllowlist `
    -DiscoveryTargets $DiscoveryTargets `
    -Keywords $Keywords `
    -Products $Products `
    -TargetUrls $TargetUrls `
    -TimeoutMs $TimeoutMs `
    -EstimatedCostMicros $EstimatedCostMicros `
    -AbsoluteBudgetMicros $AbsoluteBudgetMicros `
    -MaxPaidCalls $MaxPaidCalls `
    -CandidateLimit $CandidateLimit `
    -LocationCode $LocationCode `
    -LanguageCode $LanguageCode
exit $LASTEXITCODE
