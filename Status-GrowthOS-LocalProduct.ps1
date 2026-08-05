param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot `
    "ops\local-product\Status-GrowthOS-LocalProduct.ps1"
& $script `
    -RuntimeRoot $RuntimeRoot `
    -RepositoryRoot $PSScriptRoot `
    -Json:$Json
exit $LASTEXITCODE
