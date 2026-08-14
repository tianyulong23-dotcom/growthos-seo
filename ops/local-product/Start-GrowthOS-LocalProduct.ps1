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
    [switch]$EnableAi,
    [switch]$EnableGmail,
    [switch]$EnableGmailSend,
    [switch]$EnableGmailSync,
    [switch]$EnableDataForSeo,
    [switch]$EnableBrowser,
    [ValidateRange(1, 10000)]
    [int]$AiMaxCalls = 25,
    [ValidateRange(1, 1000)]
    [int]$DataForSeoMaxPaidCalls = 25,
    [ValidateRange(1, 1000)]
    [int]$GmailRolling24HourSendLimit = 20,
    [ValidateRange(0, 86400)]
    [int]$GmailMinimumIntervalSeconds = 120,
    [ValidateRange(15, 3600)]
    [int]$GmailPollingIntervalSeconds = 60,
    [ValidateSet("normal", "quiesced")]
    [string]$WorkerExecutionMode = "normal",
    [switch]$PreflightOnly,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$scriptBoundParameters = $PSBoundParameters

if ($env:OS -ne "Windows_NT") {
    throw "Start-GrowthOS-LocalProduct.ps1 requires Windows"
}

function Read-EnvironmentSetting(
    [string]$Path,
    [string]$Name
) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        if ($parts.Length -ne 2 -or $parts[0].Trim().Length -eq 0) {
            throw "Invalid environment line in $Path"
        }
        if ($parts[0].Trim() -eq $Name) {
            return $parts[1].Trim()
        }
    }
    return $null
}

function Test-DataForSeoSecretReferenceAvailable(
    [string]$Reference
) {
    if (
        [string]::IsNullOrWhiteSpace($Reference) -or
        $Reference -notmatch (
            "^secret://growthos/local-product/" +
            "(dataforseo/.+)/(v[1-9][0-9]*)$"
        )
    ) {
        return $false
    }
    $externalSecretId = $Matches[1]
    $externalSecretVersion = $Matches[2]
    $secretRoot = Join-Path $RuntimeRoot "secrets"
    if (-not (Test-Path -LiteralPath (
        Join-Path $secretRoot "master-key.bin"
    ))) {
        return $false
    }
    $valuesRoot = Join-Path $secretRoot "values"
    if (-not (Test-Path -LiteralPath $valuesRoot)) {
        return $false
    }
    foreach (
        $path in Get-ChildItem -LiteralPath $valuesRoot -Recurse `
            -Filter "$externalSecretVersion.json" -File
    ) {
        try {
            $envelope = Get-Content -LiteralPath $path.FullName `
                -Raw -Encoding UTF8 | ConvertFrom-Json
            if (
                $envelope.secretKind -eq "DATAFORSEO_CREDENTIAL" -and
                $envelope.externalSecretId -eq $externalSecretId -and
                $envelope.externalSecretVersion -eq $externalSecretVersion
            ) {
                return $true
            }
        }
        catch {
        }
    }
    return $false
}

function Test-GoogleOauthSecretReferenceAvailable(
    [string]$Reference
) {
    if (
        [string]::IsNullOrWhiteSpace($Reference) -or
        $Reference -notmatch (
            "^secret://growthos/local-product/" +
            "(google/.+)/(v[1-9][0-9]*)$"
        )
    ) {
        return $false
    }
    $externalSecretId = $Matches[1]
    $externalSecretVersion = $Matches[2]
    $secretRoot = Join-Path $RuntimeRoot "secrets"
    if (-not (Test-Path -LiteralPath (
        Join-Path $secretRoot "master-key.bin"
    ))) {
        return $false
    }
    $valuesRoot = Join-Path $secretRoot "values"
    if (-not (Test-Path -LiteralPath $valuesRoot)) {
        return $false
    }
    foreach (
        $path in Get-ChildItem -LiteralPath $valuesRoot -Recurse `
            -Filter "$externalSecretVersion.json" -File
    ) {
        try {
            $envelope = Get-Content -LiteralPath $path.FullName `
                -Raw -Encoding UTF8 | ConvertFrom-Json
            if (
                $envelope.secretKind -eq "GOOGLE_OAUTH_CLIENT_SECRET" -and
                $envelope.externalSecretId -eq $externalSecretId -and
                $envelope.externalSecretVersion -eq $externalSecretVersion
            ) {
                return $true
            }
        }
        catch {
        }
    }
    return $false
}

function Get-GoogleOauthClientSecretReference {
    $workerEnvironment = Join-Path $RuntimeRoot "backlinks-worker.env"
    $configured = Read-EnvironmentSetting `
        $workerEnvironment "GOOGLE_OAUTH_CLIENT_SECRET_REF"
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return $configured
    }
    if (-not (Test-Path -LiteralPath $ManifestPath)) {
        return $null
    }
    try {
        $manifest = Get-Content -LiteralPath $ManifestPath `
            -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$manifest.google.oauthClientSecretRef
    }
    catch {
        return $null
    }
}

function Resolve-DataForSeoRequested {
    if ($scriptBoundParameters.ContainsKey("EnableDataForSeo")) {
        return [bool]$scriptBoundParameters["EnableDataForSeo"]
    }
    return (
        Read-EnvironmentSetting `
            (Join-Path $RuntimeRoot "backlinks-worker.env") `
            "DATAFORSEO_ENABLED"
    ) -eq "true"
}

function Resolve-DataForSeoEnabled {
    if (
        $env:CI -eq "true" -or
        $env:NODE_ENV -eq "test"
    ) {
        return $false
    }
    if (-not (Resolve-DataForSeoRequested)) {
        return $false
    }
    $secretReference = Read-EnvironmentSetting `
        (Join-Path $RuntimeRoot "backlinks-worker.env") `
        "DATAFORSEO_CREDENTIAL_SECRET_REF"
    if (-not (Test-DataForSeoSecretReferenceAvailable $secretReference)) {
        throw (
            "LOCAL_PRODUCT_DATAFORSEO_CONFIG_REQUIRED:" +
            "credential Secret Reference is unavailable"
        )
    }
    return $true
}

function Resolve-DataForSeoMaxPaidCalls {
    if ($scriptBoundParameters.ContainsKey("DataForSeoMaxPaidCalls")) {
        return [int]$scriptBoundParameters["DataForSeoMaxPaidCalls"]
    }
    if (-not $EnableDataForSeo) {
        return $DataForSeoMaxPaidCalls
    }
    $configured = Read-EnvironmentSetting `
        (Join-Path $RuntimeRoot "backlinks-worker.env") `
        "DATAFORSEO_MAX_PAID_CALLS"
    $parsed = 0
    if (
        [int]::TryParse([string]$configured, [ref]$parsed) -and
        $parsed -ge 1 -and
        $parsed -le 1000
    ) {
        return $parsed
    }
    return $DataForSeoMaxPaidCalls
}

