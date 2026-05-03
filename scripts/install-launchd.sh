#!/usr/bin/env bash
# install-launchd.sh — macOS LaunchAgent installer for the pi-comms daemon.
#
# Generates ~/Library/LaunchAgents/audio.sergiopena.pi-comms.plist and
# bootstraps it via `launchctl bootstrap gui/$(id -u)`. Idempotent: if a
# previous plist exists the agent is bootout'd before re-install.
#
# Lifecycle posture (per pi-comms plan v4 §"Phase 4 expansion", PE Skeptic R2):
#   • RunAtLoad: true            — start at user login
#   • KeepAlive { Crashed: true } — restart on abnormal exit only (no respawn
#                                    storm if `pi-comms shutdown` exits 0)
#   • ThrottleInterval: 60       — minimum 60s between launches
#   • StandardOutPath/ErrorPath  — files under ~/.pi-comms/ so launchctl logs
#                                    are not silently swallowed
#   • EnvironmentVariables: PATH — so `tsx` resolves under the LaunchAgent
#                                    sandbox (PATH is otherwise minimal)
#
# Sandbox state on boot is ALWAYS engaged regardless of any persisted
# /unsand window — per plan §"v4.2 sandbox state on daemon boot" the daemon
# itself enforces this, NOT this installer.
#
# Usage:
#   scripts/install-launchd.sh                  # install (default: tsx src/daemon.ts)
#   scripts/install-launchd.sh --built          # install pointing at dist/daemon.js
#   scripts/install-launchd.sh --uninstall      # bootout + remove plist
#   scripts/install-launchd.sh --dry-run        # print plist + actions, write nothing
#
# Env overrides:
#   PI_COMMS_LABEL   reverse-DNS label (default: audio.sergiopena.pi-comms)
#   PI_COMMS_REPO    repo path (default: this script's parent dir)

set -euo pipefail

LABEL="${PI_COMMS_LABEL:-audio.sergiopena.pi-comms}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_DIR="${PI_COMMS_REPO:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/.pi-comms"
STDOUT_LOG="${LOG_DIR}/launchd.stdout.log"
STDERR_LOG="${LOG_DIR}/launchd.stderr.log"

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
      echo "install-launchd: unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" && "${DRY_RUN}" -ne 1 ]]; then
  echo "install-launchd: this installer is macOS-only (uname=$(uname -s))" >&2
  echo "                 use scripts/install-systemd.sh on Linux or" >&2
  echo "                 scripts/install-windows-task.ps1 on Windows." >&2
  exit 2
fi

UID_VAL="$(id -u)"
DOMAIN="gui/${UID_VAL}"

# ---------------------------------------------------------------------------
# Resolve ProgramArguments. We embed full absolute paths so launchd's reduced
# PATH does not matter for resolution; PATH env is supplied as a fallback for
# any child process tsx itself spawns.
# ---------------------------------------------------------------------------
resolve_program_args() {
  if [[ "${USE_BUILT}" -eq 1 ]]; then
    NODE_BIN="$(command -v node || true)"
    if [[ -z "${NODE_BIN}" ]]; then
      echo "install-launchd: node not on PATH; install Node 20+." >&2
      exit 2
    fi
    DAEMON_JS="${REPO_DIR}/dist/daemon.js"
    if [[ ! -f "${DAEMON_JS}" && "${DRY_RUN}" -ne 1 ]]; then
      echo "install-launchd: ${DAEMON_JS} not found — run \`npm run build\` first." >&2
      exit 2
    fi
    PROGRAM_ARGS_XML=$(cat <<XML
        <string>${NODE_BIN}</string>
        <string>${DAEMON_JS}</string>
XML
)
  else
    # Prefer the repo-local tsx if present (so the installer works in a fresh
    # checkout without polluting the user's global npm). Fall back to PATH.
    TSX_BIN="${REPO_DIR}/node_modules/.bin/tsx"
    if [[ ! -x "${TSX_BIN}" ]]; then
      TSX_BIN="$(command -v tsx || true)"
    fi
    if [[ -z "${TSX_BIN}" ]]; then
      echo "install-launchd: tsx not found — run \`npm install\` in ${REPO_DIR}" >&2
      echo "                 or pass --built and run \`npm run build\` first." >&2
      exit 2
    fi
    DAEMON_TS="${REPO_DIR}/src/daemon.ts"
    if [[ ! -f "${DAEMON_TS}" && "${DRY_RUN}" -ne 1 ]]; then
      echo "install-launchd: ${DAEMON_TS} not found at expected repo path." >&2
      exit 2
    fi
    PROGRAM_ARGS_XML=$(cat <<XML
        <string>${TSX_BIN}</string>
        <string>${DAEMON_TS}</string>
XML
)
  fi
}

# Generate the plist body.
generate_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${PROGRAM_ARGS_XML}
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH}</string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
PLIST
}

uninstall() {
  if [[ ! -f "${PLIST_PATH}" ]]; then
    echo "install-launchd: nothing to uninstall (no plist at ${PLIST_PATH})"
    return 0
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: launchctl bootout ${DOMAIN}/${LABEL}"
    echo "[dry-run] would: rm ${PLIST_PATH}"
    return 0
  fi
  # bootout may fail if the agent is not currently loaded; that's fine.
  launchctl bootout "${DOMAIN}/${LABEL}" 2> /dev/null || true
  rm -f "${PLIST_PATH}"
  echo "install-launchd: uninstalled (${LABEL})"
}

if [[ "${UNINSTALL}" -eq 1 ]]; then
  uninstall
  exit 0
fi

resolve_program_args
PLIST_CONTENT="$(generate_plist)"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] plist path: ${PLIST_PATH}"
  echo "[dry-run] launchctl domain: ${DOMAIN}"
  echo "[dry-run] log dir: ${LOG_DIR}"
  echo "[dry-run] plist contents:"
  echo "----------------------------------------"
  echo "${PLIST_CONTENT}"
  echo "----------------------------------------"
  echo "[dry-run] would: mkdir -p ${PLIST_DIR} ${LOG_DIR}"
  if [[ -f "${PLIST_PATH}" ]]; then
    echo "[dry-run] would: launchctl bootout ${DOMAIN}/${LABEL} (existing install)"
  fi
  echo "[dry-run] would: write plist + launchctl bootstrap ${DOMAIN} ${PLIST_PATH}"
  echo "[dry-run] would: launchctl enable ${DOMAIN}/${LABEL}"
  exit 0
fi

mkdir -p "${PLIST_DIR}" "${LOG_DIR}"

# Idempotent re-install: bootout existing then re-bootstrap.
if [[ -f "${PLIST_PATH}" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2> /dev/null || true
fi

# Atomic write via temp + rename so a partial write can't be loaded.
TMP_PLIST="$(mktemp -t pi-comms-plist.XXXXXX)"
printf '%s\n' "${PLIST_CONTENT}" > "${TMP_PLIST}"
mv "${TMP_PLIST}" "${PLIST_PATH}"
chmod 644 "${PLIST_PATH}"

launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"
launchctl enable "${DOMAIN}/${LABEL}"

echo "install-launchd: installed ${LABEL}"
echo "  plist:  ${PLIST_PATH}"
echo "  stdout: ${STDOUT_LOG}"
echo "  stderr: ${STDERR_LOG}"
echo "  status: launchctl print ${DOMAIN}/${LABEL}"
