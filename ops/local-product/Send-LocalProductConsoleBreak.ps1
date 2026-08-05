param(
    [Parameter(Mandatory)]
    [uint32]$GroupPid
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class GrowthOsLocalProductConsoleSignal
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
            SetConsoleCtrlHandler(IntPtr.Zero, false);
            FreeConsole();
        }
    }
}
"@

[GrowthOsLocalProductConsoleSignal]::SendBreak($GroupPid)
