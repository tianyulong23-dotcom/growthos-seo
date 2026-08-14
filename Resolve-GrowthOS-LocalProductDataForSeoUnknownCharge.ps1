[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProviderRequestId,
    [Parameter(Mandatory = $false)]
    [switch]$AssumeChargedAtReservation,
    [Parameter(Mandatory = $false)]
    [switch]$AssumeNotDispatched,
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$PostgresContainer = "growthos-live001-postgres",
    [string]$Database = "growthos_live001"
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot `
    "ops\local-product\Resolve-GrowthOS-LocalProductDataForSeoUnknownCharge.ps1"
& $script @PSBoundParameters
exit $LASTEXITCODE
