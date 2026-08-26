param(
    [string]$TaskName = "GrowthOS Local Product Runtime Watchdog",
    [string]$EnvironmentFile = "",
    [string]$ComposeProjectName = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$watchdogPath = (
    Resolve-Path -LiteralPath (
        Join-Path $PSScriptRoot "ensure-local-product-runtime.ps1"
    )
).Path
if (-not $EnvironmentFile) {
    $EnvironmentFile = Join-Path $root "deploy\compose\.env"
}
$resolvedEnvironmentFile = (
    Resolve-Path -LiteralPath $EnvironmentFile
).Path
$powerShellPath = (
    Get-Command powershell.exe -ErrorAction Stop
).Source
$arguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy Bypass",
    "-WindowStyle Hidden",
    "-File `"$watchdogPath`"",
    "-EnvironmentFile `"$resolvedEnvironmentFile`""
)
if ($ComposeProjectName) {
    $arguments += "-ComposeProjectName `"$ComposeProjectName`""
}

$action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument ($arguments -join " ")
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$recurringTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($logonTrigger, $recurringTrigger) `
    -Settings $settings `
    -Principal $principal `
    -Description (
        "Keeps the GrowthOS PRODUCT API, Backlinks consumers, project " +
        "dispatcher, AI, and Gmail sync runtime available. Gmail send " +
        "intents still require explicit human confirmation."
    ) `
    -Force | Out-Null

Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName |
    Select-Object TaskName, State
