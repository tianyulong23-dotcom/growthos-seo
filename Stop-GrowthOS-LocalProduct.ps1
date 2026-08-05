param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [int]$TimeoutSeconds = 45,
    [switch]$KeepInfrastructure
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot `
    "ops\local-product\Stop-GrowthOS-LocalProduct.ps1"
& $script `
    -RuntimeRoot $RuntimeRoot `
    -RepositoryRoot $PSScriptRoot `
    -TimeoutSeconds $TimeoutSeconds `
    -KeepInfrastructure:$KeepInfrastructure
exit $LASTEXITCODE
