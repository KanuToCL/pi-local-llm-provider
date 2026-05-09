#!/usr/bin/env bash
# pi-launch — validate env-var apiKey references in ~/.pi/agent/models.json
# before exec'ing pi-mono. Mitigates R2 in docs/DESIGN.md (literal env-var
# name shipped as bearer token when the env var is unset). All arguments
# are forwarded to `pi` verbatim.
#
# Usage:
#   pi-launch.sh --provider unsloth-studio --model "..." "list files"
#
# Env overrides:
#   PI_MODELS_JSON    path to models.json (default ~/.pi/agent/models.json)
#   PI_LAUNCH_VERBOSE if set, prints a one-line OK summary on success

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
CHECK_ENV="${SCRIPT_DIR}/check-env.js"
STUDIO_STATUS="${SCRIPT_DIR}/studio-status.js"

if [[ ! -f "${CHECK_ENV}" ]]; then
  echo "pi-launch: missing helper at ${CHECK_ENV}" >&2
  echo "           pull the latest pi-local-llm-provider checkout." >&2
  exit 2
fi

if ! command -v node > /dev/null 2>&1; then
  echo "pi-launch: node is required (Node 20+)" >&2
  exit 2
fi

if ! command -v pi > /dev/null 2>&1; then
  echo "pi-launch: pi-mono not found on PATH" >&2
  echo "           install: npm install -g @mariozechner/pi-coding-agent" >&2
  exit 2
fi

node "${CHECK_ENV}"

# Pre-launch banner: memory, loaded model/variant, suggested ctx, cached
# variants. Best-effort — never blocks the launch. Skipped when
# STUDIO_QUIET=1 or UNSLOTH_API_KEY is unset (the latter handled inside
# the script). Only attempted for the Unsloth Studio provider.
if [[ -f "${STUDIO_STATUS}" ]]; then
  case " $* " in
    *" --provider unsloth-studio "*|*" -p unsloth-studio "*)
      node "${STUDIO_STATUS}" || true
      ;;
  esac
fi

exec pi "$@"