function Resolve-GmailCapabilityEnabled(
    [string]$ParameterName,
    [string]$EnvironmentName
) {
    if (
        $env:CI -eq "true" -or
        $env:NODE_ENV -eq "test"
    ) {
        return $false
    }
    $requested = if ($scriptBoundParameters.ContainsKey("EnableGmail")) {
        [bool]$scriptBoundParameters["EnableGmail"]
    }
    elseif ($scriptBoundParameters.ContainsKey($ParameterName)) {
        [bool]$scriptBoundParameters[$ParameterName]
    }
    else {
        (
            Read-EnvironmentSetting `
                (Join-Path $RuntimeRoot "backlinks-worker.env") `
                $EnvironmentName
        ) -eq "true"
    }
    if (-not $requested) {
        return $false
    }
    if (
        -not (
            Test-GoogleOauthSecretReferenceAvailable `
                (Get-GoogleOauthClientSecretReference)
        )
    ) {
        throw (
            "LOCAL_PRODUCT_GMAIL_CONFIG_REQUIRED:" +
            "Google OAuth client Secret Reference is unavailable"
        )
    }
    return $true
}

$EnableDataForSeo = Resolve-DataForSeoEnabled
$DataForSeoMaxPaidCalls = Resolve-DataForSeoMaxPaidCalls
$EnableGmailSend = Resolve-GmailCapabilityEnabled `
    "EnableGmailSend" "GMAIL_SEND_ENABLED"
$EnableGmailSync = Resolve-GmailCapabilityEnabled `
    "EnableGmailSync" "GMAIL_SYNC_ENABLED"

function Invoke-ResolvedLocalProductConfiguration(
    [string]$BuildId,
    [switch]$ValidateOnly
) {
    & (Join-Path $PSScriptRoot "Set-LocalProductConfiguration.ps1") `
        -RuntimeRoot $RuntimeRoot `
        -ManifestPath $ManifestPath `
        -RepositoryRoot $RepositoryRoot `
        -EnableAi:$EnableAi `
        -EnableGmailSend:$EnableGmailSend `
        -EnableGmailSync:$EnableGmailSync `
        -EnableDataForSeo:$EnableDataForSeo `
        -EnableBrowser:$EnableBrowser `
        -AiMaxCalls $AiMaxCalls `
        -DataForSeoMaxPaidCalls $DataForSeoMaxPaidCalls `
        -GmailRolling24HourSendLimit $GmailRolling24HourSendLimit `
        -GmailMinimumIntervalSeconds $GmailMinimumIntervalSeconds `
        -GmailPollingIntervalSeconds $GmailPollingIntervalSeconds `
        -WorkerExecutionMode $WorkerExecutionMode `
        -BuildId $BuildId `
        -ValidateOnly:$ValidateOnly
}

if ($PreflightOnly) {
    $configuration = Invoke-ResolvedLocalProductConfiguration `
        -ValidateOnly
    [pscustomobject]@{
        status = "ok"
        preflightOnly = $true
        runtimeMode = "LOCAL_PRODUCT"
        projectKey = $configuration.projectKey
        dataForSeoEnabled = [bool]$EnableDataForSeo
        dataForSeoMaxPaidCalls = $DataForSeoMaxPaidCalls
        gmailSendEnabled = [bool]$EnableGmailSend
        gmailSyncEnabled = [bool]$EnableGmailSync
        workerExecutionMode = $WorkerExecutionMode
    }
    return
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class GrowthOsLocalProductProcessGroup
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static uint Start(string commandLine, string currentDirectory)
    {
        const uint CREATE_NEW_CONSOLE = 0x00000010;
        const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
        const int STARTF_USESHOWWINDOW = 0x00000001;
        const short SW_HIDE = 0;

        STARTUPINFO startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startupInfo.dwFlags = STARTF_USESHOWWINDOW;
        startupInfo.wShowWindow = SW_HIDE;

        PROCESS_INFORMATION processInformation;
        bool created = CreateProcess(
            null,
            new StringBuilder(commandLine),
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP,
            IntPtr.Zero,
            currentDirectory,
            ref startupInfo,
            out processInformation
        );
        if (!created)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        CloseHandle(processInformation.hThread);
        CloseHandle(processInformation.hProcess);
        return processInformation.dwProcessId;
    }
}
"@

function Quote-Argument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Write-State([hashtable]$State, [string]$Path) {
    $json = $State | ConvertTo-Json
    [System.IO.File]::WriteAllText(
        $Path,
        $json,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Invoke-Checked(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
) {
    Push-Location $WorkingDirectory
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $FilePath @ArgumentList 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($exitCode -ne 0) {
        $details = ($output | ForEach-Object { [string]$_ }) `
            -join [Environment]::NewLine
        throw "$FilePath failed with exit code $exitCode`n$details"
    }
}

function Invoke-CheckedCapture(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
) {
    Push-Location $WorkingDirectory
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $FilePath @ArgumentList 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($exitCode -ne 0) {
        $details = ($output | ForEach-Object { [string]$_ }) `
            -join [Environment]::NewLine
        throw "$FilePath failed with exit code $exitCode`n$details"
    }
    return ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
}

function Wait-ContainerHealthy([string]$Name) {
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $state = docker inspect `
            --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" `
            $Name 2>$null
        if ($LASTEXITCODE -eq 0 -and $state -eq "healthy") {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "$Name did not become healthy"
}

function Invoke-LocalProductAlembicUpgrade {
    $environmentPath = Join-Path $RuntimeRoot "fastapi.env"
    $python = Join-Path $RuntimeRoot "python\Scripts\python.exe"
    $adminPasswordPath = Join-Path $RuntimeRoot `
        "secrets\postgres-admin-password"
    if (-not (Test-Path -LiteralPath $environmentPath)) {
        throw "LOCAL_PRODUCT_FASTAPI_ENVIRONMENT_MISSING"
    }
    if (-not (Test-Path -LiteralPath $python)) {
        throw "LOCAL_PRODUCT_PYTHON_RUNTIME_MISSING"
    }
    if (-not (Test-Path -LiteralPath $adminPasswordPath)) {
        throw "LOCAL_PRODUCT_POSTGRES_ADMIN_PASSWORD_MISSING"
    }

    $previousEnvironment = @{}
    try {
        foreach (
            $rawLine in Get-Content -LiteralPath $environmentPath -Encoding UTF8
        ) {
            $line = $rawLine.Trim()
            if ($line.Length -eq 0 -or $line.StartsWith("#")) {
                continue
            }
            $parts = $line.Split("=", 2)
            if ($parts.Length -ne 2 -or $parts[0].Trim().Length -eq 0) {
                throw "Invalid environment line in $environmentPath"
            }
            $name = $parts[0].Trim()
            $previousEnvironment[$name] =
                [Environment]::GetEnvironmentVariable($name, "Process")
            [Environment]::SetEnvironmentVariable(
                $name,
                $parts[1],
                "Process"
            )
        }
        $adminPassword = (
            Get-Content -LiteralPath $adminPasswordPath -Raw -Encoding UTF8
        ).Trim()
        if ($adminPassword.Length -eq 0) {
            throw "LOCAL_PRODUCT_POSTGRES_ADMIN_PASSWORD_EMPTY"
        }
        $previousEnvironment["ALEMBIC_DATABASE_URL"] =
            [Environment]::GetEnvironmentVariable(
                "ALEMBIC_DATABASE_URL",
                "Process"
            )
        $encodedAdminPassword = [System.Uri]::EscapeDataString(
            $adminPassword
        )
        [Environment]::SetEnvironmentVariable(
            "ALEMBIC_DATABASE_URL",
            "postgresql+psycopg://postgres:$encodedAdminPassword" +
                "@127.0.0.1:55432/growthos_live001",
            "Process"
        )
        Invoke-Checked `
            $python `
            @("-m", "alembic", "upgrade", "head") `
            (Join-Path $RepositoryRoot "backend\api")
    }
    finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable(
                [string]$entry.Key,
                $entry.Value,
                "Process"
            )
        }
    }
}

function Wait-HttpReady(
    [string]$Uri,
    [uint32]$GroupPid,
    [string]$ExpectedBuildId
) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
            throw "Process group $GroupPid exited before $Uri became ready"
        }
        try {
            $response = Invoke-RestMethod -Uri $Uri -TimeoutSec 5
            if (
                $response.status -eq "ok" `
                -and (
                    [string]::IsNullOrWhiteSpace($ExpectedBuildId) `
                    -or [string]$response.build.buildId -eq $ExpectedBuildId
                )
            ) {
                return
            }
        }
        catch {
        }
    }
    throw "$Uri did not become ready"
}

