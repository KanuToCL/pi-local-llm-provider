#!/usr/bin/env bash
# uninstall-systemd.sh — thin wrapper for `install-systemd.sh --uninstall`.
# Forwards extra args (e.g. --dry-run).
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
exec "${SCRIPT_DIR}/install-systemd.sh" --uninstall "$@"
