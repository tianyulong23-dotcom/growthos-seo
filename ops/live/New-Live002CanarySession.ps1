param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceId,

    [Parameter(Mandatory = $true)]
    [string]$WebsiteProjectId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[a-z0-9-]+$")]
    [string]$OutputName,

    [string]$SessionId = "live002-browser",
    [int]$TtlSeconds = 300,
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "GrowthOS\live001")
)

$ErrorActionPreference = "Stop"

function Read-EnvironmentFile([string]$Path) {
    $values = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        $values[$parts[0].Trim()] = $parts[1].Trim()
    }
    return $values
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
    return [Convert]::ToBase64String($Bytes).
        TrimEnd("=").
        Replace("+", "-").
        Replace("/", "_")
}

$environment = Read-EnvironmentFile (
    Join-Path $RuntimeRoot "fastapi.env"
)
$maximumTtl = [int]$environment["PLATFORM_AUTH_MAX_TOKEN_TTL_SECONDS"]
if ($TtlSeconds -lt 1 -or $TtlSeconds -gt $maximumTtl) {
    throw "TtlSeconds must be between 1 and $maximumTtl"
}

$signingKeyPath = $environment["PLATFORM_AUTH_SIGNING_KEY_FILE"]
$signingKey = [IO.File]::ReadAllText(
    $signingKeyPath,
    [Text.Encoding]::UTF8
).Trim()
if ([Text.Encoding]::UTF8.GetByteCount($signingKey) -lt 32) {
    throw "Platform auth signing key must contain at least 32 bytes"
}

$issuedAt = [DateTimeOffset]::UtcNow
$expiresAt = $issuedAt.AddSeconds($TtlSeconds)
$payload = [ordered]@{
    version = "PlatformAccessToken.v1"
    issuer = $environment["PLATFORM_AUTH_ISSUER"]
    audience = "growthos-platform-gateway"
    issuedAt = $issuedAt.ToString("o")
    expiresAt = $expiresAt.ToString("o")
    actor = [ordered]@{
        userId = "live002-canary-user"
        sessionId = $SessionId
    }
    memberships = @(
        [ordered]@{
            organizationId = "11111111-1111-4111-8111-111111111111"
            workspaceId = $WorkspaceId
            roles = @("member")
            projectIds = @($WebsiteProjectId)
            permissions = @("backlinks:read", "backlinks:write")
        }
    )
}

$payloadJson = $payload | ConvertTo-Json -Compress -Depth 8
$encodedPayload = ConvertTo-Base64Url (
    [Text.Encoding]::UTF8.GetBytes($payloadJson)
)
$signedValue = [Text.Encoding]::ASCII.GetBytes(
    "PlatformAccessToken.v1.$encodedPayload"
)
$hmac = New-Object Security.Cryptography.HMACSHA256 (
    ,[Text.Encoding]::UTF8.GetBytes($signingKey)
)
try {
    $encodedSignature = ConvertTo-Base64Url (
        $hmac.ComputeHash($signedValue)
    )
}
finally {
    $hmac.Dispose()
}

$sessionDirectory = Join-Path $RuntimeRoot "sessions"
New-Item -ItemType Directory -Path $sessionDirectory -Force | Out-Null
$outputPath = Join-Path $sessionDirectory $OutputName
[IO.File]::WriteAllText(
    $outputPath,
    "$encodedPayload.$encodedSignature",
    (New-Object Text.UTF8Encoding($false))
)

[pscustomobject]@{
    outputPath = $outputPath
    expiresAt = $expiresAt.ToString("o")
    length = (Get-Item -LiteralPath $outputPath).Length
}
