# INSTALL — pi-comms daemon, per-OS lifecycle

This document covers the **autostart / lifecycle layer** for the `pi-comms`
daemon. The daemon itself, IPC, channels, sandbox, and dead-man switch
have their own docs in `docs/ARCHITECTURE.md` and `docs/DESIGN.md`.

> **Plan reference:** `~/.llms/plans/pi_comms_daemon.plan.md`
> §"Phase 4 expansion — 1 day → 2.5 days" and §"Per-OS test matrix".

---

## Pre-requisites (all OSes)

| Requirement | Why | Verification |
|---|---|---|
| Node 20+ | `tsx` shim, native ESM | `node --version` |
| `tsx` on PATH OR a built `dist/daemon.js` | runtime entry-point | `tsx --version` or `ls dist/daemon.js` |
| `pi-mono` (`@mariozechner/pi-coding-agent`) installed | the agent runtime daemon embeds | `pi --version` |
| `~/.pi/agent/models.json` valid | provider definitions | `node scripts/check-env.js` |
| Unsloth Studio (or another OpenAI-compatible local backend) running | the inference server pi talks to | `curl http://localhost:8888/api/inference/status` |
| Channel secrets set: `TELEGRAM_BOT_TOKEN` (Phase 1) and/or `WHATSAPP_*` env (Phase 5) | bot ingress | `env | grep TELEGRAM` |
| `~/.pi-comms/` directory writable by the user | state, logs, audit | `mkdir -p ~/.pi-comms` |

Run `scripts/pi-launch.sh` (or the `.ps1` equivalent) once before installing
the autostart layer — it validates the env-var apiKey references and surfaces
any missing secrets *before* the daemon tries to autostart in the background
where errors are easier to miss.

---

## macOS — LaunchAgent

### Install

```bash
cd path/to/pi-local-llm-provider
scripts/install-launchd.sh             # uses tsx src/daemon.ts
# OR after `npm run build`:
scripts/install-launchd.sh --built     # uses node dist/daemon.js
```

What it does:

1. Generates `~/Library/LaunchAgents/audio.sergiopena.pi-comms.plist`.
2. `launchctl bootstrap gui/$(id -u) <plist>`.
3. `launchctl enable gui/$(id -u)/audio.sergiopena.pi-comms`.

### Plist contents (key posture decisions)

Per **PE Skeptic Round 2**, the plist sets:

- `RunAtLoad: true` — start at user login.
- `KeepAlive { SuccessfulExit: false, Crashed: true }` — restart only on
  abnormal exit. A graceful `pi-comms shutdown` exits 0 and the LaunchAgent
  stays down.
- `ThrottleInterval: 60` — minimum 60 seconds between launches. Without this,
  a tight crash-loop floods system logs.
- `StandardOutPath: ~/.pi-comms/launchd.stdout.log`
  `StandardErrorPath: ~/.pi-comms/launchd.stderr.log` — without these,
  launchd silently swallows daemon output and you have no log when the daemon
  fails to start.
- `EnvironmentVariables.PATH` — captured at install time so `tsx` and any
  child processes resolve under launchd's otherwise-minimal env.

### Verify

```bash
launchctl print gui/$(id -u)/audio.sergiopena.pi-comms | head -30
tail -f ~/.pi-comms/launchd.stderr.log
```

Useful states: `state = running`, `last exit code = 0`. If `state = not running`
and `last exit code != 0`, read the stderr log.

### Debug — common launchd surprises

- **`tsx` not found**: launchd's PATH does not include npm-global bin. The
  installer captures your PATH at install time; if you later install `tsx`
  in a different location, re-run the installer.
- **LaunchAgent silently inactive**: confirm the plist is in
  `~/Library/LaunchAgents/` (NOT `/Library/LaunchAgents/` — that requires
  root). Confirm `RunAtLoad` is `true`.
- **Same-UID double daemon (FUS scenario)**: macOS does not have RDP, but
  fast-user-switching can produce a second login session. The daemon's
  internal single-instance lock (`flock(2)` per plan) prevents two daemons
  from racing on the IPC socket.

### Uninstall

```bash
scripts/uninstall-launchd.sh           # bootout + remove plist
scripts/uninstall-launchd.sh --dry-run # preview only
```

---

## Linux — systemd user service

### Pre-step: enable linger (REQUIRED — blocking)

```bash
sudo loginctl enable-linger $USER
```

`install-systemd.sh` **refuses to install** if linger is not enabled and
prints this command. Reason (PE Skeptic R2): without linger, the
`systemd --user` manager exits at logout and pi-comms dies with it.
Linger keeps the user manager alive across logout so the daemon survives
SSH disconnects, GUI logouts, and reboots.

