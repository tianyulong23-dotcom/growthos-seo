param(
    [ValidateSet("LIVE-001", "LIVE-003", "LIVE-004")]
    [string]$Stage = "LIVE-001",

    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "GrowthOS\live001"),
    [string]$RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..\..")
    ).Path
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "Start-Live001Canary.ps1 requires Windows"
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class GrowthOsProcessGroup
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

function Assert-ProviderFlags([string]$Path, [string]$ExpectedStage) {
    $values = @{}
    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line.Split("=", 2)
        $values[$parts[0].Trim()] = $parts[1]
    }
    $gmailExpected = if ($ExpectedStage -eq "LIVE-004") {
        "true"
    }
    else {
        "false"
    }
    foreach ($name in @("GMAIL_SEND_ENABLED", "GMAIL_SYNC_ENABLED")) {
        if ($values[$name] -ne $gmailExpected) {
            throw "$name does not match $ExpectedStage in $Path"
        }
    }
    foreach ($name in @(
        "DATAFORSEO_ENABLED",
        "AI_PROVIDER_ENABLED",
        "BROWSER_PROVIDER_ENABLED"
    )) {
        if ($values[$name] -ne "false") {
            throw "$name must remain false in $Path"
        }
    }
    if ($ExpectedStage -eq "LIVE-001") {
        if (
            $values["GOOGLE_OAUTH_ENABLED"] -eq "true" `
            -or $values["PLATFORM_SECRET_STORE_ENABLED"] -eq "true"
        ) {
            throw "LIVE-001 cannot enable Google OAuth or Secret Store in $Path"
        }
    }
    else {
        foreach ($name in @(
            "GOOGLE_OAUTH_ENABLED",
            "PLATFORM_SECRET_STORE_ENABLED"
        )) {
            if ($values[$name] -ne "true") {
                throw "$name must be true for $ExpectedStage in $Path"
            }
        }
        if (
            $values["BACKLINKS_RUNTIME_MODE"] -ne
                "LOCAL_PRODUCT_ACCEPTANCE" `
            -or $values["BACKLINKS_LIVE_CANARY_STAGE"] -ne $ExpectedStage
        ) {
            throw "Local product runtime stage does not match $ExpectedStage in $Path"
        }
    }
}

function Write-State([hashtable]$State, [string]$Path) {
    $State | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
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
        "-Stage",
        $Stage,
        "-RuntimeRoot",
        (Quote-Argument $RuntimeRoot),
        "-RepositoryRoot",
        (Quote-Argument $RepositoryRoot),
        "-LogPrefix",
        (Quote-Argument $logPrefix)
    ) -join " "
    return [GrowthOsProcessGroup]::Start($commandLine, $RepositoryRoot)
}

function Wait-HttpReady([string]$Uri, [uint32]$GroupPid) {
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        Start-Sleep -Seconds 1
        if (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue) {
            try {
                $response = Invoke-RestMethod -Uri $Uri -TimeoutSec 5
                if ($response.status -eq "ok") {
                    return
                }
            }
            catch {
            }
        }
        else {
            throw "Process group $GroupPid exited before $Uri became ready"
        }
    }
    throw "$Uri did not become ready"
}

function Wait-WorkerReady([string]$LogPath, [uint32]$GroupPid) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
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
    throw "Backlinks worker did not become ready"
}

function Wait-HttpAvailable([string]$Uri, [uint32]$GroupPid) {
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
            throw "Process group $GroupPid exited before $Uri became available"
        }
        try {
            $response = Invoke-WebRequest -Uri $Uri -TimeoutSec 5 -UseBasicParsing
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
        }
    }
    throw "$Uri did not become available"
}

$statePath = Join-Path $RuntimeRoot "live001-processes.json"
if (Test-Path -LiteralPath $statePath) {
    $existing = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
        ConvertFrom-Json
    $active = @(
        $existing.fastApiGroupPid,
        $existing.coreApiGroupPid,
        $existing.workerGroupPid,
        $existing.frontendGroupPid
    ) | Where-Object {
        $_ -and (Get-Process -Id $_ -ErrorAction SilentlyContinue)
    }
    if ($active.Count -gt 0) {
        throw "LIVE-001 process groups are already active"
    }
}

$ports = if ($Stage -eq "LIVE-001") { @(7200, 7301) } else { @(5173, 7200, 7301) }
foreach ($port in $ports) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is already in use"
    }
}

foreach ($path in @(
    (Join-Path $RuntimeRoot "backlinks-api.env"),
    (Join-Path $RuntimeRoot "backlinks-worker.env"),
    (Join-Path $RuntimeRoot "fastapi.env")
)) {
    Assert-ProviderFlags $path $Stage
}

if ($Stage -ne "LIVE-001") {
    & (Join-Path $PSScriptRoot "Set-LocalProductSecretAcl.ps1") `
        -SecretRoot (Join-Path $RuntimeRoot "secrets") | Out-Null
}

$logs = Join-Path $RuntimeRoot "logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$powerShell = (Get-Command powershell.exe).Source
$wrapper = Join-Path $PSScriptRoot "Invoke-Live001Process.ps1"
$state = @{
    runId = $runId
    startedAt = (Get-Date -Format o)
    coreApiGroupPid = 0
    workerGroupPid = 0
    fastApiGroupPid = 0
    frontendGroupPid = 0
    stage = $Stage
}

try {
    $state.coreApiGroupPid = Start-Component `
        "core-api" $runId $powerShell $wrapper
    Write-State $state $statePath
    Wait-HttpReady "http://127.0.0.1:7301/ready" $state.coreApiGroupPid

    $state.workerGroupPid = Start-Component `
        "worker" $runId $powerShell $wrapper
    Write-State $state $statePath
    Wait-WorkerReady `
        (Join-Path $logs "$runId-worker.stdout.log") `
        $state.workerGroupPid

    $state.fastApiGroupPid = Start-Component `
        "fastapi" $runId $powerShell $wrapper
    Write-State $state $statePath
    Wait-HttpReady "http://127.0.0.1:7200/ready" $state.fastApiGroupPid

    if ($Stage -ne "LIVE-001") {
        $state.frontendGroupPid = Start-Component `
            "frontend" $runId $powerShell $wrapper
        Write-State $state $statePath
        Wait-HttpAvailable `
            "http://127.0.0.1:5173" `
            $state.frontendGroupPid
    }
}
catch {
    Write-State $state $statePath
    throw
}

[pscustomobject]$state