function Wait-HttpAvailable([string]$Uri, [uint32]$GroupPid) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
            throw "Process group $GroupPid exited before $Uri became available"
        }
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $statusCode = & curl.exe `
                --silent `
                --show-error `
                --output NUL `
                --write-out "%{http_code}" `
                --max-time 5 `
                --noproxy "*" `
                $Uri 2>$null
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($LASTEXITCODE -eq 0 -and $statusCode -eq "200") {
            return
        }
    }
    throw "$Uri did not become available"
}

function Wait-WorkerReady(
    [string]$LogPath,
    [uint32]$GroupPid,
    [string]$ExpectedBuildId,
    [string]$ExpectedExecutionMode = "normal"
) {
    for ($attempt = 0; $attempt -lt 150; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
            throw "Worker process group $GroupPid exited before readiness"
        }
        if (Test-Path -LiteralPath $LogPath) {
            foreach ($line in @(
                Get-Content -LiteralPath $LogPath -Tail 200 -Encoding UTF8
            )) {
                if ($line -notmatch '"event":"backlinks.worker.ready"') {
                    continue
                }
                try {
                    $ready = $line | ConvertFrom-Json
                }
                catch {
                    continue
                }
                if (
                    -not [string]::IsNullOrWhiteSpace($ExpectedBuildId) -and
                    [string]$ready.buildId -ne $ExpectedBuildId
                ) {
                    continue
                }
                if (
                    $ExpectedExecutionMode -eq "quiesced" -and (
                        [string]$ready.workerExecutionMode -ne "quiesced" -or
                        $ready.businessConsumersRunning -ne $false -or
                        $ready.postgresReady -ne $true -or
                        $ready.temporalReady -ne $true
                    )
                ) {
                    continue
                }
                return
            }
        }
    }
    throw "Backlinks Worker did not become ready"
}

function Start-Component(
    [string]$Component,
    [string]$RunId,
    [string]$PowerShell,
    [string]$Wrapper
) {
    $logPrefix = Join-Path $RuntimeRoot "logs\$RunId-$Component"
    $commandLine = @(
        (Quote-Argument $PowerShell),
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        (Quote-Argument $Wrapper),
        "-Component",
        $Component,
        "-RuntimeRoot",
        (Quote-Argument $RuntimeRoot),
        "-RepositoryRoot",
        (Quote-Argument $RepositoryRoot),
        "-LogPrefix",
        (Quote-Argument $logPrefix)
    ) -join " "
    return [GrowthOsLocalProductProcessGroup]::Start(
        $commandLine,
        $RepositoryRoot
    )
}

function Get-LocalProductBuildIdentity {
    $coreRoot = Join-Path $RepositoryRoot "backend\core"
    $tsx = Join-Path $coreRoot "node_modules\.bin\tsx.cmd"
    if (-not (Test-Path -LiteralPath $tsx)) {
        throw "LOCAL_PRODUCT_STALE_BUILD:TSX_RUNTIME_MISSING"
    }
    Push-Location $coreRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(
            & $tsx "scripts\local-product-build-identity.ts" "check" 2>&1
        )
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw (
            "LOCAL_PRODUCT_STALE_BUILD:" +
            (($output | ForEach-Object { [string]$_ }) -join " ")
        )
    }
    try {
        $result = (($output | Select-Object -Last 1) | ConvertFrom-Json)
    }
    catch {
        throw "LOCAL_PRODUCT_STALE_BUILD:BUILD_IDENTITY_INVALID"
    }
    if ($result.ok -ne $true -or $null -eq $result.identity) {
        throw "LOCAL_PRODUCT_STALE_BUILD"
    }
    return $result.identity
}

$buildIdentity = if ($SkipBuild) {
    Get-LocalProductBuildIdentity
}
else {
    $null
}

$newStatePath = Join-Path $RuntimeRoot "local-product-processes.json"
$legacyStatePath = Join-Path $RuntimeRoot "live001-processes.json"
if (Test-Path -LiteralPath $newStatePath) {
    & (Join-Path $PSScriptRoot "Stop-GrowthOS-LocalProduct.ps1") `
        -RuntimeRoot $RuntimeRoot `
        -RepositoryRoot $RepositoryRoot `
        -KeepInfrastructure | Out-Null
}
if (Test-Path -LiteralPath $legacyStatePath) {
    & (Join-Path $RepositoryRoot "ops\live\Stop-Live001Canary.ps1") `
        -RuntimeRoot $RuntimeRoot | Out-Null
}

$applicationPorts = @(5173, 7200, 7301)
if ($EnableBrowser) {
    $applicationPorts += 7401
}
foreach ($port in $applicationPorts) {
    if (
        Get-NetTCPConnection `
            -State Listen `
            -LocalPort $port `
            -ErrorAction SilentlyContinue
    ) {
        throw "LOCAL_PRODUCT_PORT_CONFLICT:$port"
    }
}

if (-not $SkipBuild) {
    Invoke-Checked `
        (Get-Command npm.cmd).Source `
        @("run", "migration:backlinks:check") `
        (Join-Path $RepositoryRoot "backend\core")
    Invoke-Checked `
        (Get-Command npm.cmd).Source `
        @("run", "build") `
        (Join-Path $RepositoryRoot "backend\core")
    if (
        $EnableBrowser -and
        -not (Test-Path -LiteralPath (
            Join-Path $RepositoryRoot "backend\browser-worker\node_modules"
        ))
    ) {
        Invoke-Checked `
            (Get-Command npm.cmd).Source `
            @("ci") `
            (Join-Path $RepositoryRoot "backend\browser-worker")
    }
    if ($EnableBrowser) {
        Invoke-Checked `
            (Get-Command npm.cmd).Source `
            @("run", "build") `
            (Join-Path $RepositoryRoot "backend\browser-worker")
    }
    Invoke-Checked `
        (Get-Command npm.cmd).Source `
        @("run", "build") `
        (Join-Path $RepositoryRoot "frontend")
    $buildIdentity = Get-LocalProductBuildIdentity
}
Invoke-ResolvedLocalProductConfiguration `
    -BuildId ([string]$buildIdentity.buildId) | Out-Null

$env:GROWTHOS_LIVE001_SECRET_DIR = Join-Path $RuntimeRoot "secrets"
$composeFile = Join-Path $RepositoryRoot `
    "deploy\live\docker-compose.live001.yml"
Invoke-Checked `
    (Get-Command docker.exe).Source `
    @("compose", "-f", $composeFile, "up", "-d") `
    $RepositoryRoot
Wait-ContainerHealthy "growthos-live001-postgres"
Wait-ContainerHealthy "growthos-live001-temporal"

Invoke-LocalProductAlembicUpgrade

$contactMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0038_backlink_contact_enrichment.sql"
$contactMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        "SELECT (to_regclass('backlinks.backlink_contact_enrichment_jobs') IS NULL)::text;"
    ) `
    $RepositoryRoot
if ($contactMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $contactMigrationPath -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $migrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($migrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_CONTACT_MIGRATION_FAILED:$migrationExitCode"
    }
}

$opportunityContactMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0039_backlink_opportunity_contact_gate.sql"
$opportunityContactMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT ((
  SELECT count(*)
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_opportunities'
     AND column_name IN (
       'source_contact_candidate_id',
       'contact_review_required'
     )
) <> 2)::text;
"@
    ) `
    $RepositoryRoot
if ($opportunityContactMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $opportunityContactMigrationPath -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $opportunityContactMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($opportunityContactMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_OPPORTUNITY_CONTACT_MIGRATION_FAILED:$opportunityContactMigrationExitCode"
    }
}

$existingPlacementMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0040_backlink_existing_placements.sql"
$existingPlacementMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name IN (
         'backlink_placement_validation_runs',
         'backlink_placements'
       )
       AND column_name='opportunity_id'
       AND is_nullable='YES'
  ) <> 2
  OR NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_placement_validation_runs'::regclass
       AND conname=
         'backlink_placement_validation_candidate_identity_fk'
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($existingPlacementMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $existingPlacementMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $existingPlacementMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($existingPlacementMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_EXISTING_PLACEMENT_MIGRATION_FAILED:$existingPlacementMigrationExitCode"
    }
}

$gmailProjectBindingMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0041_backlink_gmail_project_bindings.sql"
$gmailProjectBindingMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (NOT EXISTS (
  SELECT 1
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_gmail_workspace_bindings'
     AND column_name='website_project_id'
))::text;
"@
    ) `
    $RepositoryRoot
if ($gmailProjectBindingMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $gmailProjectBindingMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $gmailProjectBindingMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($gmailProjectBindingMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_GMAIL_PROJECT_BINDING_MIGRATION_FAILED:$gmailProjectBindingMigrationExitCode"
    }
}

$projectRecommendationContextMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0042_backlink_project_recommendation_context.sql"
$projectRecommendationContextMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT ((
  SELECT count(*)
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_project_context_snapshots'
     AND column_name IN ('products','keywords','target_urls')
     AND data_type='jsonb'
     AND is_nullable='NO'
) <> 3)::text;
"@
    ) `
    $RepositoryRoot
if ($projectRecommendationContextMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $projectRecommendationContextMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $projectRecommendationContextMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($projectRecommendationContextMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_PROJECT_RECOMMENDATION_CONTEXT_MIGRATION_FAILED:$projectRecommendationContextMigrationExitCode"
    }
}

$projectScopeProviderMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0043_backlink_project_scope_provider.sql"
$projectScopeProviderMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regprocedure(
    'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'
  ) IS NULL
)::text;
"@
    ) `
    $RepositoryRoot
if ($projectScopeProviderMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $projectScopeProviderMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $projectScopeProviderMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($projectScopeProviderMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_PROJECT_SCOPE_PROVIDER_MIGRATION_FAILED:$projectScopeProviderMigrationExitCode"
    }
}

$platformProjectAuthorityMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0044_backlink_platform_project_authority.sql"
$platformProjectAuthorityMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regprocedure(
    'platform.backlink_list_active_website_projects(text,text)'
  ) IS NULL
  OR position(
    'platform.backlink_list_active_website_projects' IN
    pg_get_functiondef(
      'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'::regprocedure
    )
  ) = 0
)::text;
"@
    ) `
    $RepositoryRoot
if ($platformProjectAuthorityMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $platformProjectAuthorityMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $platformProjectAuthorityMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($platformProjectAuthorityMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_PLATFORM_PROJECT_AUTHORITY_MIGRATION_FAILED:$platformProjectAuthorityMigrationExitCode"
    }
}

$commercialCandidateInventoryMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0045_backlink_commercial_candidate_inventory.sql"
$commercialCandidateInventoryMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        "SELECT (to_regclass('backlinks.backlink_commercial_discovery_blueprints') IS NULL)::text;"
    ) `
    $RepositoryRoot
if ($commercialCandidateInventoryMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $commercialCandidateInventoryMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $commercialCandidateInventoryMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($commercialCandidateInventoryMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_COMMERCIAL_CANDIDATE_INVENTORY_MIGRATION_FAILED:$commercialCandidateInventoryMigrationExitCode"
    }
}

$contactPublicationGateMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0046_backlink_contact_publication_gate.sql"
$contactPublicationGateMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass('backlinks.backlink_contact_enrichment_batches') IS NULL
  OR to_regclass('backlinks.backlink_contact_evidence_snapshots') IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_recommendation_inventory'
       AND column_name='contact_evidence_snapshot_id'
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($contactPublicationGateMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $contactPublicationGateMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $contactPublicationGateMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($contactPublicationGateMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_CONTACT_PUBLICATION_GATE_MIGRATION_FAILED:$contactPublicationGateMigrationExitCode"
    }
}

$gmailOrganizationReuseMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0047_backlink_gmail_organization_reuse.sql"
$gmailOrganizationReuseMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass(
    'backlinks.backlink_website_project_mailbox_bindings'
  ) IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_gmail_workspace_bindings'
       AND column_name='website_project_id'
       AND is_nullable='YES'
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($gmailOrganizationReuseMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $gmailOrganizationReuseMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $gmailOrganizationReuseMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($gmailOrganizationReuseMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_GMAIL_ORGANIZATION_REUSE_MIGRATION_FAILED:$gmailOrganizationReuseMigrationExitCode"
    }
}

$draftRequestSnapshotMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0048_backlink_draft_request_snapshots.sql"
$draftRequestSnapshotMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass('backlinks.backlink_draft_request_snapshots') IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_evidence_snapshots'
       AND column_name='context_data'
  )
  OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_model_runs'
       AND column_name='request_snapshot_id'
  )
  OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_draft_versions'
       AND column_name='request_snapshot_id'
  )
  OR NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
     WHERE n.nspname='backlinks'
       AND r.relname='backlink_model_runs'
       AND c.conname='backlink_model_run_status_check'
       AND position('RETRY_SCHEDULED' IN pg_get_constraintdef(c.oid)) > 0
  )
  OR NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
     WHERE n.nspname='backlinks'
       AND r.relname='backlink_draft_versions'
       AND c.conname='backlink_draft_version_source_check'
       AND position('TEMPLATE_FALLBACK' IN pg_get_constraintdef(c.oid)) > 0
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($draftRequestSnapshotMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $draftRequestSnapshotMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $draftRequestSnapshotMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($draftRequestSnapshotMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_DRAFT_REQUEST_SNAPSHOT_MIGRATION_FAILED:$draftRequestSnapshotMigrationExitCode"
    }
}

$gmailSendReplyLoopMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0049_backlink_gmail_send_reply_loop.sql"
$gmailSendReplyLoopMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass(
    'backlinks.backlink_gmail_connection_sync_cursors'
  ) IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_send_snapshots'
       AND column_name='approval_fact_id'
  )
  OR NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_send_snapshots'::regclass
       AND conname='backlink_send_snapshot_approval_fact_fk'
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($gmailSendReplyLoopMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $gmailSendReplyLoopMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $gmailSendReplyLoopMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($gmailSendReplyLoopMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_GMAIL_SEND_REPLY_LOOP_MIGRATION_FAILED:$gmailSendReplyLoopMigrationExitCode"
    }
}

$backlinkProfileInventoryMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0050_backlink_profile_inventory.sql"
$backlinkProfileInventoryMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass('backlinks.backlink_profile_sync_jobs') IS NULL
  OR to_regclass('backlinks.backlink_profile_snapshots') IS NULL
  OR to_regclass('backlinks.backlink_inventory_items') IS NULL
  OR to_regclass('backlinks.backlink_profile_health_snapshots') IS NULL
  OR to_regclass('backlinks.backlink_profile_sync_cursors') IS NULL
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkProfileInventoryMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $backlinkProfileInventoryMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkProfileInventoryMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkProfileInventoryMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_BACKLINK_PROFILE_INVENTORY_MIGRATION_FAILED:$backlinkProfileInventoryMigrationExitCode"
    }
}

$backlinkInventoryMonitoringMigrationPath = Join-Path $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0051_backlink_inventory_monitoring.sql"
$backlinkInventoryMonitoringMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass('backlinks.backlink_inventory_monitor_policies') IS NULL
  OR to_regclass('backlinks.backlink_inventory_monitor_runs') IS NULL
  OR to_regclass('backlinks.backlink_inventory_monitor_observations') IS NULL
  OR to_regclass('backlinks.backlink_inventory_monitor_requests') IS NULL
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkInventoryMonitoringMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content -LiteralPath $backlinkInventoryMonitoringMigrationPath `
            -Raw -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkInventoryMonitoringMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkInventoryMonitoringMigrationExitCode -ne 0) {
        throw "LOCAL_PRODUCT_BACKLINK_INVENTORY_MONITORING_MIGRATION_FAILED:$backlinkInventoryMonitoringMigrationExitCode"
    }
}

$backlinkRecommendationPublicationDefaultMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0052_backlink_recommendation_publication_default.sql"
$backlinkRecommendationPublicationDefaultMigrationRequired = `
    Invoke-CheckedCapture `
        (Get-Command docker.exe).Source `
        @(
            "exec",
            "growthos-live001-postgres",
            "psql",
            "-U",
            "postgres",
            "-d",
            "growthos_live001",
            "-Atqc",
            @"
SELECT (
  SELECT column_default <> '''CONTACT_PENDING''::text'
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_recommendation_inventory'
     AND column_name='publication_status'
)::text;
"@
        ) `
        $RepositoryRoot
