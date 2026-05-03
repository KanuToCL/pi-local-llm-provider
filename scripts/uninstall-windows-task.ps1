<#
.SYNOPSIS
  Thin wrapper for `install-windows-task.ps1 -Uninstall`. Forwards extra
  flags (e.g. -DryRun, -TaskName).

.EXAMPLE
  pwsh scripts\uninstall-windows-task.ps1
  pwsh scripts\uninstall-windows-task.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$TaskName = "pi-comms"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $scriptDir "install-windows-task.ps1"

$forward = @("-Uninstall", "-TaskName", $TaskName)
if ($DryRun) { $forward += "-DryRun" }

& $installer @forward
exit $LASTEXITCODE
