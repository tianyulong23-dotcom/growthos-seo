param(
    [string]$TaskName = "GrowthOS Local Product Runtime Watchdog"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask `
    -TaskName $TaskName `
    -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
