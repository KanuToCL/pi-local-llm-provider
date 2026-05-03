#!/usr/bin/env bash
# dead-man.sh — Linux/macOS cron-style dead-man switch for pi-comms.
#
# Per ~/.llms/plans/pi_comms_daemon.plan.md §"Phase 4.0 (NEW) Dead-man
# switch independent of daemon" (line 1151):
#
#   Cron/launchd/Scheduled-Task runs every 5 min, reads
#   ~/.pi-comms/daemon.heartbeat mtime; if older than 3 min, sends a
#   Baileys-independent push via ntfy.sh (default; free, no signup).
#   Configurable to pushover or mailgun via env.
#
# This script is INDEPENDENT of the daemon: it runs from cron (Linux) or
# launchd-equivalent (macOS) and reads only the heartbeat file's mtime.
# A daemon that has crashed, hung, or been OOM-killed cannot suppress
# this script — that's the whole point of an out-of-band liveness probe.
#
# Notification suppression: to avoid a 5-minute notification storm while
# the daemon is down, the script tracks the last-notification timestamp
# in PI_COMMS_HOME/dead-man-last-notify.ts; once notified, it won't
# re-notify for 30 minutes unless the heartbeat recovers in between.
#
# Cron entry (installed by scripts/install-deadman-cron.sh):
#   */5 * * * * /abs/path/to/dead-man.sh >> /tmp/pi-comms-deadman.log 2>&1
#
# Required env:
#   PI_COMMS_DEADMAN_NTFY_TOPIC  ntfy.sh topic (e.g. pi-comms-sergio-9f2a3c)
#                                Required when transport is 'ntfy' (default).
#
# Optional env:
#   PI_COMMS_HOME                 default ~/.pi-comms
#   PI_COMMS_DEADMAN_TRANSPORT    'ntfy' (default) | 'pushover' | 'mailgun'
#   PI_COMMS_DEADMAN_STALE_SECS   default 180 (3 min) — heartbeat age threshold
#   PI_COMMS_DEADMAN_SUPPRESS_SECS default 1800 (30 min) — re-notify cooldown
#   PI_COMMS_DEADMAN_NTFY_HOST    default https://ntfy.sh — override for self-hosted
#   PI_COMMS_DEADMAN_PUSHOVER_TOKEN
#   PI_COMMS_DEADMAN_PUSHOVER_USER
#   PI_COMMS_DEADMAN_MAILGUN_API_KEY
#   PI_COMMS_DEADMAN_MAILGUN_DOMAIN
#   PI_COMMS_DEADMAN_MAILGUN_TO

set -euo pipefail

PI_COMMS_HOME="${PI_COMMS_HOME:-${HOME}/.pi-comms}"
HEARTBEAT_PATH="${PI_COMMS_HOME}/daemon.heartbeat"
LAST_NOTIFY_PATH="${PI_COMMS_HOME}/dead-man-last-notify.ts"
STALE_SECS="${PI_COMMS_DEADMAN_STALE_SECS:-180}"
SUPPRESS_SECS="${PI_COMMS_DEADMAN_SUPPRESS_SECS:-1800}"
TRANSPORT="${PI_COMMS_DEADMAN_TRANSPORT:-ntfy}"

now_secs() {
  date +%s
}

# stat -c is GNU; stat -f is BSD/macOS — try both.
file_mtime_secs() {
  local path="$1"
  if stat -c %Y "$path" 2> /dev/null; then
    return 0
  fi
  if stat -f %m "$path" 2> /dev/null; then
    return 0
  fi
  return 1
}

