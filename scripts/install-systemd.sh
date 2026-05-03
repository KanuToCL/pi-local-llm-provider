#!/usr/bin/env bash
# install-systemd.sh — Linux systemd-user-service installer for pi-comms.
#
# Generates ~/.config/systemd/user/pi-comms.service then runs
# `systemctl --user daemon-reload` and `systemctl --user enable --now pi-comms`.
#
# CRITICAL (PE Skeptic R2): user services without lingering die at logout.
# This installer asserts `loginctl enable-linger $USER` is enabled and
# REFUSES to install otherwise, with a one-line fix instruction.
#
# Service posture:
#   • Type=simple                    — daemon stays foreground; systemd
#                                      tracks the main PID
#   • Restart=on-failure             — restart on non-zero exit only
#                                      (graceful `pi-comms shutdown` exits 0
#                                      and stays down)
#   • RestartSec=60                  — backoff matches launchd ThrottleInterval
#   • StandardOutput=append:%h/...   — survives across restarts (vs journal-only)
#
# Sandbox state on boot is ALWAYS engaged — enforced by daemon, not unit file.
#
# Usage:
#   scripts/install-systemd.sh                  # install (default: tsx src/daemon.ts)
#   scripts/install-systemd.sh --built          # install pointing at dist/daemon.js
#   scripts/install-systemd.sh --uninstall      # disable --now + remove unit
#   scripts/install-systemd.sh --dry-run        # print unit + actions, write nothing
#
# Env overrides:
#   PI_COMMS_UNIT     unit name (default: pi-comms.service)
#   PI_COMMS_REPO     repo path (default: this script's parent dir)

set -euo pipefail

UNIT="${PI_COMMS_UNIT:-pi-comms.service}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_DIR="${PI_COMMS_REPO:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="${UNIT_DIR}/${UNIT}"
LOG_DIR="${HOME}/.pi-comms"
STDOUT_LOG="${LOG_DIR}/systemd.stdout.log"
STDERR_LOG="${LOG_DIR}/systemd.stderr.log"

USE_BUILT=0
DRY_RUN=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --built) USE_BUILT=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "install-systemd: unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" && "${DRY_RUN}" -ne 1 ]]; then
  echo "install-systemd: this installer is Linux-only (uname=$(uname -s))" >&2
  echo "                 use scripts/install-launchd.sh on macOS or" >&2
  echo "                 scripts/install-windows-task.ps1 on Windows." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Linger gate (PE Skeptic R2 blocking finding).
# Without linger, the user manager exits at logout and pi-comms dies with it.
# ---------------------------------------------------------------------------
assert_linger() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: verify loginctl show-user ${USER} -P Linger == yes"
    return 0
  fi
  if ! command -v loginctl > /dev/null 2>&1; then
    echo "install-systemd: loginctl not found — this host does not appear to" >&2
    echo "                 run systemd-logind. pi-comms cannot autostart here." >&2
    exit 2
  fi
  local linger
  linger="$(loginctl show-user "${USER}" -P Linger 2> /dev/null || echo "no")"
  if [[ "${linger}" != "yes" ]]; then
    echo "install-systemd: REFUSING to install — linger is not enabled for user '${USER}'." >&2
    echo "" >&2
    echo "  Without linger the systemd --user manager exits at logout and the" >&2
    echo "  pi-comms daemon dies with it. Enable linger then re-run this script:" >&2
    echo "" >&2
    echo "    sudo loginctl enable-linger ${USER}" >&2
    echo "" >&2
    echo "  (PE Skeptic R2 — pi-comms plan v4 §Phase 4 expansion)" >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Resolve ExecStart.
