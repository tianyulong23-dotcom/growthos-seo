$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $root "deploy\compose\compose.yaml"
$composeEnvFile = Join-Path $root "deploy\compose\.env"
$apiDir = Join-Path $root "backend\api"
$apiEnvFile = Join-Path $apiDir ".env"
$crawlerDir = Join-Path $root "backend\crawler"
$frontendDir = Join-Path $root "frontend"
$runtimeDir = Join-Path $root "storage\runtime"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Get-LocalSetting {
    param(
        [string]$Name,
        [string]$Default
    )

    if (Test-Path $composeEnvFile) {
        $line = Get-Content $composeEnvFile |
            Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
            Select-Object -Last 1
        if ($line) {
            return ($line -split "=", 2)[1].Trim()
        }
    }

    return $Default
}

function Get-ApiSetting {
    param(
        [string]$Name,
        [string]$Default
    )

    if (Test-Path $apiEnvFile) {
        $line = Get-Content $apiEnvFile |
            Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
            Select-Object -Last 1
        if ($line) {
            return ($line -split "=", 2)[1].Trim()
        }
    }

    return $Default
}

function Test-ProxyEndpoint {
    param([string]$ProxyUrl)

    if (-not $ProxyUrl) {
        return $true
    }
    try {
        $uri = [Uri]$ProxyUrl
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $connection = $client.ConnectAsync($uri.Host, $uri.Port)
            if (-not $connection.Wait(2000)) {
                return $false
            }
            return $client.Connected
        }
        finally {
            $client.Dispose()
        }
    }
    catch {
        return $false
    }
}

function Write-ProxyEndpoint {
    param(
        [string]$Name,
        [string]$ProxyUrl
    )

    if (-not $ProxyUrl) {
        return
    }
    $uri = [Uri]$ProxyUrl
    Write-Host "$Name proxy: $($uri.Host):$($uri.Port)"
}

function Test-Url {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Wait-ForUrl {
    param(
        [string]$Name,
        [string]$Url
    )

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Url $Url) {
            Write-Host "$Name is ready: $Url"
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "$Name did not become ready: $Url"
}

function Wait-ForComposeService {
    param([string]$Service)

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $containerId = (& docker compose -f $composeFile ps -q $Service).Trim()
        if ($containerId) {
            $state = (& docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $containerId).Trim()
            if ($state -eq "healthy" -or $state -eq "running") {
                Write-Host "$Service is ready."
                return
            }
        }
        Start-Sleep -Seconds 1
    }

    throw "$Service did not become ready."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is not available. Start Docker Desktop first."
}

Write-Host "Stopping Docker application containers..."
& docker compose -f $composeFile stop api crawler-worker frontend
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose application stop failed."
}

Write-Host "Starting Docker infrastructure..."
& docker compose -f $composeFile up -d postgres redis minio minio-init temporal
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed."
}

Wait-ForComposeService "postgres"
Wait-ForComposeService "redis"
Wait-ForComposeService "minio"
Wait-ForComposeService "temporal"

$crawlerExe = Join-Path $runtimeDir "crawler-worker-docker.exe"
$runningCrawler = Get-Process -Name "crawler-worker-docker" -ErrorAction SilentlyContinue
if ($runningCrawler) {
    throw "Crawler is still running. Run scripts\dev-down.ps1 before rebuilding."
}

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw "Go is not installed."
}

Push-Location $crawlerDir
try {
    & go build -o $crawlerExe ./cmd/crawler
    if ($LASTEXITCODE -ne 0) {
        throw "Crawler build failed."
    }
}
finally {
    Pop-Location
}

$postgresPort = Get-LocalSetting "POSTGRES_HOST_PORT" "5432"
$minioPort = Get-LocalSetting "MINIO_API_HOST_PORT" "9000"
$primaryProxy = Get-ApiSetting "CRAWLER_PROXY_URL" $env:CRAWLER_PROXY_URL
$fallbackProxy = Get-ApiSetting "CRAWLER_FALLBACK_PROXY_URL" $env:CRAWLER_FALLBACK_PROXY_URL
$businessProfileAIBaseUrl = Get-ApiSetting "BUSINESS_PROFILE_AI_BASE_URL" $env:BUSINESS_PROFILE_AI_BASE_URL
$businessProfileAIAPIKey = Get-ApiSetting "BUSINESS_PROFILE_AI_API_KEY" $env:BUSINESS_PROFILE_AI_API_KEY
$businessProfileAIModel = Get-ApiSetting "BUSINESS_PROFILE_AI_MODEL" "gpt-5.4-mini"
$businessProfileAITimeout = Get-ApiSetting "BUSINESS_PROFILE_AI_TIMEOUT" "90s"
$businessProfileAIMaxRetries = Get-ApiSetting "BUSINESS_PROFILE_AI_MAX_RETRIES" "1"
$aiSettingsEncryptionKey = Get-ApiSetting "AI_SETTINGS_ENCRYPTION_KEY" $env:AI_SETTINGS_ENCRYPTION_KEY

