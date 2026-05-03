#!/usr/bin/env bash
# uninstall-launchd.sh — thin wrapper for `install-launchd.sh --uninstall`.
# Forwards extra args (e.g. --dry-run).
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
exec "${SCRIPT_DIR}/install-launchd.sh" --uninstall "$@"
