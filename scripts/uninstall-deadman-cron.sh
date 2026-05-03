#!/usr/bin/env bash
# uninstall-deadman-cron.sh — convenience wrapper that calls the
# real installer with --uninstall. Exists so users (and the verification
# checklist in ~/.llms/plans/pi_comms_daemon.plan.md) can reach for the
# obvious filename without remembering the flag.
#
# Per ~/.llms/plans/pi_comms_daemon.plan.md §"Phase 4.0" (line 1151).

set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
exec "${SCRIPT_DIR}/install-deadman-cron.sh" --uninstall
