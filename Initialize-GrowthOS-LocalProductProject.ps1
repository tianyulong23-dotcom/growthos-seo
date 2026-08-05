param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$ProjectKey = "elephtv",
    [string]$ProjectName = "ElephTV",
    [string]$ProjectDomain = "elephtv.com"
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot `
    "ops\local-product\Initialize-GrowthOS-LocalProductProject.ps1"
& $script `
    -RuntimeRoot $RuntimeRoot `
    -ManifestPath $ManifestPath `
    -ProjectKey $ProjectKey `
    -ProjectName $ProjectName `
    -ProjectDomain $ProjectDomain
exit $LASTEXITCODE
