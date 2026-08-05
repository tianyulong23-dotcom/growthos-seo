param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA "GrowthOS\live001"),
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$statePath = Join-Path $RuntimeRoot "live001-processes.json"
if (-not (Test-Path -LiteralPath $statePath)) {
    throw "LIVE-001 process state does not exist"
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class GrowthOsConsoleSignal
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(
        uint controlEvent,
        uint processGroupId
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(
        IntPtr handlerRoutine,
        bool add
    );

    public static void SendBreak(uint processGroupId)
    {
        const uint CTRL_BREAK_EVENT = 1;
        FreeConsole();
        if (!AttachConsole(processGroupId))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        try
        {
            if (!GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, processGroupId))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            Thread.Sleep(250);
        }
        finally
        {
            FreeConsole();
            SetConsoleCtrlHandler(IntPtr.Zero, false);
        }
    }
}
"@

function Get-ProcessTree([uint32]$RootPid) {
    $processes = Get-CimInstance Win32_Process
    $ids = [System.Collections.Generic.List[uint32]]::new()
    $queue = [System.Collections.Generic.Queue[uint32]]::new()
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if (-not $ids.Contains($parent)) {
            $ids.Add($parent)
        }
        foreach ($child in $processes | Where-Object ParentProcessId -eq $parent) {
            $queue.Enqueue([uint32]$child.ProcessId)
        }
    }
    return $ids.ToArray()
}

function Stop-ProcessGroup([string]$Name, [uint32]$GroupPid) {
    if ($GroupPid -eq 0) {
        return
    }
    if (-not (Get-Process -Id $GroupPid -ErrorAction SilentlyContinue)) {
        return
    }

    $processTree = Get-ProcessTree $GroupPid
    $servicePids = @(
        $processTree | Where-Object {
            $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
            $process -and $process.ProcessName -in @("node", "python", "pythonw")
        }
    )
    if ($servicePids.Count -eq 0) {
        $processTree | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
        return
    }

    [GrowthOsConsoleSignal]::SendBreak($GroupPid)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $active = @(
            $servicePids | Where-Object {
                Get-Process -Id $_ -ErrorAction SilentlyContinue
            }
        )
        if ($active.Count -eq 0) {
            $processTree | ForEach-Object {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            }
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    throw "$Name did not stop gracefully; active PIDs: $($active -join ',')"
}

$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
    ConvertFrom-Json

if ($null -ne $state.frontendGroupPid) {
    Stop-ProcessGroup "Frontend" ([uint32]$state.frontendGroupPid)
}
Stop-ProcessGroup "FastAPI" ([uint32]$state.fastApiGroupPid)
Stop-ProcessGroup "Backlinks Core API" ([uint32]$state.coreApiGroupPid)
Stop-ProcessGroup "Backlinks Worker" ([uint32]$state.workerGroupPid)

$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object LocalPort -In 5173, 7200, 7301
if ($listeners) {
    throw "LIVE-001 listeners remain after shutdown"
}

Remove-Item -LiteralPath $statePath
[pscustomobject]@{
    stoppedAt = Get-Date -Format o
    graceful = $true
}
