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
    [ValidateSet("openai", "vercel-ai-gateway")]
    [string]$ProviderRef = "openai",
    [string]$BaseUrl = "https://api.openai.com/v1",
    [string]$ModelId = "gpt-5.6-luna",
    [string]$ModelVersion = "2026-08-03",
    [ValidateRange(1, 10000)]
    [int]$MaxCalls = 25,
    [ValidateRange(1, 45000)]
    [int]$TimeoutMs = 45000,
    [int]$MaxInputTokens = 8000,
    [int]$MaxOutputTokens = 1200,
    [decimal]$AbsoluteBudgetUsd = 0.05,
    [decimal]$InputCostUsdPerMillionTokens = 0.10,
    [decimal]$OutputCostUsdPerMillionTokens = 0.60
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Import-GrowthOS-LocalProductAiCredential.ps1 requires Windows"
}

function Require-Text($Value, [string]$Prompt) {
    $current = if ($null -eq $Value) { "" } else { ([string]$Value).Trim() }
    if ($current.Length -eq 0) {
        $current = (Read-Host $Prompt).Trim()
    }
    if ($current.Length -eq 0) {
        throw "LOCAL_PRODUCT_AI_INPUT_REQUIRED:$Prompt"
    }
    return $current
}

function Require-PositiveDecimal(
    [decimal]$Value,
    [string]$Prompt
) {
    $current = $Value
    if ($current -le 0) {
        $text = (Read-Host $Prompt).Trim()
        if (
            -not [decimal]::TryParse(
                $text,
                [Globalization.NumberStyles]::Number,
                [Globalization.CultureInfo]::InvariantCulture,
                [ref]$current
            ) -or $current -le 0
        ) {
            throw "LOCAL_PRODUCT_AI_INPUT_INVALID:$Prompt"
        }
    }
    return $current
}

$ModelId = Require-Text $ModelId "AI model ID"
$BaseUrl = Require-Text $BaseUrl "AI Provider Base URL"
$ModelVersion = Require-Text $ModelVersion "Model version label"
$InputCostUsdPerMillionTokens = Require-PositiveDecimal `
    $InputCostUsdPerMillionTokens `
    "Input cost USD per 1,000,000 tokens"
$OutputCostUsdPerMillionTokens = Require-PositiveDecimal `
    $OutputCostUsdPerMillionTokens `
    "Output cost USD per 1,000,000 tokens"
$credentialLabel = switch ($ProviderRef) {
    "openai" { "OpenAI API key" }
    "vercel-ai-gateway" { "Vercel AI Gateway API key" }
}
$credential = Read-Host $credentialLabel -AsSecureString

$bstr = [IntPtr]::Zero
$plainCredential = $null
$payload = $null
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential)
    $plainCredential = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        $bstr
    )
    if ([string]::IsNullOrWhiteSpace($plainCredential)) {
        throw "LOCAL_PRODUCT_AI_CREDENTIAL_REQUIRED"
    }
    $payload = [ordered]@{
        apiKey = $plainCredential
        providerRef = $ProviderRef
        baseUrl = $BaseUrl
        modelId = $ModelId
        modelVersion = $ModelVersion
        maxCalls = $MaxCalls
        timeoutMs = $TimeoutMs
        maxInputTokens = $MaxInputTokens
        maxOutputTokens = $MaxOutputTokens
        absoluteBudgetUsd = $AbsoluteBudgetUsd
        inputCostUsdPerMillionTokens =
            $InputCostUsdPerMillionTokens
        outputCostUsdPerMillionTokens =
            $OutputCostUsdPerMillionTokens
    } | ConvertTo-Json -Compress

    $node = (Get-Command node).Source
    $tsx = Join-Path $RepositoryRoot `
        "backend\core\node_modules\tsx\dist\cli.mjs"
    $script = Join-Path $RepositoryRoot `
        "backend\core\scripts\import-local-product-ai-credential.ts"
    foreach ($path in @($node, $tsx, $script, $ManifestPath)) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "LOCAL_PRODUCT_AI_IMPORT_DEPENDENCY_MISSING:$path"
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
        throw "LOCAL_PRODUCT_AI_IMPORT_PROCESS_START_FAILED"
    }
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "LOCAL_PRODUCT_AI_IMPORT_FAILED:$($stderr.Trim())"
    }
    Write-Output $stdout.Trim()
}
finally {
    $payload = $null
    $plainCredential = $null
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

& (Join-Path $RepositoryRoot "ops\live\Set-LocalProductSecretAcl.ps1") `
    -SecretRoot (Join-Path $RuntimeRoot "secrets") | Out-Null
