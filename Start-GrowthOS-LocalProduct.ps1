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
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot `
    "ops\local-product\Start-GrowthOS-LocalProduct.ps1"
& $script `
    -RuntimeRoot $RuntimeRoot `
    -ManifestPath $ManifestPath `
    -RepositoryRoot $PSScriptRoot `
    -EnableAi:$EnableAi `
    -EnableGmail:$EnableGmail `
    -EnableGmailSend:$EnableGmailSend `
    -EnableGmailSync:$EnableGmailSync `
    -EnableDataForSeo:$EnableDataForSeo `
    -EnableBrowser:$EnableBrowser `
    -AiMaxCalls $AiMaxCalls `
    -DataForSeoMaxPaidCalls $DataForSeoMaxPaidCalls `
    -GmailRolling24HourSendLimit $GmailRolling24HourSendLimit `
    -GmailMinimumIntervalSeconds $GmailMinimumIntervalSeconds `
    -GmailPollingIntervalSeconds $GmailPollingIntervalSeconds `
    -SkipBuild:$SkipBuild
exit $LASTEXITCODE