# ---------------------------------------------------------------------------
resolve_exec_start() {
  if [[ "${USE_BUILT}" -eq 1 ]]; then
    NODE_BIN="$(command -v node || true)"
    if [[ -z "${NODE_BIN}" ]]; then
      echo "install-systemd: node not on PATH; install Node 20+." >&2
      exit 2
    fi
    DAEMON_JS="${REPO_DIR}/dist/daemon.js"
    if [[ ! -f "${DAEMON_JS}" && "${DRY_RUN}" -ne 1 ]]; then
      echo "install-systemd: ${DAEMON_JS} not found — run \`npm run build\` first." >&2
      exit 2
    fi
    EXEC_START="${NODE_BIN} ${DAEMON_JS}"
  else
    # Prefer the repo-local tsx if present (so the installer works in a fresh
    # checkout without polluting the user's global npm). Fall back to PATH.
    TSX_BIN="${REPO_DIR}/node_modules/.bin/tsx"
    if [[ ! -x "${TSX_BIN}" ]]; then
      TSX_BIN="$(command -v tsx || true)"
    fi
    if [[ -z "${TSX_BIN}" ]]; then
      echo "install-systemd: tsx not found — run \`npm install\` in ${REPO_DIR}" >&2
      echo "                 or pass --built and run \`npm run build\` first." >&2
      exit 2
    fi
    DAEMON_TS="${REPO_DIR}/src/daemon.ts"
    if [[ ! -f "${DAEMON_TS}" && "${DRY_RUN}" -ne 1 ]]; then
      echo "install-systemd: ${DAEMON_TS} not found at expected repo path." >&2
      exit 2
    fi
    EXEC_START="${TSX_BIN} ${DAEMON_TS}"
  fi
}

generate_unit() {
  cat <<UNIT
[Unit]
Description=pi-comms daemon (local-LLM coding agent over Telegram/WhatsApp)
Documentation=https://github.com/KanuToCL/pi-local-llm-provider
After=network.target

[Service]
Type=simple
ExecStart=${EXEC_START}
WorkingDirectory=${REPO_DIR}
Restart=on-failure
RestartSec=60
StandardOutput=append:${STDOUT_LOG}
StandardError=append:${STDERR_LOG}
# Pass current PATH so node finds tsx/npm-installed binaries under the
# systemd-user environment (which has a stripped PATH by default).
Environment=PATH=${PATH}

[Install]
WantedBy=default.target
UNIT
}

uninstall() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: systemctl --user disable --now ${UNIT}"
    echo "[dry-run] would: rm ${UNIT_PATH}"
    echo "[dry-run] would: systemctl --user daemon-reload"
    return 0
  fi
  if ! command -v systemctl > /dev/null 2>&1; then
    echo "install-systemd: systemctl not found; nothing to uninstall."
    return 0
  fi
  systemctl --user disable --now "${UNIT}" 2> /dev/null || true
  if [[ -f "${UNIT_PATH}" ]]; then
    rm -f "${UNIT_PATH}"
    systemctl --user daemon-reload
    echo "install-systemd: uninstalled (${UNIT})"
  else
    echo "install-systemd: nothing to uninstall (no unit at ${UNIT_PATH})"
  fi
}

if [[ "${UNINSTALL}" -eq 1 ]]; then
  uninstall
  exit 0
fi

assert_linger
resolve_exec_start
UNIT_CONTENT="$(generate_unit)"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] unit path: ${UNIT_PATH}"
  echo "[dry-run] log dir:   ${LOG_DIR}"
  echo "[dry-run] unit contents:"
  echo "----------------------------------------"
  echo "${UNIT_CONTENT}"
  echo "----------------------------------------"
  echo "[dry-run] would: mkdir -p ${UNIT_DIR} ${LOG_DIR}"
  echo "[dry-run] would: write unit + systemctl --user daemon-reload"
  echo "[dry-run] would: systemctl --user enable --now ${UNIT}"
  exit 0
fi

mkdir -p "${UNIT_DIR}" "${LOG_DIR}"

# Atomic write.
TMP_UNIT="$(mktemp -t pi-comms-unit.XXXXXX)"
printf '%s\n' "${UNIT_CONTENT}" > "${TMP_UNIT}"
mv "${TMP_UNIT}" "${UNIT_PATH}"
chmod 644 "${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT}"

echo "install-systemd: installed ${UNIT}"
echo "  unit:   ${UNIT_PATH}"
echo "  stdout: ${STDOUT_LOG}"
echo "  stderr: ${STDERR_LOG}"
echo "  status: systemctl --user status ${UNIT}"
echo "  logs:   journalctl --user-unit ${UNIT} -f"
