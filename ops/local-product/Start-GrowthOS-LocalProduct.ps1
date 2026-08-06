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
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Start-GrowthOS-LocalProduct.ps1 requires Windows"
}

if ($EnableGmail) {
    $EnableGmailSend = $true
    $EnableGmailSync = $true
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

function Wait-HttpReady([string]$Uri, [uint32]$GroupPid) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
            throw "Process group $GroupPid exited before $Uri became ready"
        }
        try {
            $response = Invoke-RestMethod -Uri $Uri -TimeoutSec 5
            if ($response.status -eq "ok") {
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
        $statusCode = & curl.exe `
            --silent `
            --show-error `
            --output NUL `
            --write-out "%{http_code}" `
            --max-time 5 `
            --noproxy "*" `
            $Uri 2>$null
        if ($LASTEXITCODE -eq 0 -and $statusCode -eq "200") {
            return
        }
    }
    throw "$Uri did not become available"
}

function Wait-WorkerReady([string]$LogPath, [uint32]$GroupPid) {
    for ($attempt = 0; $attempt -lt 150; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
            throw "Worker process group $GroupPid exited before readiness"
        }
        if (
            (Test-Path -LiteralPath $LogPath) -and
            (Select-String -LiteralPath $LogPath -SimpleMatch `
                '"event":"backlinks.worker.ready"' -Quiet)
        ) {
            return
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
    -GmailPollingIntervalSeconds $GmailPollingIntervalSeconds | Out-Null

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
}

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
     AND is_nullable='NO'
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

$migrationManifest = Get-Content `
    -LiteralPath (Join-Path $RepositoryRoot `
        "backend\database\deployment-manifest.v1.json") `
    -Raw `
    -Encoding UTF8 |
    ConvertFrom-Json
$expectedAlembic = [string]$migrationManifest.heads.alembic
$expectedBacklinks = [string]$migrationManifest.heads.backlinks
if ($expectedBacklinks -ne "0047") {
    throw "LOCAL_PRODUCT_BACKLINKS_MIGRATION_HEAD_UNSUPPORTED"
}
$databaseSql = @"
SELECT (
  current_setting('server_version_num')::integer >= 180000
  AND (SELECT version_num='$expectedAlembic' FROM alembic_version LIMIT 1)
  AND to_regclass('backlinks.backlink_send_snapshots') IS NOT NULL
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
  )
  AND EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid=
       'backlinks.backlink_contact_evidence_snapshots'::regclass
       AND relrowsecurity
       AND relforcerowsecurity
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

