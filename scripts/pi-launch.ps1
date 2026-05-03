<#
.SYNOPSIS
  Validate env-var apiKey references in ~/.pi/agent/models.json before
  exec'ing pi-mono. Mitigates R2 in docs/DESIGN.md (literal env-var name
  shipped as bearer token when the env var is unset). All arguments are
  forwarded to `pi` verbatim. Windows / PowerShell counterpart to
  scripts/pi-launch.sh.

.EXAMPLE
  .\pi-launch.ps1 --provider unsloth-studio --model "unsloth/Qwen3.6-27B-GGUF" "list files"

.NOTES
  Env overrides:
    PI_MODELS_JSON     path to models.json (default $HOME\.pi\agent\models.json)
    PI_LAUNCH_VERBOSE  if set, prints a one-line OK summary on success
#>

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$checkEnv  = Join-Path $scriptDir "check-env.js"

if (-not (Test-Path $checkEnv)) {
  Write-Error "pi-launch: missing helper at $checkEnv"
  Write-Error "           pull the latest pi-local-llm-provider checkout."
  exit 2
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "pi-launch: node is required (Node 20+)"
  exit 2
}

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
  Write-Error "pi-launch: pi-mono not found on PATH"
  Write-Error "           install: npm install -g @mariozechner/pi-coding-agent"
  exit 2
}

& node $checkEnv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& pi @args
exit $LASTEXITCODE
