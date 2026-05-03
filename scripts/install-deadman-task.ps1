# install-deadman-task.ps1 — Windows Scheduled Task installer for dead-man.ps1.
#
# Per ~/.llms/plans/pi_comms_daemon.plan.md §"Phase 4.0" (line 1151).
# Mirror of scripts/install-deadman-cron.sh.
#
# Creates a Scheduled Task that runs dead-man.ps1 every 5 minutes under
# the current user, hidden, with no user interaction. Idempotent —
# re-running while the task exists removes and re-creates it (matches the
# unix installer's "stale entries replaced" behavior).
#
# Usage:
#   pwsh scripts/install-deadman-task.ps1                # install
#   pwsh scripts/install-deadman-task.ps1 -Uninstall     # remove
#   pwsh scripts/install-deadman-task.ps1 -Print         # print task XML
#
# Required env (set persistently before installing so the Scheduled Task
# inherits them):
#   PI_COMMS_DEADMAN_NTFY_TOPIC

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Uninstall')]
    [switch]$Uninstall,

    [Parameter(ParameterSetName = 'Print')]
    [switch]$Print
)

$ErrorActionPreference = 'Stop'

$TaskName = 'PiCommsDeadMan'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeadManPath = Join-Path $ScriptDir 'dead-man.ps1'

if (-not (Test-Path -LiteralPath $DeadManPath)) {
    Write-Error "install-deadman-task: $DeadManPath missing"
    exit 2
}

if ($Print) {
    Write-Host "Task name: $TaskName"
    Write-Host "Schedule:  every 5 minutes"
    Write-Host "Action:    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File `"$DeadManPath`""
    exit 0
}

# Always remove any existing instance — keeps install idempotent and lets
# us pick up new dead-man.ps1 paths after the user moves the checkout.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($Uninstall) {
    Write-Host "install-deadman-task: uninstalled"
    exit 0
}

$action = New-ScheduledTaskAction `
    -Execute 'pwsh.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$DeadManPath`""

# Trigger every 5 minutes, indefinitely. AtStartup is a one-shot trigger
# we use as the anchor; the RepetitionInterval makes it recur.
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

# Run as the interactive user, hidden, with reasonable settings.
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'pi-comms dead-man switch (managed by install-deadman-task.ps1)' | Out-Null

Write-Host "install-deadman-task: installed (every 5 min, runs as $env:USERNAME)"
Write-Host "                       ensure PI_COMMS_DEADMAN_NTFY_TOPIC is set in user environment"
exit 0
