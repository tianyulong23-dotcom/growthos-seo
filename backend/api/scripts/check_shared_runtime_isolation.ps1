param(
    [int]$StartupTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$RunId = "$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$Network = "growthos-arch008-$RunId"
$BacklinksContainer = "growthos-backlinks-$RunId"
$GatewayContainer = "growthos-gateway-$RunId"
$SigningKey = "test-only-platform-context-key-32-bytes"
$HttpClient = [System.Net.Http.HttpClient]::new()

function Assert-NativeSuccess {
    param([string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Wait-ForContainerLog {
    param(
        [string]$Container,
        [string]$Pattern
    )
    $Deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    do {
        $PreviousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $Logs = (& docker logs $Container 2>&1 | Out-String)
        }
        finally {
            $ErrorActionPreference = $PreviousErrorAction
        }
        if ($Logs -match $Pattern) {
            return
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $Deadline)
    throw "Container $Container did not become ready. Logs: $Logs"
}

function Invoke-RuntimeRequest {
    param(
        [string]$Method,
        [string]$Url,
        [string]$Body = "",
        [hashtable]$Headers = @{}
    )
    $Request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::new($Method),
        $Url
    )
    try {
        foreach ($Entry in $Headers.GetEnumerator()) {
            [void]$Request.Headers.TryAddWithoutValidation($Entry.Key, $Entry.Value)
        }
        if ($Body.Length -gt 0) {
            $Request.Content = [System.Net.Http.StringContent]::new(
                $Body,
                [System.Text.Encoding]::UTF8,
                "application/json"
            )
        }
        $Response = $HttpClient.SendAsync($Request).GetAwaiter().GetResult()
        try {
            return [pscustomobject]@{
                Status = [int]$Response.StatusCode
                Body = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                ContentType = $Response.Content.Headers.ContentType.MediaType
            }
        }
        finally {
            $Response.Dispose()
        }
    }
    finally {
        $Request.Dispose()
    }
}

function Assert-Status {
    param(
        [object]$Response,
        [int]$Expected,
        [string]$Label
    )
    if ($Response.Status -ne $Expected) {
        throw "$Label returned $($Response.Status), expected $Expected. Body: $($Response.Body)"
    }
}

try {
    & docker network create $Network | Out-Null
    Assert-NativeSuccess "Docker network creation"

    $ReadOnlyMount = "type=bind,source=$RepositoryRoot,target=/workspace,readonly"
    & docker run --rm --detach `
        --name $BacklinksContainer `
        --network $Network `
        --network-alias "backlinks-runtime" `
        --mount $ReadOnlyMount `
        --mount "type=volume,target=/workspace/backend/core/node_modules" `
        --workdir "/workspace/backend/core" `
        --env "PLATFORM_CONTEXT_SIGNING_KEY=$SigningKey" `
        --env "BACKLINKS_COMMAND_COUNTER=/tmp/backlinks-command-count" `
        --env "BACKLINKS_PORT=7301" `
        "node:24.14.1-bookworm" `
        sh -lc "npm ci --ignore-scripts && exec npm exec tsx -- test/backlinks/runtime/fixtures/private-service.ts" |
        Out-Null
    Assert-NativeSuccess "Backlinks container start"
    Wait-ForContainerLog $BacklinksContainer "BACKLINKS_RUNTIME_READY="

    & docker run --rm --detach `
        --name $GatewayContainer `
        --network $Network `
        --publish "127.0.0.1::8000" `
        --mount $ReadOnlyMount `
        --workdir "/workspace/backend/api" `
        --env "UV_PROJECT_ENVIRONMENT=/tmp/growthos-venv" `
        --env "UV_CACHE_DIR=/tmp/growthos-uv-cache" `
        --env "BACKLINKS_PRIVATE_BASE_URL=http://backlinks-runtime:7301" `
        --env "PLATFORM_CONTEXT_SIGNING_KEY=$SigningKey" `
        "ghcr.io/astral-sh/uv:python3.13-bookworm" `
        uv run --frozen uvicorn tests.shared_runtime_app:app --host 0.0.0.0 --port 8000 |
        Out-Null
    Assert-NativeSuccess "Gateway container start"

    $PortOutput = (& docker port $GatewayContainer "8000/tcp" 2>&1 | Out-String)
    Assert-NativeSuccess "Gateway port lookup"
    if ($PortOutput -notmatch "127\.0\.0\.1:(\d+)") {
        throw "Could not resolve the Gateway host port from: $PortOutput"
    }
    $GatewayBase = "http://127.0.0.1:$($Matches[1])"
    $Deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    do {
        try {
            $Health = Invoke-RuntimeRequest "GET" "$GatewayBase/health"
            if ($Health.Status -eq 200) {
                break
            }
        }
        catch {
            Start-Sleep -Seconds 1
        }
    } while ((Get-Date) -lt $Deadline)
    if ($Health.Status -ne 200) {
        $GatewayLogs = (& docker logs $GatewayContainer 2>&1 | Out-String)
        throw "Gateway did not become ready. Logs: $GatewayLogs"
    }

    $RouteOutput = (& docker exec $GatewayContainer `
        uv run --frozen python -m tests.shared_runtime_app 2>&1 | Out-String)
    Assert-NativeSuccess "Runtime route count"
    $RouteCount = ($RouteOutput -split "\r?\n" |
        Where-Object { $_.Trim().Length -gt 0 } |
        Select-Object -Last 1).Trim()
    if ($RouteCount -ne "7") {
        throw "Expected seven Backlinks Gateway routes, got: $RouteOutput"
    }

    $Context = Invoke-RuntimeRequest "GET" (
        "$GatewayBase/api/v1/projects/project-key/backlinks/context"
    )
    Assert-Status $Context 200 "Backlinks context before stop"
    $Audit = Invoke-RuntimeRequest "GET" "$GatewayBase/api/v1/audit/probe"
    Assert-Status $Audit 200 "Audit probe before stop"

    $RejectBody = @{
        expectedVersion = 1
        rejectionType = "permanently_rejected"
        reasonCode = "not_relevant"
        cooldownUntil = $null
    } | ConvertTo-Json -Compress
    $Reject = Invoke-RuntimeRequest `
        "POST" `
        "$GatewayBase/api/v1/projects/project-key/backlinks/recommendations/018f0000-0000-7000-8000-000000000003/reject" `
        $RejectBody `
        @{ "idempotency-key" = "runtime-reject-once" }
    Assert-Status $Reject 200 "Backlinks command before stop"
    $CommandCount = (& docker exec $BacklinksContainer `
        cat /tmp/backlinks-command-count 2>&1 | Out-String).Trim()
    Assert-NativeSuccess "Backlinks command count"
    if ($CommandCount -ne "1") {
        throw "Expected one Backlinks command execution, got $CommandCount."
    }

    & docker stop --time 5 $BacklinksContainer | Out-Null
    Assert-NativeSuccess "Backlinks container stop"

    $HealthAfterStop = Invoke-RuntimeRequest "GET" "$GatewayBase/health"
    Assert-Status $HealthAfterStop 200 "Platform health after Backlinks stop"
    $AuditAfterStop = Invoke-RuntimeRequest "GET" "$GatewayBase/api/v1/audit/probe"
    Assert-Status $AuditAfterStop 200 "Audit probe after Backlinks stop"
    $Unavailable = Invoke-RuntimeRequest "GET" (
        "$GatewayBase/api/v1/projects/project-key/backlinks/context"
    )
    Assert-Status $Unavailable 503 "Backlinks request after stop"
    $Problem = $Unavailable.Body | ConvertFrom-Json
    if (
        $Unavailable.ContentType -ne "application/problem+json" -or
        $Problem.code -ne "BACKLINKS_UNAVAILABLE" -or
        $Problem.retryable -ne $true
    ) {
        throw "Unexpected unavailable response: $($Unavailable.Body)"
    }

    $GatewaySource = Get-Content -Raw (
        Join-Path $RepositoryRoot "backend\api\app\core\backlinks_gateway.py"
    )
    if ($GatewaySource -match "(?i)\b(sqlalchemy|psycopg|insert\s+into|delete\s+from)\b") {
        throw "Gateway source contains a prohibited Backlinks database fallback."
    }

    Write-Output (
        "Shared runtime isolation passed: routes=7, commandCount=1, " +
        "healthAfterStop=200, auditAfterStop=200, backlinksAfterStop=503."
    )
}
finally {
    $HttpClient.Dispose()
    $PreviousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        & docker rm --force $GatewayContainer 2>$null | Out-Null
        & docker rm --force $BacklinksContainer 2>$null | Out-Null
        & docker network rm $Network 2>$null | Out-Null
    }
    finally {
        $ErrorActionPreference = $PreviousErrorAction
    }
}
