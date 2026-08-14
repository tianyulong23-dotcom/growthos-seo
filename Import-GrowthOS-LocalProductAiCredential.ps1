[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$RuntimeRoot = (
        Join-Path $env:LOCALAPPDATA "GrowthOS\live001"
    ),
    [string]$ManifestPath = (
        Join-Path $env:USERPROFILE ".growthos\live\live-auth-manifest.json"
    ),
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

& (Join-Path $PSScriptRoot `
    "ops\local-product\Import-GrowthOS-LocalProductAiCredential.ps1") `
    -RuntimeRoot $RuntimeRoot `
    -ManifestPath $ManifestPath `
    -RepositoryRoot $PSScriptRoot `
    -ProviderRef $ProviderRef `
    -BaseUrl $BaseUrl `
    -ModelId $ModelId `
    -ModelVersion $ModelVersion `
    -MaxCalls $MaxCalls `
    -TimeoutMs $TimeoutMs `
    -MaxInputTokens $MaxInputTokens `
    -MaxOutputTokens $MaxOutputTokens `
    -AbsoluteBudgetUsd $AbsoluteBudgetUsd `
    -InputCostUsdPerMillionTokens $InputCostUsdPerMillionTokens `
    -OutputCostUsdPerMillionTokens $OutputCostUsdPerMillionTokens
exit $LASTEXITCODE
