[CmdletBinding(PositionalBinding = $false)]
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
    [string]$WebsiteProjectKey,
    [string]$CredentialSecretReference = (
        "secret://growthos/local-product/dataforseo/provider-credential/v1"
    ),
    [string[]]$EndpointAllowlist = @(
        "https://api.dataforseo.com/v3/backlinks/referring_domains/live"
    ),
    [Parameter(Mandatory = $true)]
    [Alias("DiscoveryTarget")]
    [string[]]$DiscoveryTargets,
    [Parameter(Mandatory = $true)]
    [string[]]$Keywords,
    [Parameter(Mandatory = $true)]
    [string[]]$Products,
    [Parameter(Mandatory = $true)]
    [string[]]$TargetUrls,
    [int]$TimeoutMs = 60000,
    [int64]$EstimatedCostMicros = 1000,
    [int64]$AbsoluteBudgetMicros = 5000,
    [ValidateRange(1, 1000)]
    [int]$MaxPaidCalls = 25,
    [int]$CandidateLimit = 25,
    [string]$LocationCode = "2840",
    [string]$LanguageCode = "en"
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Import-GrowthOS-LocalProductDataForSeoCredential.ps1 requires Windows"
}

function Require-Text($Value, [string]$Name) {
    if ($null -eq $Value -or ([string]$Value).Trim().Length -eq 0) {
        throw "LOCAL_PRODUCT_DATAFORSEO_INPUT_REQUIRED:$Name"
    }
    return ([string]$Value).Trim()
}

if ([string]::IsNullOrWhiteSpace($WebsiteProjectKey)) {
    $identityPath = Join-Path $RuntimeRoot "identity.json"
    if (-not (Test-Path -LiteralPath $identityPath)) {
        throw "LOCAL_PRODUCT_IDENTITY_NOT_FOUND"
    }
    $identity = Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 |
        ConvertFrom-Json
    $WebsiteProjectKey = Require-Text `
        $identity.websiteProjectKey `
        "WebsiteProjectKey"
}

$login = Read-Host "DataForSEO login"
$password = Read-Host "DataForSEO password" -AsSecureString
$bstr = [IntPtr]::Zero
$plainPassword = $null
$payload = $null
try {
    $login = Require-Text $login "DataForSEO login"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $plainPassword = Require-Text $plainPassword "DataForSEO password"
    $payload = [ordered]@{
        login = $login
        password = $plainPassword
        websiteProjectKey = $WebsiteProjectKey
        credentialSecretRef = $CredentialSecretReference
        endpointAllowlist = @($EndpointAllowlist)
        timeoutMs = $TimeoutMs
        estimatedCostMicros = $EstimatedCostMicros
        absoluteBudgetMicros = $AbsoluteBudgetMicros
        maxPaidCalls = $MaxPaidCalls
        candidateLimit = $CandidateLimit
        locationCode = $LocationCode
        languageCode = $LanguageCode
        discoveryTargets = @($DiscoveryTargets)
        keywords = @($Keywords)
        products = @($Products)
        targetUrls = @($TargetUrls)
    } | ConvertTo-Json -Compress

    $node = (Get-Command node).Source
    $tsx = Join-Path $RepositoryRoot `
        "backend\core\node_modules\tsx\dist\cli.mjs"
    $script = Join-Path $RepositoryRoot `
        "backend\core\scripts\import-local-product-dataforseo-credential.ts"
    foreach ($path in @($node, $tsx, $script)) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "LOCAL_PRODUCT_DATAFORSEO_IMPORT_DEPENDENCY_MISSING:$path"
        }
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $node
    $startInfo.Arguments = (
        '"{0}" "{1}"' -f
            $tsx.Replace('"', '\"'),
            $script.Replace('"', '\"')
    )
    $startInfo.WorkingDirectory = Join-Path $RepositoryRoot "backend\core"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["LIVE_AUTH_MANIFEST_PATH"] = $ManifestPath
    $startInfo.EnvironmentVariables[
        "GROWTHOS_LOCAL_PRODUCT_RUNTIME_ROOT"
    ] = $RuntimeRoot

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "LOCAL_PRODUCT_DATAFORSEO_IMPORT_PROCESS_START_FAILED"
    }
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "LOCAL_PRODUCT_DATAFORSEO_IMPORT_FAILED:$($stderr.Trim())"
    }
    Write-Output $stdout.Trim()
}
finally {
    $payload = $null
    $plainPassword = $null
    $login = $null
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

& (Join-Path $RepositoryRoot "ops\live\Set-LocalProductSecretAcl.ps1") `
    -SecretRoot (Join-Path $RuntimeRoot "secrets") | Out-Null
