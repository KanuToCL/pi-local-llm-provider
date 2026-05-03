<#
.SYNOPSIS
  Register the pi-comms daemon as a Windows Scheduled Task.

.DESCRIPTION
  Creates a Scheduled Task named "pi-comms" that:
    - triggers At log on of the current user
    - runs `tsx <repo>\src\daemon.ts` (or `node <repo>\dist\daemon.js` with -Built)
    - runs as the current user (no elevation; never -RunLevel Highest)
    - restarts after 60s on failure
    - sets MultipleInstancesPolicy = IgnoreNew so RDP / Fast-User-Switching
      can NOT spawn a second daemon (PE Skeptic R2 blocking finding;
      pi-comms plan v4 §"Phase 4 expansion")

  Idempotent: if a task with the same name exists it is unregistered first.

  Sandbox state on boot is ALWAYS engaged regardless of any persisted
  /unsand window — enforced by the daemon, not this installer
  (plan §"v4.2 sandbox state on daemon boot").

.PARAMETER Built
  Use the compiled dist\daemon.js (requires `npm run build`) instead of tsx.

.PARAMETER Uninstall
  Unregister the Scheduled Task and exit.

.PARAMETER DryRun
  Print the resolved task XML and the actions that would run, write nothing.

.PARAMETER TaskName
  Override the task name. Default: pi-comms.

.PARAMETER RepoDir
  Override the repo path. Default: this script's parent directory.

.EXAMPLE
  pwsh scripts\install-windows-task.ps1
  pwsh scripts\install-windows-task.ps1 -Built
  pwsh scripts\install-windows-task.ps1 -Uninstall
  pwsh scripts\install-windows-task.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [switch]$Built,
    [switch]$Uninstall,
    [switch]$DryRun,
    [string]$TaskName = "pi-comms",
    [string]$RepoDir
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Resolve paths.
# ---------------------------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoDir) {
    $RepoDir = Split-Path -Parent $scriptDir
}
$logDir    = Join-Path $env:USERPROFILE ".pi-comms"

# Helper: resolve a command on PATH; return $null if absent.
function Find-Command {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source } else { return $null }
}

function Resolve-Action {
    if ($Built) {
        $node = Find-Command "node"
        if (-not $node) {
            throw "install-windows-task: node not on PATH; install Node 20+."
        }
        $daemonJs = Join-Path $RepoDir "dist\daemon.js"
        if ((-not $DryRun) -and (-not (Test-Path $daemonJs))) {
            throw "install-windows-task: $daemonJs not found — run \`npm run build\` first."
        }
        return [pscustomobject]@{ Exe = $node; Args = "`"$daemonJs`"" }
    } else {
        # Prefer the repo-local tsx if present (resilient on Windows where
        # global npm shims sometimes resolve to .CMD wrappers Task Scheduler
        # cannot exec directly). Fall back to PATH.
        $tsx = Join-Path $RepoDir "node_modules\.bin\tsx.cmd"
        if (-not (Test-Path $tsx)) {
            $tsx = Join-Path $RepoDir "node_modules\.bin\tsx"
        }
        if (-not (Test-Path $tsx)) {
            $tsx = Find-Command "tsx"
        }
        if (-not $tsx) {
            throw "install-windows-task: tsx not found — run \`npm install\` in $RepoDir or pass -Built."
        }
        $daemonTs = Join-Path $RepoDir "src\daemon.ts"
        if ((-not $DryRun) -and (-not (Test-Path $daemonTs))) {
            throw "install-windows-task: $daemonTs not found at expected repo path."
        }
        return [pscustomobject]@{ Exe = $tsx; Args = "`"$daemonTs`"" }
    }
}

# ---------------------------------------------------------------------------
# Uninstall path.
# ---------------------------------------------------------------------------
function Uninstall-Task {
    $existing = $null
    try {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } catch {
        $existing = $null
    }
    if (-not $existing) {
        Write-Host "install-windows-task: nothing to uninstall (no task '$TaskName')"
        return
    }
    if ($DryRun) {
        Write-Host "[dry-run] would: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
        return
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "install-windows-task: uninstalled task '$TaskName'"
}

if ($Uninstall) {
    Uninstall-Task
    exit 0
}

# ---------------------------------------------------------------------------
# Build the task definition.
# ---------------------------------------------------------------------------
$action = Resolve-Action

# Trigger: at log on of CURRENT USER (NOT "any user" — pi-comms is per-user
# state and per-user secrets; logging in as a different account must not
# launch *this* user's daemon).
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: PE Skeptic R2 — IgnoreNew prevents RDP / Fast-User-Switching
# from spawning a second concurrent daemon for the same account.
# RestartInterval = 1 min on failure (matches launchd ThrottleInterval +
# systemd RestartSec). RestartCount big-enough to survive sustained flap.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 999

# Run as the invoking user, interactive token, NO elevation.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$taskAction = New-ScheduledTaskAction `
    -Execute $action.Exe `
    -Argument $action.Args `
    -WorkingDirectory $RepoDir

$task = New-ScheduledTask `
    -Action $taskAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "pi-comms daemon — local-LLM coding agent over Telegram/WhatsApp. Logs: $logDir\windows-task.*.log"

if ($DryRun) {
    Write-Host "[dry-run] task name:   $TaskName"
    Write-Host "[dry-run] repo dir:    $RepoDir"
    Write-Host "[dry-run] action exe:  $($action.Exe)"
    Write-Host "[dry-run] action args: $($action.Args)"
    Write-Host "[dry-run] log dir:     $logDir"
    Write-Host "[dry-run] task XML:"
    Write-Host "----------------------------------------"
    # The XML representation is what `Register-ScheduledTask -Xml` would consume.
    $xml = $task | Export-ScheduledTask -ErrorAction SilentlyContinue
    if (-not $xml) {
        # Some PowerShell versions can't export an unregistered task; assemble
        # a representative summary instead so the operator can sanity-check.
        $xml = @"
<Task>
  <Triggers><LogonTrigger><UserId>$env:USERNAME</UserId></LogonTrigger></Triggers>
  <Principals><Principal><UserId>$env:USERDOMAIN\$env:USERNAME</UserId><LogonType>Interactive</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
  <Actions><Exec><Command>$($action.Exe)</Command><Arguments>$($action.Args)</Arguments><WorkingDirectory>$RepoDir</WorkingDirectory></Exec></Actions>
</Task>
"@
    }
    Write-Host $xml
    Write-Host "----------------------------------------"
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[dry-run] would: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false (existing install)"
    }
    Write-Host "[dry-run] would: New-Item -ItemType Directory -Force -Path $logDir"
    Write-Host "[dry-run] would: Register-ScheduledTask -TaskName $TaskName -InputObject `$task"
    exit 0
}

# Ensure log dir exists (pi-comms also creates it; we make a courtesy mkdir).
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

# Idempotent re-install.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null

Write-Host "install-windows-task: installed task '$TaskName'"
Write-Host "  exe:    $($action.Exe) $($action.Args)"
Write-Host "  cwd:    $RepoDir"
Write-Host "  status: Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "  start:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  logs:   $logDir"