if ($EnableGmailSend -or $EnableGmailSync) {
    $requireGmailSend = $(if ($EnableGmailSend) { "true" } else { "false" })
    $requireGmailSync = $(if ($EnableGmailSync) { "true" } else { "false" })
    $gmailBindingSql = @"
WITH usable AS (
  SELECT c.id
    FROM backlinks.backlink_gmail_connections c
    JOIN backlinks.backlink_secret_references r ON
      (r.organization_id,r.id,r.secret_kind)=
      (c.organization_id,c.token_secret_reference_id,'GMAIL_TOKEN_SET')
   WHERE c.organization_id='$organizationId'::uuid
     AND c.connection_status='CONNECTED'
     AND c.send_availability='AVAILABLE'
     AND c.disconnected_at IS NULL
     AND r.status='ACTIVE'
     AND (NOT $requireGmailSend OR c.granted_scopes @>
       jsonb_build_array('https://www.googleapis.com/auth/gmail.send'))
     AND (NOT $requireGmailSync OR c.granted_scopes @>
       jsonb_build_array('https://www.googleapis.com/auth/gmail.readonly'))
   ORDER BY c.updated_at DESC,c.id
   LIMIT 1
),
current_usable AS (
  SELECT b.id
    FROM backlinks.backlink_gmail_workspace_bindings b
    JOIN usable u ON u.id=b.gmail_connection_id
   WHERE b.organization_id='$organizationId'::uuid
     AND b.workspace_id='$workspaceId'::uuid
     AND b.binding_status='ACTIVE'
     AND b.is_primary=true
)
UPDATE backlinks.backlink_gmail_workspace_bindings b
   SET binding_status='INACTIVE',is_primary=false,version=b.version+1,
       updated_at=now(),updated_by='$actorId'
 WHERE b.organization_id='$organizationId'::uuid
   AND b.workspace_id='$workspaceId'::uuid
   AND b.binding_status='ACTIVE'
   AND b.is_primary=true
   AND EXISTS (SELECT 1 FROM usable)
   AND NOT EXISTS (SELECT 1 FROM current_usable);

WITH usable AS (
  SELECT c.id
    FROM backlinks.backlink_gmail_connections c
    JOIN backlinks.backlink_secret_references r ON
      (r.organization_id,r.id,r.secret_kind)=
      (c.organization_id,c.token_secret_reference_id,'GMAIL_TOKEN_SET')
   WHERE c.organization_id='$organizationId'::uuid
     AND c.connection_status='CONNECTED'
     AND c.send_availability='AVAILABLE'
     AND c.disconnected_at IS NULL
     AND r.status='ACTIVE'
     AND (NOT $requireGmailSend OR c.granted_scopes @>
       jsonb_build_array('https://www.googleapis.com/auth/gmail.send'))
     AND (NOT $requireGmailSync OR c.granted_scopes @>
       jsonb_build_array('https://www.googleapis.com/auth/gmail.readonly'))
   ORDER BY c.updated_at DESC,c.id
   LIMIT 1
)
UPDATE backlinks.backlink_gmail_workspace_bindings b
   SET binding_status='ACTIVE',is_primary=true,version=b.version+1,
       updated_at=now(),updated_by='$actorId'
  FROM usable u
 WHERE (b.organization_id,b.workspace_id,b.gmail_connection_id)=
       ('$organizationId'::uuid,'$workspaceId'::uuid,u.id)
   AND (b.binding_status<>'ACTIVE' OR b.is_primary=false)
   AND NOT EXISTS (
     SELECT 1
       FROM backlinks.backlink_gmail_workspace_bindings active
      WHERE active.organization_id='$organizationId'::uuid
        AND active.workspace_id='$workspaceId'::uuid
        AND active.binding_status='ACTIVE'
        AND active.is_primary=true
   );

WITH usable AS (
  SELECT c.id
    FROM backlinks.backlink_gmail_connections c
    JOIN backlinks.backlink_secret_references r ON
      (r.organization_id,r.id,r.secret_kind)=
      (c.organization_id,c.token_secret_reference_id,'GMAIL_TOKEN_SET')
   WHERE c.organization_id='$organizationId'::uuid
     AND c.connection_status='CONNECTED'
     AND c.send_availability='AVAILABLE'
     AND c.disconnected_at IS NULL
     AND r.status='ACTIVE'
     AND (NOT $requireGmailSend OR c.granted_scopes @>
       jsonb_build_array('https://www.googleapis.com/auth/gmail.send'))
     AND (NOT $requireGmailSync OR c.granted_scopes @>
       jsonb_build_array('https://www.googleapis.com/auth/gmail.readonly'))
   ORDER BY c.updated_at DESC,c.id
   LIMIT 1
)
INSERT INTO backlinks.backlink_gmail_workspace_bindings (
  id,organization_id,workspace_id,gmail_connection_id,binding_status,
  is_primary,version,created_by,updated_by
)
SELECT gen_random_uuid(),'$organizationId'::uuid,'$workspaceId'::uuid,u.id,
       'ACTIVE',true,1,'$actorId','$actorId'
  FROM usable u
 WHERE NOT EXISTS (
   SELECT 1
     FROM backlinks.backlink_gmail_workspace_bindings active
    WHERE active.organization_id='$organizationId'::uuid
      AND active.workspace_id='$workspaceId'::uuid
      AND active.binding_status='ACTIVE'
      AND active.is_primary=true
 )
ON CONFLICT (organization_id,workspace_id,gmail_connection_id)
DO UPDATE SET binding_status='ACTIVE',is_primary=true,
  version=backlink_gmail_workspace_bindings.version+1,
  updated_at=now(),updated_by=EXCLUDED.updated_by;
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
            $gmailBindingSql
        ) `
        $RepositoryRoot | Out-Null
}

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
active_projects AS (
  SELECT website_project_id
    FROM latest_project
   WHERE project_status='ACTIVE'
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
  FROM active_projects active
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
            $state.browserGroupPid
    }

    $state.coreApiGroupPid = Start-Component `
        "core-api" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-HttpReady "http://127.0.0.1:7301/ready" `
        $state.coreApiGroupPid

    $state.workerGroupPid = Start-Component `
        "worker" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-WorkerReady `
        (Join-Path $logs "$runId-worker.stdout.log") `
        $state.workerGroupPid

    $state.fastApiGroupPid = Start-Component `
        "fastapi" $runId $powerShell $wrapper
    Write-State $state $newStatePath
    Wait-HttpReady "http://127.0.0.1:7200/ready" `
        $state.fastApiGroupPid

    if ($EnableGmailSync) {
        $connectionStatus = Invoke-RestMethod `
            -Uri (
                "http://127.0.0.1:7200/api/v1/projects/" +
                $state.projectKey +
                "/backlinks/gmail-connections/status"
            ) `
            -Method Get `
            -Headers @{
                "x-request-id" = "local-product-$runId-gmail-status"
            } `
            -TimeoutSec 30
        if ($null -eq $connectionStatus.connection) {
            throw "LOCAL_PRODUCT_GMAIL_SYNC_CONNECTION_MISSING"
        }
        $syncResult = Invoke-RestMethod `
            -Uri (
                "http://127.0.0.1:7200/api/v1/projects/" +
                $state.projectKey +
                "/backlinks/gmail-connections/" +
                $connectionStatus.connection.connectionId +
                "/sync"
            ) `
            -Method Post `
            -Headers @{
                "x-request-id" = "local-product-$runId-gmail-sync"
            } `
            -ContentType "application/json" `
            -Body "{}" `
            -TimeoutSec 30
        $state.gmailSyncWorkflowId = $syncResult.workflowId
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
$readinessDeadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $readinessDeadline) {
    $finalStatus = & (
        Join-Path $PSScriptRoot "Status-GrowthOS-LocalProduct.ps1"
    ) `
        -RuntimeRoot $RuntimeRoot `
        -RepositoryRoot $RepositoryRoot `
        -NoFail
    if ($finalStatus.status -eq "ok") {
        $finalStatus
        return
    }
    Start-Sleep -Seconds 1
}

throw "LOCAL_PRODUCT_STACK_READINESS_TIMEOUT"