if (-not (Test-ProxyEndpoint $primaryProxy)) {
    throw "Crawler primary proxy is not reachable."
}
if ($fallbackProxy -and -not (Test-ProxyEndpoint $fallbackProxy)) {
    Write-Warning "Crawler fallback proxy is not reachable; primary proxy will still be used."
}
Write-ProxyEndpoint "Crawler primary" $primaryProxy
Write-ProxyEndpoint "Crawler fallback" $fallbackProxy

$env:DATABASE_URL = "postgresql+asyncpg://postgres:postgres@127.0.0.1:$postgresPort/seo"
$env:CRAWLER_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:$postgresPort/seo"
$env:REDIS_URL = "redis://127.0.0.1:$(Get-LocalSetting "REDIS_HOST_PORT" "6379")/0"
$env:TEMPORAL_ADDRESS = "127.0.0.1:$(Get-LocalSetting "TEMPORAL_HOST_PORT" "7233")"
$env:S3_ENDPOINT_URL = "http://127.0.0.1:$minioPort"
$env:S3_REGION = "us-east-1"
$env:S3_BUCKET = "seo-crawler"
$env:S3_ACCESS_KEY_ID = "minioadmin"
$env:S3_SECRET_ACCESS_KEY = "minioadmin"
$env:S3_USE_PATH_STYLE = "true"
$env:S3_CREATE_BUCKET = "true"
$env:CRAWLER_PROXY_URL = $primaryProxy
$env:CRAWLER_FALLBACK_PROXY_URL = $fallbackProxy
$env:BUSINESS_PROFILE_AI_BASE_URL = $businessProfileAIBaseUrl
$env:BUSINESS_PROFILE_AI_API_KEY = $businessProfileAIAPIKey
$env:BUSINESS_PROFILE_AI_MODEL = $businessProfileAIModel
$env:BUSINESS_PROFILE_AI_TIMEOUT = $businessProfileAITimeout
$env:BUSINESS_PROFILE_AI_MAX_RETRIES = $businessProfileAIMaxRetries
$env:AI_SETTINGS_ENCRYPTION_KEY = $aiSettingsEncryptionKey
$env:CRAWLER_BROWSER_CACHE_DIR = Join-Path $runtimeDir "browser"

$apiUrl = "http://127.0.0.1:8000/health"
if (Test-Url $apiUrl) {
    Write-Host "API is already running."
}
else {
    $uvicorn = Join-Path $apiDir ".venv\Scripts\uvicorn.exe"
    if (-not (Test-Path $uvicorn)) {
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            throw "uv is not installed."
        }
        Push-Location $apiDir
        try {
            & uv sync
            if ($LASTEXITCODE -ne 0) {
                throw "uv sync failed."
            }
        }
        finally {
            Pop-Location
        }
    }

    Push-Location $apiDir
    try {
        & (Join-Path $apiDir ".venv\Scripts\alembic.exe") upgrade head
        if ($LASTEXITCODE -ne 0) {
            throw "Database migration failed."
        }
    }
    finally {
        Pop-Location
    }

    Start-Process `
        -FilePath $uvicorn `
        -ArgumentList @("app.main:app", "--host", "127.0.0.1", "--port", "8000") `
        -WorkingDirectory $apiDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "api-docker.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeDir "api-docker.stderr.log") | Out-Null
}

$frontendUrl = "http://127.0.0.1:5173"
if (Test-Url $frontendUrl) {
    Write-Host "Frontend is already running."
}
else {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm is not installed."
    }

    if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
        Push-Location $frontendDir
        try {
            & npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed."
            }
        }
        finally {
            Pop-Location
        }
    }

    Start-Process `
        -FilePath (Get-Command npm.cmd).Source `
        -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", "5173") `
        -WorkingDirectory $frontendDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "frontend-docker.stdout.log") `
        -RedirectStandardError (Join-Path $runtimeDir "frontend-docker.stderr.log") | Out-Null
}

Wait-ForUrl "API" $apiUrl
Wait-ForUrl "Frontend" $frontendUrl

Write-Host ""
Write-Host "SEO workspace: http://127.0.0.1:5173"
Write-Host "Temporal UI:  http://127.0.0.1:8233"
Write-Host "MinIO console: http://127.0.0.1:59001"
Write-Host "Crawler worker: starts on demand and exits after 120 seconds idle"