log_line() {
  echo "[dead-man $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

send_ntfy() {
  local message="$1"
  local topic="${PI_COMMS_DEADMAN_NTFY_TOPIC:-}"
  local host="${PI_COMMS_DEADMAN_NTFY_HOST:-https://ntfy.sh}"
  if [[ -z "$topic" ]]; then
    log_line "ERROR: PI_COMMS_DEADMAN_NTFY_TOPIC unset; cannot notify via ntfy" >&2
    return 1
  fi
  curl -sS \
    -H "Title: pi-comms dead" \
    -H "Priority: urgent" \
    -H "Tags: warning,skull" \
    -d "$message" \
    "${host}/${topic}"
}

send_pushover() {
  local message="$1"
  local token="${PI_COMMS_DEADMAN_PUSHOVER_TOKEN:-}"
  local user="${PI_COMMS_DEADMAN_PUSHOVER_USER:-}"
  if [[ -z "$token" || -z "$user" ]]; then
    log_line "ERROR: PI_COMMS_DEADMAN_PUSHOVER_{TOKEN,USER} required" >&2
    return 1
  fi
  curl -sS \
    --data-urlencode "token=${token}" \
    --data-urlencode "user=${user}" \
    --data-urlencode "title=pi-comms dead" \
    --data-urlencode "priority=1" \
    --data-urlencode "message=${message}" \
    https://api.pushover.net/1/messages.json
}

send_mailgun() {
  local message="$1"
  local api_key="${PI_COMMS_DEADMAN_MAILGUN_API_KEY:-}"
  local domain="${PI_COMMS_DEADMAN_MAILGUN_DOMAIN:-}"
  local to="${PI_COMMS_DEADMAN_MAILGUN_TO:-}"
  if [[ -z "$api_key" || -z "$domain" || -z "$to" ]]; then
    log_line "ERROR: PI_COMMS_DEADMAN_MAILGUN_{API_KEY,DOMAIN,TO} required" >&2
    return 1
  fi
  curl -sS --user "api:${api_key}" \
    "https://api.mailgun.net/v3/${domain}/messages" \
    -F "from=pi-comms <pi-comms@${domain}>" \
    -F "to=${to}" \
    -F "subject=pi-comms dead" \
    -F "text=${message}"
}

dispatch_notification() {
  local message="$1"
  case "$TRANSPORT" in
    ntfy)
      send_ntfy "$message"
      ;;
    pushover)
      send_pushover "$message"
      ;;
    mailgun)
      send_mailgun "$message"
      ;;
    *)
      log_line "ERROR: unknown PI_COMMS_DEADMAN_TRANSPORT: $TRANSPORT" >&2
      return 1
      ;;
  esac
}

# -- Main -------------------------------------------------------------------

mkdir -p "$PI_COMMS_HOME"

NOW="$(now_secs)"

if [[ ! -f "$HEARTBEAT_PATH" ]]; then
  AGE="missing"
  STALE=1
else
  MTIME="$(file_mtime_secs "$HEARTBEAT_PATH")" || {
    log_line "ERROR: unable to stat $HEARTBEAT_PATH" >&2
    exit 1
  }
  AGE=$((NOW - MTIME))
  if (( AGE > STALE_SECS )); then
    STALE=1
  else
    STALE=0
  fi
fi

if (( STALE == 0 )); then
  # Heartbeat is fresh — clear any stale suppression marker so the next
  # outage notifies immediately instead of being silenced by a 30-min
  # cooldown left over from yesterday.
  if [[ -f "$LAST_NOTIFY_PATH" ]]; then
    rm -f "$LAST_NOTIFY_PATH"
  fi
  exit 0
fi

# Stale. Decide whether to notify (suppress if we already did within
# SUPPRESS_SECS).
SHOULD_NOTIFY=1
if [[ -f "$LAST_NOTIFY_PATH" ]]; then
  LAST_NOTIFY_TS="$(cat "$LAST_NOTIFY_PATH" 2> /dev/null || echo 0)"
  if [[ -n "$LAST_NOTIFY_TS" && "$LAST_NOTIFY_TS" =~ ^[0-9]+$ ]]; then
    SINCE_LAST=$((NOW - LAST_NOTIFY_TS))
    if (( SINCE_LAST < SUPPRESS_SECS )); then
      SHOULD_NOTIFY=0
      log_line "stale (age=${AGE}s) but suppressed (last notify ${SINCE_LAST}s ago < ${SUPPRESS_SECS}s)"
    fi
  fi
fi

if (( SHOULD_NOTIFY == 1 )); then
  HOSTNAME_S="$(hostname 2> /dev/null || echo unknown)"
  MESSAGE="pi-comms heartbeat stale on ${HOSTNAME_S}: heartbeat age=${AGE}s threshold=${STALE_SECS}s. Daemon may be dead."
  if dispatch_notification "$MESSAGE"; then
    echo "$NOW" > "$LAST_NOTIFY_PATH"
    log_line "notified via ${TRANSPORT}: $MESSAGE"
  else
    log_line "ERROR: failed to dispatch notification via ${TRANSPORT}" >&2
    exit 1
  fi
fi

exit 0
