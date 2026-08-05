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
    [switch]$RestartInfrastructure,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$scriptBoundParameters = $PSBoundParameters
$statePath = Join-Path $RuntimeRoot "local-product-processes.json"
$previousState = if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
        ConvertFrom-Json
}
else {
    $null
}

function Resolve-SwitchValue(
    [string]$Name,
    [bool]$PreviousValue,
    [bool]$DefaultValue = $false
) {
    if ($scriptBoundParameters.ContainsKey($Name)) {
        return [bool]$scriptBoundParameters[$Name]
    }
    if ($null -ne $previousState) {
        return $PreviousValue
    }
    return $DefaultValue
}

function Resolve-IntegerValue(
    [string]$Name,
    [object]$PreviousValue,
    [int]$DefaultValue
) {
    if ($scriptBoundParameters.ContainsKey($Name)) {
        return [int]$scriptBoundParameters[$Name]
    }
    if ($null -ne $PreviousValue) {
        return [int]$PreviousValue
    }
    return $DefaultValue
}

$aiEnabled = Resolve-SwitchValue `
    "EnableAi" ([bool]$previousState.aiEnabled)
$gmailSendEnabled = Resolve-SwitchValue `
    "EnableGmailSend" ([bool]$previousState.gmailSendEnabled)
$gmailSyncEnabled = Resolve-SwitchValue `
    "EnableGmailSync" ([bool]$previousState.gmailSyncEnabled)
if ($scriptBoundParameters.ContainsKey("EnableGmail")) {
    $gmailSendEnabled = [bool]$EnableGmail
    $gmailSyncEnabled = [bool]$EnableGmail
}
$dataForSeoEnabled = Resolve-SwitchValue `
    "EnableDataForSeo" ([bool]$previousState.dataForSeoEnabled)
$browserEnabled = Resolve-SwitchValue `
    "EnableBrowser" ([bool]$previousState.browserEnabled)
$resolvedAiMaxCalls = Resolve-IntegerValue `
    "AiMaxCalls" $previousState.aiMaxCalls 25
$resolvedDataForSeoMaxPaidCalls = Resolve-IntegerValue `
    "DataForSeoMaxPaidCalls" $previousState.dataForSeoMaxPaidCalls 25
$resolvedGmailRolling24HourSendLimit = Resolve-IntegerValue `
    "GmailRolling24HourSendLimit" `
    $previousState.gmailRolling24HourSendLimit 20
$resolvedGmailMinimumIntervalSeconds = Resolve-IntegerValue `
    "GmailMinimumIntervalSeconds" `
    $previousState.gmailMinimumIntervalSeconds 120
$resolvedGmailPollingIntervalSeconds = Resolve-IntegerValue `
    "GmailPollingIntervalSeconds" `
    $previousState.gmailPollingIntervalSeconds 60

if ($null -ne $previousState) {
    & (Join-Path $PSScriptRoot "Stop-GrowthOS-LocalProduct.ps1") `
        -RuntimeRoot $RuntimeRoot `
        -RepositoryRoot $RepositoryRoot `
        -KeepInfrastructure:(-not $RestartInfrastructure) | Out-Null
}

& (Join-Path $PSScriptRoot "Start-GrowthOS-LocalProduct.ps1") `
    -RuntimeRoot $RuntimeRoot `
    -ManifestPath $ManifestPath `
    -RepositoryRoot $RepositoryRoot `
    -EnableAi:$aiEnabled `
    -EnableGmailSend:$gmailSendEnabled `
    -EnableGmailSync:$gmailSyncEnabled `
    -EnableDataForSeo:$dataForSeoEnabled `
    -EnableBrowser:$browserEnabled `
    -AiMaxCalls $resolvedAiMaxCalls `
    -DataForSeoMaxPaidCalls $resolvedDataForSeoMaxPaidCalls `
    -GmailRolling24HourSendLimit `
        $resolvedGmailRolling24HourSendLimit `
    -GmailMinimumIntervalSeconds `
        $resolvedGmailMinimumIntervalSeconds `
    -GmailPollingIntervalSeconds `
        $resolvedGmailPollingIntervalSeconds `
    -SkipBuild:$SkipBuild
exit $LASTEXITCODE
