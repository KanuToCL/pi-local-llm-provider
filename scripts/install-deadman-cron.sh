#!/usr/bin/env bash
# install-deadman-cron.sh — idempotent cron installer for dead-man.sh.
#
# Per ~/.llms/plans/pi_comms_daemon.plan.md §"Phase 4.0" (line 1151).
#
# Adds a `*/5 * * * *` entry to the current user's crontab. The entry
# points at the absolute path of dead-man.sh sitting next to this
# installer. Idempotent: re-running while the entry is already present
# is a no-op.
#
# Usage:
#   scripts/install-deadman-cron.sh                 # install
#   scripts/install-deadman-cron.sh --uninstall     # remove
#   scripts/install-deadman-cron.sh --print         # print what would be added
#
# Required env (passed through to dead-man.sh at runtime — set them in
# your shell rc or systemd-environment.d so cron's stripped env can see
# them; otherwise set them in the cron line itself by editing manually):
#   PI_COMMS_DEADMAN_NTFY_TOPIC

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
DEADMAN_PATH="${SCRIPT_DIR}/dead-man.sh"
CRON_LINE_TAG="# pi-comms dead-man switch (managed by install-deadman-cron.sh)"
CRON_LINE_CMD="*/5 * * * * ${DEADMAN_PATH} >> /tmp/pi-comms-deadman.log 2>&1"

action="install"
case "${1:-}" in
  --uninstall|-u)
    action="uninstall"
    ;;
  --print|-p)
    action="print"
    ;;
  --help|-h)
    echo "usage: $(basename "$0") [--install|--uninstall|--print]"
    exit 0
    ;;
  "")
    ;;
  *)
    echo "unknown flag: $1" >&2
    exit 2
    ;;
esac

if [[ ! -x "$DEADMAN_PATH" ]]; then
  echo "install-deadman-cron: ${DEADMAN_PATH} missing or not executable" >&2
  echo "                      run: chmod +x ${DEADMAN_PATH}" >&2
  exit 2
fi

if ! command -v crontab > /dev/null 2>&1; then
  echo "install-deadman-cron: crontab not found on PATH" >&2
  echo "                      install cron (debian: apt install cron; macOS: built-in)" >&2
  exit 2
fi

if [[ "$action" == "print" ]]; then
  echo "$CRON_LINE_TAG"
  echo "$CRON_LINE_CMD"
  exit 0
fi

# Capture the existing crontab (treat "no crontab" as empty).
EXISTING="$(crontab -l 2> /dev/null || true)"

# Strip prior pi-comms managed entries (the tag line and any */5 line that
# references our absolute path). This makes uninstall trivial and lets
# install replace any prior entry without duplicating.
FILTERED="$(printf '%s\n' "$EXISTING" \
  | grep -vF "$CRON_LINE_TAG" \
  | grep -vF "$DEADMAN_PATH" \
  || true)"

if [[ "$action" == "uninstall" ]]; then
  if [[ -z "$FILTERED" || "$FILTERED" == $'\n' ]]; then
    # An empty crontab can't be installed via `crontab -` on some BSDs —
    # remove it entirely.
    crontab -r 2> /dev/null || true
  else
    printf '%s\n' "$FILTERED" | crontab -
  fi
  echo "install-deadman-cron: uninstalled"
  exit 0
fi

# Install: append our managed entry to the filtered crontab.
NEW_CRONTAB="$(printf '%s\n%s\n%s\n' "$FILTERED" "$CRON_LINE_TAG" "$CRON_LINE_CMD" \
  | sed '/^$/N;/^\n$/D')"

printf '%s\n' "$NEW_CRONTAB" | crontab -
echo "install-deadman-cron: installed (every 5 min)"
echo "                      heartbeat at ${PI_COMMS_HOME:-\$HOME/.pi-comms}/daemon.heartbeat"
echo "                      ensure PI_COMMS_DEADMAN_NTFY_TOPIC is exported in cron's env"
exit 0
