param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialPath,

    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),

    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),

    [ValidateRange(1, 1000)]
    [int]$MaxSendCalls = 20,

    [string]$RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..\..")
    ).Path
)

$ErrorActionPreference = "Stop"
$resolvedCredentialPath = (Resolve-Path -LiteralPath $CredentialPath).Path
$resolvedRepositoryRoot = (
    Resolve-Path -LiteralPath $RepositoryRoot
).Path.TrimEnd("\") + "\"
if ($resolvedCredentialPath.StartsWith(
    $resolvedRepositoryRoot,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "GOOGLE_OAUTH_CREDENTIAL_FILE_MUST_BE_OUTSIDE_REPOSITORY"
}

$secretRoot = Join-Path $RuntimeRoot "secrets"
& (Join-Path $PSScriptRoot "Set-LocalProductSecretAcl.ps1") `
    -SecretRoot $secretRoot | Out-Null

$coreRoot = Join-Path $RepositoryRoot "backend\core"
& (Get-Command npm.cmd).Source `
    --prefix $coreRoot `
    run live:google-oauth:import `
    -- `
    --credentials $resolvedCredentialPath `
    --manifest $ManifestPath `
    --secret-root $secretRoot `
    --max-send-calls $MaxSendCalls
if ($LASTEXITCODE -ne 0) {
    throw "GOOGLE_OAUTH_CREDENTIAL_IMPORT_FAILED"
}

& (Join-Path $PSScriptRoot "Set-LocalProductSecretAcl.ps1") `
    -SecretRoot $secretRoot | Out-Null

if (Test-Path -LiteralPath $resolvedCredentialPath) {
    throw "GOOGLE_OAUTH_CREDENTIAL_FILE_DELETE_FAILED"
}