Verify linger is on:

```bash
loginctl show-user $USER -P Linger        # expect: yes
```

### Install

```bash
cd path/to/pi-local-llm-provider
scripts/install-systemd.sh             # uses tsx src/daemon.ts
# OR
scripts/install-systemd.sh --built     # uses node dist/daemon.js
```

What it does:

1. Asserts linger.
2. Writes `~/.config/systemd/user/pi-comms.service`.
3. `systemctl --user daemon-reload`.
4. `systemctl --user enable --now pi-comms.service`.

### Unit contents (key posture decisions)

```ini
[Unit]
Description=pi-comms daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env tsx /path/to/repo/src/daemon.ts
WorkingDirectory=/path/to/repo
Restart=on-failure
RestartSec=60
StandardOutput=append:%h/.pi-comms/systemd.stdout.log
StandardError=append:%h/.pi-comms/systemd.stderr.log

[Install]
WantedBy=default.target
```

- `Restart=on-failure` matches launchd's `KeepAlive.Crashed`. Graceful exit
  stays down.
- `RestartSec=60` matches launchd's `ThrottleInterval` and the Windows
  task's RestartInterval — same backoff floor across all three OSes.
- `StandardOutput=append:...` writes to a file that survives across
  restarts. Journal-only output is harder to grep across reboots.

### Verify

```bash
systemctl --user status pi-comms.service
journalctl --user-unit pi-comms.service -f
tail -f ~/.pi-comms/systemd.stderr.log
```

### Debug — common systemd surprises

- **`tsx` not found**: systemd-user has a stripped PATH. The installer
  records your full PATH in the unit's `Environment=` line. If you later
  install `tsx` somewhere new, re-run the installer.
- **Daemon dies at logout**: linger is off. Re-enable
  (`sudo loginctl enable-linger $USER`) then re-run the installer.
- **`After=network.target` fires before WiFi is up**: cosmetic — the
  daemon's Baileys client retries on its own backoff schedule. If you want
  hard ordering, change to `After=network-online.target` and enable
  `systemd-networkd-wait-online.service`.

### Uninstall

```bash
scripts/uninstall-systemd.sh
scripts/uninstall-systemd.sh --dry-run
```

---

## Windows — Scheduled Task

### Pre-step: PowerShell 5.1+ or PowerShell 7

The installer uses `New-ScheduledTask*` cmdlets that ship with both. Use
`pwsh` (PS 7) when available; fall back to `powershell.exe` (PS 5.1).

### Install

```powershell
cd path\to\pi-local-llm-provider
pwsh scripts\install-windows-task.ps1            # uses tsx src\daemon.ts
# OR
pwsh scripts\install-windows-task.ps1 -Built     # uses node dist\daemon.js
```

What it does:

1. Resolves `tsx.exe` (or `node.exe`) on PATH.
2. Builds a Scheduled Task definition with the posture below.
3. `Unregister-ScheduledTask` if a `pi-comms` task already exists.
4. `Register-ScheduledTask -TaskName pi-comms -InputObject $task`.

### Task posture (key decisions)

- **Trigger:** `New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`.
  Triggers ONLY on this user's logon — not at any user's logon.
  Rationale: pi-comms holds per-user secrets and per-user state; another
  user logging in must not launch *your* daemon.
- **MultipleInstancesPolicy: IgnoreNew** (PE Skeptic R2 blocking finding).
  RDP / Fast-User-Switching can produce a second logon for the same
  account. `IgnoreNew` ensures the second logon does not spawn a second
  daemon — the original keeps the IPC socket and the named-mutex lock.
- **RunLevel: Limited** — never `Highest`. The daemon should run with
  least privilege (it does NOT need admin to write `~/.pi-comms/` or talk
  to localhost Studio).
- **RestartInterval: 1 min, RestartCount: 999** — matches launchd
  `ThrottleInterval` + systemd `RestartSec`. Same crash-loop floor on
  all three OSes.
- **ExecutionTimeLimit: 0** — the daemon is meant to run forever; do not
  let Task Scheduler kill it after the default 72h.

### Verify

```powershell
Get-ScheduledTask -TaskName pi-comms | Get-ScheduledTaskInfo
Get-Content $env:USERPROFILE\.pi-comms\windows-task.stderr.log -Wait -Tail 50
```

Or open `taskschd.msc`, navigate to `Task Scheduler Library`, find
`pi-comms`, verify status `Running` and last run result `0x0`.

### Debug — common Windows surprises