if (
    $backlinkRecommendationPublicationDefaultMigrationRequired.Trim() `
        -eq "true"
) {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath `
                $backlinkRecommendationPublicationDefaultMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkRecommendationPublicationDefaultMigrationExitCode = `
            $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if (
        $backlinkRecommendationPublicationDefaultMigrationExitCode -ne 0
    ) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_RECOMMENDATION_PUBLICATION_DEFAULT_MIGRATION_FAILED:$backlinkRecommendationPublicationDefaultMigrationExitCode"
    }
}

$backlinkMonitoringContinuityMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0053_backlink_monitoring_continuity.sql"
$backlinkMonitoringContinuityMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  position(
    'provider_inventory_requires_pin_or_management' IN pg_get_functiondef(
      'backlinks.backlink_apply_inventory_monitor_policy()'::regprocedure
    )
  ) = 0
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkMonitoringContinuityMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkMonitoringContinuityMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkMonitoringContinuityMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkMonitoringContinuityMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_MONITORING_CONTINUITY_MIGRATION_FAILED:$backlinkMonitoringContinuityMigrationExitCode"
    }
}

$backlinkRecommendationFitContactMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0054_backlink_recommendation_fit_contact_contract.sql"
$backlinkRecommendationFitContactMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_recommendation_inventory'
       AND column_name='fit_decision'
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkRecommendationFitContactMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkRecommendationFitContactMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkRecommendationFitContactMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkRecommendationFitContactMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_RECOMMENDATION_FIT_CONTACT_MIGRATION_FAILED:$backlinkRecommendationFitContactMigrationExitCode"
    }
}

$backlinkPublishableRefillCycleMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0055_backlink_publishable_refill_cycle.sql"
$backlinkPublishableRefillCycleMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_commercial_inventory_policies'
       AND column_name='refill_state'
  )
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkPublishableRefillCycleMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkPublishableRefillCycleMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkPublishableRefillCycleMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkPublishableRefillCycleMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_PUBLISHABLE_REFILL_CYCLE_MIGRATION_FAILED:$backlinkPublishableRefillCycleMigrationExitCode"
    }
}

$backlinkGmailAffectedProjectCountMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0056_backlink_gmail_affected_project_count.sql"
$backlinkGmailAffectedProjectCountMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regprocedure(
    'backlinks.backlink_count_selected_gmail_projects(uuid,uuid)'
  ) IS NULL
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkGmailAffectedProjectCountMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkGmailAffectedProjectCountMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkGmailAffectedProjectCountMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkGmailAffectedProjectCountMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_GMAIL_AFFECTED_PROJECT_COUNT_MIGRATION_FAILED:$backlinkGmailAffectedProjectCountMigrationExitCode"
    }
}

$backlinkResourceLibraryMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0057_backlink_resource_library.sql"
$backlinkResourceLibraryMigrationRequired = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  to_regclass('backlinks.backlink_resource_library_items') IS NULL
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkResourceLibraryMigrationRequired.Trim() -eq "true") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkResourceLibraryMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkResourceLibraryMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkResourceLibraryMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_RESOURCE_LIBRARY_MIGRATION_FAILED:$backlinkResourceLibraryMigrationExitCode"
    }
}

$backlinkReassessmentCursorMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0058_backlink_refill_reassessment_cursors.sql"
$backlinkReassessmentCursorMigrationState = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  SELECT count(*)
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_commercial_inventory_policies'
     AND column_name IN (
       'paid_refill_tier','paid_refill_round',
       'resource_refill_tier','resource_refill_round'
     )
)::text || ':' || (
  SELECT count(*)
    FROM pg_constraint
   WHERE conrelid=
     'backlinks.backlink_commercial_inventory_policies'::regclass
     AND conname IN (
       'backlink_commercial_paid_refill_cursor_check',
       'backlink_commercial_resource_refill_cursor_check'
     )
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkReassessmentCursorMigrationState.Trim() -eq "0:0") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkReassessmentCursorMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkReassessmentCursorMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkReassessmentCursorMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_REASSESSMENT_CURSOR_MIGRATION_FAILED:$backlinkReassessmentCursorMigrationExitCode"
    }
}
elseif ($backlinkReassessmentCursorMigrationState.Trim() -ne "4:2") {
    throw "LOCAL_PRODUCT_BACKLINK_REASSESSMENT_CURSOR_MIGRATION_PARTIAL"
}

$backlinkVisiblePoolMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0059_backlink_recommendation_pool_generations.sql"
$backlinkVisiblePoolMigrationState = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  SELECT count(*)
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND (
       (
         table_name='backlink_commercial_inventory_policies'
         AND column_name IN (
           'visible_pool_generation','visible_pool_state',
           'visible_pool_target_count','archived_visible_pool_count',
           'visible_pool_archived_at','visible_pool_archived_by'
         )
       )
       OR (
         table_name IN (
           'backlink_recommendation_inventory',
           'backlink_recommendation_refills',
           'backlink_commercial_discovery_batches',
           'backlink_commercial_candidates'
         )
         AND column_name='visible_pool_generation'
       )
     )
)::text || ':' || (
  SELECT count(*)
    FROM pg_constraint
   WHERE conname IN (
     'backlink_commercial_visible_pool_generation_check',
     'backlink_commercial_visible_pool_state_check',
     'backlink_commercial_visible_pool_target_check',
     'backlink_rec_inventory_pool_generation_check',
     'backlink_rec_refill_pool_generation_check',
     'backlink_commercial_batch_pool_generation_check',
     'backlink_commercial_candidate_pool_generation_check'
   )
)::text;
"@
    ) `
    $RepositoryRoot
if ($backlinkVisiblePoolMigrationState.Trim() -eq "0:0") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkVisiblePoolMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkVisiblePoolMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkVisiblePoolMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_VISIBLE_POOL_MIGRATION_FAILED:$backlinkVisiblePoolMigrationExitCode"
    }
}
elseif ($backlinkVisiblePoolMigrationState.Trim() -ne "10:7") {
    throw "LOCAL_PRODUCT_BACKLINK_VISIBLE_POOL_MIGRATION_PARTIAL"
}

$backlinkExactTenMigrationPath = Join-Path `
    $RepositoryRoot `
    "backend\core\src\modules\backlinks\db\migrations\0060_backlink_v3_exact_ten_project_context.sql"
