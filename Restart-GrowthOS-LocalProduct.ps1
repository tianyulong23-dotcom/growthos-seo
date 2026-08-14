param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [switch]$EnableAi,
    [switch]$EnableGmail,
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
    [int]$GmailPollingIntervalSeconds = 60,
    [ValidateSet("normal", "quiesced")]
    [string]$WorkerExecutionMode = "normal",
    [switch]$RestartInfrastructure,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot `
    "ops\local-product\Restart-GrowthOS-LocalProduct.ps1"
$arguments = @{
    RepositoryRoot = $PSScriptRoot
}
foreach ($name in $PSBoundParameters.Keys) {
    $arguments[$name] = $PSBoundParameters[$name]
}
& $script @arguments
exit $LASTEXITCODE