- **RDP / Fast User Switching (FUS) edge cases**: with
  `MultipleInstancesPolicy = IgnoreNew` and an `-AtLogOn -User $YOU`
  trigger, the second login session WILL fire the trigger but Task
  Scheduler will discard the start request because the previous instance
  is still running. The OS-native named mutex (`Global\PiCommsDaemon`)
  in the daemon process catches the race if Task Scheduler's check is too
  slow. **Symptom of misconfiguration**: two `node.exe` or `tsx.exe`
  processes for the same user — fix by re-running the installer.
- **Task does not start at boot**: this is a `-AtLogOn` trigger, not
  `-AtStartup`. The daemon starts when YOU log in, not when the box boots.
  This is intentional (per-user secrets in env vars).
- **`tsx.exe` not found**: Task Scheduler resolves the action exe at
  registration time; the path is baked in. Re-running the installer after
  re-installing `tsx` re-resolves the path.
- **Task runs but daemon exits immediately**: read the daemon's own log
  under `%USERPROFILE%\.pi-comms\` — Task Scheduler's "last run result"
  only tells you the OS-level exit code.

### Uninstall

```powershell
pwsh scripts\uninstall-windows-task.ps1
pwsh scripts\uninstall-windows-task.ps1 -DryRun
```

---

## Sandbox notes per OS

The pi-comms daemon enforces sandbox-by-default for the bash tool
(plan §"Phase 3.0 sandbox"). Sandbox state on daemon boot is **always
forced engaged** regardless of any persisted `/unsand` window — see
plan §"v4.2 sandbox state on daemon boot". This installer does not need
to know about sandbox state, but the runtime requires per-OS sandbox
binaries to be available.

| OS | Sandbox mechanism | Install / requirement |
|---|---|---|
| Linux | `bwrap` (bubblewrap) | `sudo apt install bubblewrap` (or your distro's equivalent) |
| macOS ≤ 25 | `sandbox-exec` (built-in) | Pre-installed; no action |
| macOS 26+ | `sandbox-exec` (entitled-only) | `sandbox-exec` exists but Apple gates it behind entitlements on macOS 26+. The daemon falls back to "no-bash-tool" mode and surfaces a clear error. Track Apple's developer entitlement program for upcoming guidance. |
| Windows | AppContainer | **Not implemented in v1**. The daemon refuses to start unless `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true` is set. This is intentional friction so you must consciously accept the lack of OS-level isolation on Windows v1. |

To check whether sandbox binaries are available before installing the
LaunchAgent / unit / task:

```bash
# Linux
command -v bwrap || echo "INSTALL bubblewrap before enabling pi-comms"
# macOS
command -v sandbox-exec  # pre-installed; just verify presence
```

```powershell
# Windows
if (-not $env:PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS) {
    Write-Host "Set PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true to acknowledge"
    Write-Host "the lack of AppContainer sandbox in v1."
}
```

---

## Upgrade procedure

Per plan §"Upgrades":

```bash
# 1. Drain — graceful shutdown waits for in-flight task
pi-comms shutdown
pi-comms status                # asserts daemon-down

# 2. Pull + re-install deps
git pull
npm install

# 3. (Optional) rebuild
npm run build

# 4. Restart
# macOS: launchctl kickstart -k gui/$(id -u)/audio.sergiopena.pi-comms
# Linux: systemctl --user restart pi-comms.service
# Windows: Stop-ScheduledTask -TaskName pi-comms; Start-ScheduledTask -TaskName pi-comms

# 5. Sanity-check
pi-comms doctor                # reports installed version, prompt SHA, models.json schema
```

If you change the install layout (PATH, repo dir, tsx install location),
re-run the installer for your OS to refresh the resolved paths inside the
plist / unit / task XML.

---

## Operator log paths (per OS)

| OS | Lifecycle log (autostart layer) | Daemon's own logs (operator-logger output) |
|---|---|---|
| macOS | `~/.pi-comms/launchd.stdout.log` `~/.pi-comms/launchd.stderr.log` | `~/.pi-comms/operator/*.log` |
| Linux | `~/.pi-comms/systemd.stdout.log` `~/.pi-comms/systemd.stderr.log` (also `journalctl --user-unit pi-comms`) | `~/.pi-comms/operator/*.log` |
| Windows | `%USERPROFILE%\.pi-comms\windows-task.stdout.log` `%USERPROFILE%\.pi-comms\windows-task.stderr.log` (also Task Scheduler "Last run result") | `%USERPROFILE%\.pi-comms\operator\*.log` |

The lifecycle logs (top-level autostart layer) capture daemon stdout/stderr
including any pre-bootstrap exceptions — read these first when the daemon
fails to start. The operator-logger output is for runtime diagnostics once
the daemon is up.

Audit log (always, all OSes): `~/.pi-comms/audit/audit-YYYY-MM-DD.jsonl`
(rotated daily; 90-day default purge — see `pi-comms purge`).
