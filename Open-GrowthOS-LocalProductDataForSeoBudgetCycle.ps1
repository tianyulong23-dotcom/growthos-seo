[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres",
    [string]$Database = "growthos_live001",
    [ValidateRange(1, 100000000)]
    [int64]$ApprovedLimitMicros = 1000000,
    [ValidateRange(1, 1000)]
    [int]$MaxPaidCalls = 250
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot `
    "ops\local-product\Open-GrowthOS-LocalProductDataForSeoBudgetCycle.ps1"
& $script @PSBoundParameters
exit $LASTEXITCODE