$backlinkExactTenMigrationState = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        @"
SELECT (
  SELECT count(*)
    FROM information_schema.columns
   WHERE table_schema='backlinks'
     AND table_name='backlink_project_context_snapshots'
     AND column_name IN (
       'target_market','target_audiences','partnership_goals'
     )
)::text || ':' || (
  SELECT (
    position('10' IN pg_get_constraintdef(oid)) > 0
    AND position('20' IN pg_get_constraintdef(oid)) = 0
  )::text
    FROM pg_constraint
   WHERE conrelid=
     'backlinks.backlink_commercial_inventory_policies'::regclass
     AND conname='backlink_commercial_visible_pool_target_check'
);
"@
    ) `
    $RepositoryRoot
if ($backlinkExactTenMigrationState.Trim() -eq "0:false") {
    Push-Location $RepositoryRoot
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        Get-Content `
            -LiteralPath $backlinkExactTenMigrationPath `
            -Raw `
            -Encoding UTF8 |
            & (Get-Command docker.exe).Source exec -i `
                growthos-live001-postgres psql -X -v ON_ERROR_STOP=1 `
                -U postgres -d growthos_live001 2>&1 |
            ForEach-Object { Write-Host ([string]$_) }
        $backlinkExactTenMigrationExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Pop-Location
    }
    if ($backlinkExactTenMigrationExitCode -ne 0) {
        throw `
            "LOCAL_PRODUCT_BACKLINK_EXACT_TEN_MIGRATION_FAILED:$backlinkExactTenMigrationExitCode"
    }
}
elseif ($backlinkExactTenMigrationState.Trim() -ne "3:true") {
    throw "LOCAL_PRODUCT_BACKLINK_EXACT_TEN_MIGRATION_PARTIAL"
}

$migrationManifest = Get-Content `
    -LiteralPath (Join-Path $RepositoryRoot `
        "backend\database\deployment-manifest.v1.json") `
    -Raw `
    -Encoding UTF8 |
    ConvertFrom-Json
$expectedAlembic = [string]$migrationManifest.heads.alembic
$expectedBacklinks = [string]$migrationManifest.heads.backlinks
if ($expectedBacklinks -ne "0060") {
    throw "LOCAL_PRODUCT_BACKLINKS_MIGRATION_HEAD_UNSUPPORTED"
}
$databaseSql = @"
SELECT (
  current_setting('server_version_num')::integer >= 180000
  AND (SELECT version_num='$expectedAlembic' FROM alembic_version LIMIT 1)
  AND to_regclass('backlinks.backlink_send_snapshots') IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_commercial_inventory_policies'
       AND column_name='refill_state'
  )
  AND to_regprocedure(
    'backlinks.backlink_count_selected_gmail_projects(uuid,uuid)'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_resource_library_items'
  ) IS NOT NULL
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_commercial_inventory_policies'
       AND column_name IN (
         'paid_refill_tier','paid_refill_round',
         'resource_refill_tier','resource_refill_round'
       )
  ) = 4
  AND (
    SELECT count(*)
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_commercial_inventory_policies'::regclass
       AND conname IN (
         'backlink_commercial_paid_refill_cursor_check',
         'backlink_commercial_resource_refill_cursor_check'
       )
  ) = 2
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND (
         (
           table_name='backlink_commercial_inventory_policies'
           AND column_name IN (
             'visible_pool_generation','visible_pool_state',
             'visible_pool_target_count','archived_visible_pool_count',
             'visible_pool_archived_at','visible_pool_archived_by'
           )
         )
         OR (
           table_name IN (
             'backlink_recommendation_inventory',
             'backlink_recommendation_refills',
             'backlink_commercial_discovery_batches',
             'backlink_commercial_candidates'
           )
           AND column_name='visible_pool_generation'
         )
       )
  ) = 10
  AND (
    SELECT count(*)
      FROM pg_constraint
     WHERE conname IN (
       'backlink_commercial_visible_pool_generation_check',
       'backlink_commercial_visible_pool_state_check',
       'backlink_commercial_visible_pool_target_check',
       'backlink_rec_inventory_pool_generation_check',
       'backlink_rec_refill_pool_generation_check',
       'backlink_commercial_batch_pool_generation_check',
       'backlink_commercial_candidate_pool_generation_check'
     )
  ) = 7
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_project_context_snapshots'
       AND column_name IN (
         'target_market','target_audiences','partnership_goals'
       )
  ) = 3
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_commercial_inventory_policies'::regclass
       AND conname='backlink_commercial_visible_pool_target_check'
       AND position('10' IN pg_get_constraintdef(oid)) > 0
       AND position('20' IN pg_get_constraintdef(oid)) = 0
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid='backlinks.backlink_resource_library_items'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname='backlinks'
       AND tablename='backlink_resource_library_items'
       AND policyname='backlink_resource_library_tenant_policy'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_commercial_inventory_policies'::regclass
       AND conname='backlink_commercial_refill_tier_check'
       AND position(
         'curated_resource_library' IN pg_get_constraintdef(oid)
       ) > 0
  )
  AND position(
    'provider_inventory_requires_pin_or_management' IN pg_get_functiondef(
      'backlinks.backlink_apply_inventory_monitor_policy()'::regprocedure
    )
  ) > 0
  AND position(
    'GREATEST(' IN pg_get_functiondef(
      'backlinks.backlink_allocate_opportunity_join_sequence(uuid,uuid,uuid,text)'::regprocedure
    )
  ) > 0
  AND position(
    'backlink_opportunities' IN pg_get_functiondef(
      'backlinks.backlink_allocate_opportunity_join_sequence(uuid,uuid,uuid,text)'::regprocedure
    )
  ) > 0
  AND EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname='backlink_send_snapshot_immutable'
       AND NOT tgisinternal
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid='backlinks.backlink_send_snapshots'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname='backlinks'
       AND tablename='provider_batch_requests'
       AND policyname='provider_batch_request_worker_policy'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname='backlinks'
       AND tablename='provider_fetch_leases'
       AND policyname='provider_fetch_lease_worker_policy'
  )
  AND to_regclass('backlinks.backlink_contact_enrichment_jobs') IS NOT NULL
  AND to_regclass('backlinks.backlink_contact_enrichment_pages') IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_contact_evidence'
       AND column_name='rule_version'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_opportunities'
       AND column_name='source_contact_candidate_id'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_opportunities'
       AND column_name='contact_review_required'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_opportunities'::regclass
       AND conname='backlink_opportunity_source_contact_candidate_fk'
  )
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name IN (
         'backlink_placement_validation_runs',
         'backlink_placements'
       )
       AND column_name='opportunity_id'
       AND is_nullable='YES'
  ) = 2
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_placement_validation_runs'::regclass
       AND conname=
         'backlink_placement_validation_candidate_identity_fk'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_gmail_workspace_bindings'
       AND column_name='website_project_id'
       AND is_nullable='YES'
  )
  AND to_regclass(
    'backlinks.backlink_website_project_mailbox_bindings'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid=
       'backlinks.backlink_website_project_mailbox_bindings'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_project_context_snapshots'
       AND column_name IN ('products','keywords','target_urls')
       AND data_type='jsonb'
       AND is_nullable='NO'
  ) = 3
  AND to_regprocedure(
    'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'
  ) IS NOT NULL
  AND to_regprocedure(
    'platform.backlink_list_active_website_projects(text,text)'
  ) IS NOT NULL
  AND position(
    'platform.backlink_list_active_website_projects' IN
    pg_get_functiondef(
      'backlinks.backlink_list_active_project_scopes(uuid,uuid,uuid,integer)'::regprocedure
    )
  ) > 0
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_contact_enrichment_jobs'::regclass
       AND conname='backlink_contact_enrichment_job_status_check'
       AND position('stale_context' IN pg_get_constraintdef(oid)) > 0
  )
  AND to_regclass(
    'backlinks.backlink_commercial_discovery_blueprints'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_commercial_discovery_batches'
  ) IS NOT NULL
  AND to_regclass('backlinks.backlink_commercial_candidates') IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_commercial_discovery_artifacts'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_commercial_inventory_policies'
  ) IS NOT NULL
  AND to_regclass('backlinks.backlink_commercial_gold_sets') IS NOT NULL
  AND to_regclass('backlinks.backlink_commercial_gold_labels') IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid='backlinks.backlink_commercial_candidates'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND to_regclass(
    'backlinks.backlink_contact_enrichment_batches'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_contact_evidence_snapshots'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_contact_enrichment_jobs'
       AND column_name='terminal_reason_code'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_recommendation_inventory'
       AND column_name='contact_evidence_snapshot_id'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_recommendation_inventory'::regclass
       AND conname='backlink_rec_inventory_publication_gate_check'
       AND position(
         'fit_decision = ''eligible''::text' IN pg_get_constraintdef(oid)
       ) > 0
       AND position(
         'contact_decision = ''eligible''::text' IN pg_get_constraintdef(oid)
       ) > 0
  )
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_recommendation_inventory'
       AND column_name IN (
         'fit_decision',
         'contact_decision',
         'contact_reason_code',
         'fit_score_model_version'
       )
  ) = 4
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid=
       'backlinks.backlink_commercial_candidates'::regclass
       AND conname=
         'backlink_commercial_candidate_context_domain_model_uq'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid=
       'backlinks.backlink_contact_evidence_snapshots'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND to_regclass(
    'backlinks.backlink_draft_request_snapshots'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class r ON r.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace
     WHERE n.nspname='backlinks'
       AND r.relname='backlink_draft_request_snapshots'
       AND t.tgname='backlink_draft_request_snapshot_immutable'
       AND NOT t.tgisinternal
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid='backlinks.backlink_draft_request_snapshots'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_evidence_snapshots'
       AND column_name='context_data'
       AND data_type='jsonb'
       AND is_nullable='NO'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_model_runs'
       AND column_name='request_snapshot_id'
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_draft_versions'
       AND column_name='request_snapshot_id'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_model_runs'::regclass
       AND conname='backlink_model_run_status_check'
       AND position('RETRY_SCHEDULED' IN pg_get_constraintdef(oid)) > 0
  )
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_draft_versions'::regclass
       AND conname='backlink_draft_version_source_check'
       AND position('TEMPLATE_FALLBACK' IN pg_get_constraintdef(oid)) > 0
  )
  AND to_regclass(
    'backlinks.backlink_gmail_connection_sync_cursors'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid=
       'backlinks.backlink_gmail_connection_sync_cursors'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND (
    SELECT count(*)
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_send_snapshots'
       AND column_name IN (
         'approval_fact_id',
         'approval_actor_id',
         'approval_recorded_at'
       )
  ) = 3
  AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='backlinks.backlink_send_snapshots'::regclass
       AND conname='backlink_send_snapshot_approval_fact_fk'
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid='backlinks.backlink_inventory_items'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND to_regclass(
    'backlinks.backlink_inventory_monitor_policies'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_inventory_monitor_runs'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_inventory_monitor_observations'
  ) IS NOT NULL
  AND to_regclass(
    'backlinks.backlink_inventory_monitor_requests'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid='backlinks.backlink_inventory_monitor_policies'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
  )
  AND EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema='backlinks'
       AND table_name='backlink_profile_snapshots'
       AND column_name='inventory_coverage'
  )
)::text;
"@
$databaseCheck = Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        $databaseSql
    ) `
    $RepositoryRoot
if ($databaseCheck.Trim() -ne "true") {
    throw "LOCAL_PRODUCT_DATABASE_MIGRATION_CHECK_FAILED"
}

$identity = Get-Content (Join-Path $RuntimeRoot "identity.json") `
    -Raw -Encoding UTF8 | ConvertFrom-Json
$organizationId = [guid]$identity.organizationId
$workspaceId = [guid]$identity.workspaceId
$websiteProjectId = [guid]$identity.websiteProjectId
$actorId = ([string]$identity.userId).Replace("'", "''")

$governanceBootstrapSql = @"
WITH latest_project AS (
  SELECT DISTINCT ON (website_project_id)
         website_project_id,project_status
    FROM backlinks.backlink_project_context_snapshots
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
   ORDER BY website_project_id,snapshot_version DESC
),
active_projects AS (
  SELECT website_project_id
    FROM latest_project
   WHERE project_status='ACTIVE'
)
INSERT INTO backlinks.backlink_project_settings_versions (
  id,organization_id,workspace_id,website_project_id,
  version,settings_values,created_by
)
SELECT gen_random_uuid(),'$organizationId'::uuid,'$workspaceId'::uuid,
       active.website_project_id,1,
       jsonb_build_object(
         'reportingTimezone','Asia/Shanghai',
         'reportLookbackDays',30,
         'exportExpiryHours',24
       ),
       '$actorId'
  FROM active_projects active
 WHERE NOT EXISTS (
   SELECT 1
     FROM backlinks.backlink_project_settings_versions
    WHERE organization_id='$organizationId'::uuid
      AND workspace_id='$workspaceId'::uuid
      AND website_project_id=active.website_project_id
 )
ON CONFLICT DO NOTHING;

WITH latest_project AS (
  SELECT DISTINCT ON (website_project_id)
         website_project_id,project_status
    FROM backlinks.backlink_project_context_snapshots
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
   ORDER BY website_project_id,snapshot_version DESC
),
active_projects AS (
  SELECT website_project_id
    FROM latest_project
   WHERE project_status='ACTIVE'
)
INSERT INTO backlinks.backlink_retention_policy_versions (
  id,organization_id,workspace_id,website_project_id,
  version,rules,exceptions,created_by
)
SELECT gen_random_uuid(),'$organizationId'::uuid,'$workspaceId'::uuid,
       active.website_project_id,1,
       jsonb_build_array(
         jsonb_build_object(
           'category','operational',
           'retainForDays',30
         )
       ),
       jsonb_build_array(
         'audit_record',
         'lifecycle_record',
         'active_suppression'
       ),
       '$actorId'
  FROM active_projects active
 WHERE NOT EXISTS (
   SELECT 1
     FROM backlinks.backlink_retention_policy_versions
    WHERE organization_id='$organizationId'::uuid
      AND workspace_id='$workspaceId'::uuid
      AND website_project_id=active.website_project_id
 )
ON CONFLICT DO NOTHING;
"@
Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        $governanceBootstrapSql
    ) `
    $RepositoryRoot | Out-Null

$contactReconciliationSql = @"
WITH eligible AS (
  SELECT o.id opportunity_id,c.*
    FROM backlinks.backlink_opportunities o
    JOIN backlinks.backlink_contact_candidates c ON
      (c.organization_id,c.workspace_id,c.website_project_id,c.id)=
      (o.organization_id,o.workspace_id,o.website_project_id,
       o.source_contact_candidate_id)
   WHERE (o.organization_id,o.workspace_id,o.website_project_id)=
         ('$organizationId'::uuid,'$workspaceId'::uuid,'$websiteProjectId'::uuid)
     AND o.contact_review_required=false
     AND c.status IN ('candidate','promoted')
     AND c.guessed=false
     AND c.invalidated_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM backlinks.backlink_contact_evidence e
        WHERE (e.organization_id,e.workspace_id,e.website_project_id,
               e.candidate_id)=
              (c.organization_id,c.workspace_id,c.website_project_id,c.id)
          AND e.invalidated_at IS NULL
          AND e.expires_at>now()
     )
),
promoted AS (
  UPDATE backlinks.backlink_contact_candidates c
     SET status='promoted',version=c.version+1,updated_at=now(),
         updated_by='$actorId'
    FROM eligible e
   WHERE c.id=e.id AND c.status='candidate'
  RETURNING c.id
)
INSERT INTO backlinks.backlink_contacts (
  id,organization_id,workspace_id,website_project_id,prospect_id,
  recommendation_context_version_id,source_candidate_id,normalized_email,
  contact_role,confidence,guessed,observed_role,inferred_purpose,
  purpose_confidence,purpose_rule_version,purpose_evidence,
  confirmed_at,confirmed_by,status,created_by,updated_by
)
SELECT gen_random_uuid(),e.organization_id,e.workspace_id,e.website_project_id,
       e.prospect_id,e.recommendation_context_version_id,e.id,
       e.normalized_email,e.inferred_purpose,e.confidence,false,e.observed_role,
       e.inferred_purpose,e.purpose_confidence,e.purpose_rule_version,
       e.purpose_evidence,now(),'$actorId','active','$actorId','$actorId'
  FROM eligible e
  LEFT JOIN promoted p ON p.id=e.id
ON CONFLICT DO NOTHING;
"@
Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-postgres",
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "growthos_live001",
        "-Atqc",
        $contactReconciliationSql
    ) `
    $RepositoryRoot | Out-Null

$enabledKillSwitches = @()
if ($EnableAi) {
    $enabledKillSwitches += [pscustomobject]@{
        layer = "project"
        capability = "AI_PROVIDER"
        provider = $null
        reason = "LOCAL_PRODUCT explicit EnableAi startup"
    }
}
if ($EnableGmailSend) {
    $enabledKillSwitches += [pscustomobject]@{
        layer = "project"
        capability = "GMAIL_SEND"
        provider = $null
        reason = "LOCAL_PRODUCT explicit EnableGmailSend startup"
    }
}
if ($EnableGmailSync) {
    $enabledKillSwitches += [pscustomobject]@{
        layer = "project"
        capability = "GMAIL_SYNC"
        provider = $null
        reason = "LOCAL_PRODUCT explicit EnableGmailSync startup"
    }
}
if ($EnableDataForSeo) {
    $enabledKillSwitches += [pscustomobject]@{
        layer = "project"
        capability = "backlinks.dataforseo.v1"
        provider = $null
        reason = "LOCAL_PRODUCT explicit EnableDataForSeo startup"
    }
    $enabledKillSwitches += [pscustomobject]@{
        layer = "provider"
        capability = "backlinks.dataforseo.v1"
        provider = "dataforseo"
        reason = "LOCAL_PRODUCT explicit EnableDataForSeo startup"
    }
}
if ($EnableBrowser) {
    $enabledKillSwitches += [pscustomobject]@{
        layer = "project"
        capability = "backlinks.browser.v1"
        provider = $null
        reason = "LOCAL_PRODUCT explicit EnableBrowser startup"
    }
}
if ($enabledKillSwitches.Count -gt 0) {
    foreach ($switch in $enabledKillSwitches) {
        $layer = ([string]$switch.layer).Replace("'", "''")
        $capability = ([string]$switch.capability).Replace("'", "''")
        $provider = if ($null -eq $switch.provider) {
            $null
        }
        else {
            ([string]$switch.provider).Replace("'", "''")
        }
        $providerPredicate = if ($null -eq $provider) {
            "provider IS NULL"
        }
        else {
            "provider='$provider'"
        }
        $providerSql = if ($null -eq $provider) {
            "NULL"
        }
        else {
            "'$provider'"
        }
        $reason = ([string]$switch.reason).Replace("'", "''")
        $switchSql = @"
WITH latest_project AS (
  SELECT DISTINCT ON (website_project_id)
         website_project_id,project_status
    FROM backlinks.backlink_project_context_snapshots
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
   ORDER BY website_project_id,snapshot_version DESC
),
active_project AS (
  SELECT website_project_id
    FROM latest_project
   WHERE website_project_id='$websiteProjectId'::uuid
     AND project_status='ACTIVE'
),
current AS (
  SELECT DISTINCT ON (website_project_id)
         website_project_id,version,blocked
    FROM backlinks.backlink_kill_switch_versions
   WHERE organization_id='$organizationId'::uuid
     AND workspace_id='$workspaceId'::uuid
     AND layer='$layer'
     AND capability='$capability'
     AND $providerPredicate
   ORDER BY website_project_id,version DESC
)
INSERT INTO backlinks.backlink_kill_switch_versions (
  id,organization_id,workspace_id,website_project_id,
  layer,capability,provider,version,blocked,reason,created_by
)
SELECT gen_random_uuid(),'$organizationId'::uuid,'$workspaceId'::uuid,
       active.website_project_id,'$layer','$capability',$providerSql,
       COALESCE(current.version,0)+1,false,
       '$reason','$actorId'
  FROM active_project active
  LEFT JOIN current
    ON current.website_project_id=active.website_project_id
 WHERE COALESCE(current.blocked,true) IS DISTINCT FROM false;
"@
        Invoke-CheckedCapture `
            (Get-Command docker.exe).Source `
            @(
                "exec",
                "growthos-live001-postgres",
                "psql",
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                "growthos_live001",
                "-Atqc",
                $switchSql
            ) `
            $RepositoryRoot | Out-Null
    }
}

