param(
    [Parameter(Mandatory = $true)]
    [string]$ProspectHostname
)

& "$PSScriptRoot\ops\local-product\Initialize-GrowthOS-LocalProductRecommendation.ps1" `
    -ProspectHostname $ProspectHostname
exit $LASTEXITCODE