Invoke-CheckedCapture `
    (Get-Command docker.exe).Source `
    @(
        "exec",
        "growthos-live001-temporal",
        "temporal",
        "operator",
        "namespace",
        "describe",
        "--namespace",
        "growthos-backlinks-canary",
        "--address",
        "127.0.0.1:7233",
        "--output",
        "json"
    ) `
    $RepositoryRoot | Out-Null

$logs = Join-Path $RuntimeRoot "logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$powerShell = (Get-Command powershell.exe).Source
$wrapper = Join-Path $PSScriptRoot "Invoke-LocalProductProcess.ps1"
$state = @{
    schemaVersion = "growthos.local-product-processes.v1"
    runId = $runId
    startedAt = (Get-Date -Format o)
    repositoryRoot = $RepositoryRoot
    runtimeRoot = $RuntimeRoot
    runtimeMode = "LOCAL_PRODUCT"
    workerExecutionMode = $WorkerExecutionMode
    businessConsumersRunning = $WorkerExecutionMode -eq "normal"
    projectKey = (
        Get-Content (Join-Path $RuntimeRoot "identity.json") `
            -Raw `
            -Encoding UTF8 |
        ConvertFrom-Json
    ).websiteProjectKey
    aiEnabled = [bool]$EnableAi
    aiMaxCalls = $AiMaxCalls
    gmailSendEnabled = [bool]$EnableGmailSend
    gmailSyncEnabled = [bool]$EnableGmailSync
    gmailRolling24HourSendLimit = $GmailRolling24HourSendLimit
    gmailMinimumIntervalSeconds = $GmailMinimumIntervalSeconds
    gmailPollingIntervalSeconds = $GmailPollingIntervalSeconds
    browserEnabled = [bool]$EnableBrowser
    dataForSeoEnabled = [bool]$EnableDataForSeo
    dataForSeoMaxPaidCalls = $DataForSeoMaxPaidCalls
    buildId = [string]$buildIdentity.buildId
    sourceFingerprint = [string]$buildIdentity.sourceFingerprint
    artifactFingerprint = [string]$buildIdentity.artifactFingerprint
    browserGroupPid = 0
    coreApiGroupPid = 0
    workerGroupPid = 0
    fastApiGroupPid = 0
    frontendGroupPid = 0
}

try {
    if ($EnableBrowser) {
        $state.browserGroupPid = Start-Component `
            "browser-worker" $runId $powerShell $wrapper
        Write-State $state $newStatePath
        Wait-HttpReady "http://127.0.0.1:7401/health" `
            $state.browserGroupPid $null
    }

    $state.coreApiGroupPid = Start-Component `
        "core-api" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-HttpReady "http://127.0.0.1:7301/ready" `
        $state.coreApiGroupPid $state.buildId

    $state.workerGroupPid = Start-Component `
        "worker" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-WorkerReady `
        (Join-Path $logs "$runId-worker.stdout.log") `
        $state.workerGroupPid `
        $state.buildId `
        $WorkerExecutionMode

    $state.fastApiGroupPid = Start-Component `
        "fastapi" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-HttpReady "http://127.0.0.1:7200/ready" `
        $state.fastApiGroupPid $null

    if ($EnableGmailSync -and $WorkerExecutionMode -eq "normal") {
        $gmailSyncTargetsSql = @"
SELECT project.project_key || '|' || connection.id::text
  FROM platform.projects project
  JOIN backlinks.backlink_website_project_mailbox_bindings project_binding
    ON project_binding.organization_id=
       NULLIF(project.organization_id,'')::uuid
   AND project_binding.workspace_id=NULLIF(project.workspace_id,'')::uuid
   AND project_binding.website_project_id=project.id::uuid
   AND project_binding.binding_status='ACTIVE'
   AND project_binding.is_selected=true
  JOIN backlinks.backlink_gmail_workspace_bindings workspace_binding
    ON workspace_binding.organization_id=project_binding.organization_id
   AND workspace_binding.workspace_id=project_binding.workspace_id
   AND workspace_binding.id=project_binding.gmail_workspace_binding_id
   AND workspace_binding.binding_status='ACTIVE'
  JOIN backlinks.backlink_gmail_connections connection
    ON connection.organization_id=workspace_binding.organization_id
   AND connection.id=workspace_binding.gmail_connection_id
 WHERE project.status='ACTIVE'
   AND project.organization_id='$organizationId'
   AND project.workspace_id='$workspaceId'
   AND connection.disconnected_at IS NULL
 ORDER BY project.project_key,connection.id;
"@
        $gmailSyncTargetOutput = Invoke-CheckedCapture `
            (Get-Command docker.exe).Source `
            @(
                "exec",
                "growthos-live001-postgres",
                "psql",
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "postgres",
                "-d",
                "growthos_live001",
                "-Atqc",
                $gmailSyncTargetsSql
            ) `
            $RepositoryRoot
        $gmailSyncWorkflows = @()
        $gmailSyncFailures = @()
        foreach (
            $targetLine in $gmailSyncTargetOutput -split (
                [Environment]::NewLine
            )
        ) {
            if ([string]::IsNullOrWhiteSpace($targetLine)) {
                continue
            }
            $target = $targetLine.Split("|", 2)
            if ($target.Length -ne 2) {
                throw "LOCAL_PRODUCT_GMAIL_SYNC_TARGET_INVALID"
            }
            $projectKey = $target[0]
            $connectionId = $target[1]
            try {
                $syncResult = Invoke-RestMethod `
                    -Uri (
                        "http://127.0.0.1:7200/api/v1/projects/" +
                        $projectKey +
                        "/backlinks/gmail-connections/" +
                        $connectionId +
                        "/sync"
                    ) `
                    -Method Post `
                    -Headers @{
                        "x-request-id" = (
                            "local-product-$runId-gmail-sync-" +
                            $projectKey
                        )
                    } `
                    -ContentType "application/json" `
                    -Body "{}" `
                    -TimeoutSec 30
                $gmailSyncWorkflows += [pscustomobject]@{
                    projectKey = $projectKey
                    connectionId = $connectionId
                    workflowId = $syncResult.workflowId
                }
            }
            catch {
                $gmailSyncFailures += [pscustomobject]@{
                    projectKey = $projectKey
                    connectionId = $connectionId
                    category = "PROJECT_GMAIL_SYNC_START_FAILED"
                }
                Write-Warning (
                    "Gmail Sync remains paused for project " +
                    "$projectKey; other project bindings will continue."
                )
            }
        }
        $state.gmailSyncWorkflows = @($gmailSyncWorkflows)
        $state.gmailSyncWorkflowIds = @(
            $gmailSyncWorkflows |
                Select-Object -ExpandProperty workflowId -Unique
        )
        $state.gmailSyncStartFailures = @($gmailSyncFailures)
        if ($state.gmailSyncWorkflowIds.Count -gt 0) {
            $state.gmailSyncWorkflowId = $state.gmailSyncWorkflowIds[0]
        }
        Write-State $state $newStatePath
    }

    $state.frontendGroupPid = Start-Component `
        "frontend" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-HttpAvailable "http://127.0.0.1:5173" `
        $state.frontendGroupPid
}
catch {
    Write-State $state $newStatePath
    try {
        & (Join-Path $PSScriptRoot "Stop-GrowthOS-LocalProduct.ps1") `
            -RuntimeRoot $RuntimeRoot `
            -RepositoryRoot $RepositoryRoot `
            -KeepInfrastructure | Out-Null
    }
    catch {
    }
    throw
}

$finalStatus = $null
$expectedStatus = if ($WorkerExecutionMode -eq "quiesced") {
    "maintenance_ready"
}
else {
    "ok"
}
$readinessDeadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $readinessDeadline) {
    $finalStatus = & (
        Join-Path $PSScriptRoot "Status-GrowthOS-LocalProduct.ps1"
    ) `
        -RuntimeRoot $RuntimeRoot `
        -RepositoryRoot $RepositoryRoot `
        -NoFail
    if ($finalStatus.status -eq $expectedStatus) {
        $finalStatus
        return
    }
    Start-Sleep -Seconds 1
}

if ($WorkerExecutionMode -eq "quiesced") {
    throw "LOCAL_PRODUCT_MAINTENANCE_READINESS_TIMEOUT"
}
throw "LOCAL_PRODUCT_STACK_READINESS_TIMEOUT"
