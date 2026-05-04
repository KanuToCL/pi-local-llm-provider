# Production-side Claude execution briefing

> **Audience:** a fresh Claude Code instance running on Sergio Pena's Windows RTX 5070 production box, picking up after a multi-day Mac-side orchestration.
>
> **Status at handoff (2026-05-03):** 39 commits ahead of `origin/main` (post-Mac-side push), 874 tests passing across 43 files, tsc clean, working tree clean. Plan v4.3 fully implemented; all 21 Ring-of-Elders BLESS gaps closed except one minor partial (RS-6 `recordTerminalAck` auto-call).

---

## 1. Who you are and what shipped

You are a Claude Code instance on Sergio Pena's Windows RTX 5070 + Unsloth Studio production box. The Mac-side Claude orchestrated 19 implementation subagents across 4 waves + 4 audit subagents + 13 Ring-of-Elders subagents + 7 fix subagents (FIX-A wave for HIGH audit findings + FIX-B wave for BLESS-round gaps). The full plan is at `docs/plans/pi_comms_daemon.plan.md` (1648 lines) and converged through v4.3 after a critical-mode 13-elder convene.

What shipped (high level — read `README.md` first for the honest status):

- **`pi-comms` daemon** at `src/daemon.ts` + thin CLI at `bin/pi-comms.ts`
- **Telegram channel** via `grammy` (Phase 1 — primary, tested in mocks)
- **WhatsApp channel** via `@whiskeysockets/baileys@7.0.0-rc.9` exact, dual identity (Model A self-chat + Model B second-number; Phase 5 — untested on real WhatsApp account yet)
- **Sandbox-first defense** via `bwrap` (Linux), `sandbox-exec` (macOS), AppContainer-stub (Windows v1 limitation — daemon refuses to start without `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true`)
- **Destructive-command classifier** as tripwire (~100 rules, 285+ tests)
- **`/unsand` escape hatch** with first-per-session-needs-terminal-ack and tool-derived gating
- **TaskState CAS state machine** with auto-promote re-arm (30s → 2min → 5min cap), cold-start suppression, restore-from-disk for crash recovery
- **`tell()` / `confirm()` / `go_background()`** tools registered via pi-mono `defineTool` + `customTools`
- **Status pointer** with grapheme-aware truncate + sanitization + atomic writes + boot history archive
- **Typed audit log** JSONL with 40+ event kinds, 8KB row cap, daily rotation, retention purge scheduler
- **Operator log** with file persistence + content-off privacy default
- **Heartbeat** message-loop-touched (3-state: healthy/degraded/dead) with armed boot-priming gate
- **Dead-man switch** (cron/scheduled task, ntfy.sh default; pushover/mailgun configurable)
- **Per-OS lifecycle scripts** (launchd/systemd/Windows Scheduled Task) with idempotent install + uninstall + dry-run
- **IPC server** with per-conn auth token (constant-time compare), chmod 0600 socket, pause/resume backpressure
- **14 slash commands** including `/lock` panic-word and terminal-only `/unlock`/`/shutdown`
- **Inbound rate limit** (per-sender + per-channel TokenBucket) wired into both channel ingress paths
- **Phase -1 SDK spike** at `scripts/sdk-spike.ts` (6 probes; Probe 5 specifically verifies pi-mono's `customTools[name='bash']` actually overrides default bash)

## 2. Required reading before any action

In order:

1. **`README.md`** — the honest two-track project description (probe-and-config layer + pi-comms daemon)
2. **`docs/INSTALL.md`** — per-OS install guide
3. **`SECURITY.md`** — risk register R1-R30 (R15-R30 are pi-comms-specific)
4. **`docs/ARCHITECTURE.md`** — four-layer architecture (Studio → pi-local-llm-provider → pi-mono → channels)
5. **`docs/plans/pi_comms_daemon.plan.md`** — the spec source of truth, all 1648 lines including v4 + v4.1 + v4.2 + v4.3 addenda
6. **`ACKNOWLEDGEMENTS.md`** — gemini-claw and pi-mono attribution; useful for understanding why patterns look the way they do

## 3. Pre-flight checklist (verify on this Windows box)

Run these and report results to Sergio. **STOP if any fail.**

```powershell
# Node 20+
node --version

# npm + git available
npm --version
git --version

# Repo synced
cd $HOME\Desktop\Cosas\personal\pi-local-llm-provider  # adjust path if Sergio's setup differs
git pull
git status   # working tree should be clean

# Existing pi-mono CLI installed
pi --list-models

# Studio running on :8888
curl http://localhost:8888/v1/models

# Studio model loaded (the load-bearing check)
curl -H "Authorization: Bearer $env:UNSLOTH_API_KEY" http://localhost:8888/api/inference/status
# Must show "unsloth/Qwen3.6-27B-GGUF" in loaded[]

# Env var set
echo $env:UNSLOTH_API_KEY

# Loaded variant (should be UD-Q4_K_XL minimum for tool-calling)
node scripts\studio-variant.js

# Existing probe still passes
node scripts\probe-toolcalls.js

# Install daemon dependencies
npm install

# Type check + tests on Windows (some tests skip per platform)
npx tsc --noEmit
npx vitest run
```

Expected from `npx vitest run`: ~874 passed, ~7 skipped (platform-gated tests for `sandbox-exec`/`flock`), 0 failed.

## 4. LOCKED decisions (no more questions on these)

- Phase order: **Telegram = Phase 1**, WhatsApp = Phase 5
- v1 identity: **Telegram bot via grammy + BotFather**; no phone pairing required
- WhatsApp Phase 5: dual-identity (Model A self-chat AND Model B second-number); both ship working
- Repo location: `pi-local-llm-provider` (not a sibling repo — daemon code lives inside the existing repo)
- Repo posture: `private: true` in package.json; public GitHub repo under @KanuToCL; no npm publish until v1 stable
- Sandbox: required by default; `/unsand` opt-out per task or windowed (max 120 min)
- Destructive-command classifier: TRIPWIRE only; sandbox is the real defense
- LLM backend: Unsloth Studio with `unsloth/Qwen3.6-27B-GGUF` UD-Q4_K_XL variant

## 5. YOUR FIRST CONCRETE TASK: Phase -1 SDK Verification Spike

The spike at `scripts/sdk-spike.ts` is the gating step. Probe 5 was rewritten in commit `cb86880` to test the actual sandbox-enforceability question (does pi-mono's `customTools[name='bash']` override the default bash tool?). If Probe 5 fails, the entire sandbox design needs a re-plan.

```powershell
# Run the spike on this box
npm run spike

# Inspect output
cat $env:USERPROFILE\.pi-comms\sdk-spike.json

# Commit the result for the historical record
$today = Get-Date -Format "yyyy-MM-dd"
copy $env:USERPROFILE\.pi-comms\sdk-spike.json docs\spike-results\sdk-spike-$today.json
git add docs\spike-results\
git commit -m "spike: pi-mono SDK verification on Windows RTX 5070 ($today)"
```

### Decision tree (per plan §"Phase -1" + §"v4.2 extended scope")

| Outcome | Action |
|---|---|
| All 6 probes pass | STOP. Tell Sergio. Wait for his green light to start Phase 0 testing |
| Probe 1 (symbol presence) — `pi.registerTool` missing | Already known (Mac spike confirmed); architecture pivoted to `defineTool` + `customTools`. Continue |
| Probe 4 (AbortSignal) fails | STOP. SessionManager's `/cancel` flow may not stop pi-mono mid-stream. Re-plan v5: subprocess SIGTERM supervisor |
| Probe 5 (tool_call_interception) FAILS | **STOP, this is load-bearing.** Means `customTools[name='bash']` does NOT override pi-mono's default. The entire sandbox + classifier + `/unsand` design is bypass-able. Re-plan v5: pivot to subprocess + stdout-marker pattern (gemini-claw `CliGeminiClient.ts:122-238` is the precedent) |
| Probe 6 (post-abort callback silence) fails | Phase 1.5 needs daemon-side filter; proceed with that note |

## 6. Stopping criteria — wait for Sergio at these points

- **STOP 1**: After pre-flight checklist (any failure)
- **STOP 2**: After Phase -1 spike completes (Sergio reviews the JSON before any further action)
- **STOP 3**: Before installing OS-level autostart (`scripts/install-windows-task.ps1`); confirm with Sergio first
- **STOP 4**: Before pairing WhatsApp via `scripts/pair-whatsapp.ts`; this requires Sergio's phone interaction

## 7. Phased rollout suggestion (after spike passes)

1. **Telegram-only smoke** — set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` + `UNSLOTH_API_KEY` + `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true` in `.env`. Run `npm run daemon` in foreground. From phone, message the bot. Watch for the daemon-boot banner, telegram_connect audit, `/help` reply.
2. **Run `pi-comms attach --full`** in another terminal to see the full event stream while the daemon is processing your phone messages.
3. **Test `/cancel`, `/status`, `/lock` (then terminal-side `/unlock`)** from phone.
4. **Install Windows Scheduled Task** via `scripts/install-windows-task.ps1` once smoke passes.
5. **Install dead-man switch** via `scripts/install-deadman-task.ps1` (note: `AtStartup` trigger means it doesn't fire until next reboot; manually `Start-ScheduledTask -TaskName PiCommsDeadMan` first time to verify ntfy delivery).
6. **WhatsApp** comes last. Decide identity model (A=self-chat or B=second-number). Run `scripts\pair-whatsapp.ts`; scan QR with phone; verify creds save to `~/.pi-comms/wa-auth/`.

## 8. v5 backlog items still tracked (NOT ship-blockers, future work)

Per `docs/plans/pi_comms_daemon.plan.md` v4.2 §"v5 backlog":

- V5-A — Daytime SIM-swap honesty (shorten `/alive` cadence or document residual)
- V5-B — Confirm-resolves-after-sandbox-reengaged race rule
- V5-D — Phase 4.4 model-warming inbound queue policy (partial — cold-start suppression in auto-promote shipped, but inbound queueing during cold load not yet)
- V5-E — Template system-prompt sandbox path (Windows-portable; current prompt mentions Mac path as example)
- V5-F — Document v1 reliance on bash-tool interception seam (now mostly verified by Probe 5)

Also one partial fix from FIX-B-1: `SessionAckTracker.recordTerminalAck()` is built but not auto-called from successful terminal `/unsand` invocations. The conservative default ("require terminal ack on every `/unsand`") is preserved as v1 behavior — safer to over-prompt than under. Auto-record can land in v1.1 with a small slash-router edit.

## 9. Commit + push protocol so Sergio reviews from Mac

Before each STOP, you MUST:
1. Commit work-in-progress with descriptive message (heredoc style for multi-line)
2. Push to GitHub (this same `pi-local-llm-provider` repo)
3. Tell Sergio the commit SHA + paths to read

## 10. Honest framing

You're inheriting clean state, but real-world testing will surface things the audit + BLESS waves didn't. Specifically:

- **Probe 5 on actual installed pi-mono is THE load-bearing test.** Mac-side spike couldn't run it (no Studio + no installed pi-mono there). If Probe 5 fails on Windows, Sergio's whole sandbox story is in question.
- **Windows AppContainer is unimplemented in v1.** Daemon refuses to boot without `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true`. When that's set, the bash tool runs raw — operator discipline (workspace cwd hygiene, no `/share` after secret exposure) is the only protection. v2 should add Windows Job Objects.
- **Baileys is reverse-engineered WhatsApp Web.** Account ban risk is non-zero. Model B (second-number) localizes the risk. Document the trade-off if you publicize.
- **Heartbeat is healthy-only after first message-loop touch.** First boot will show `armed=false` until the first inbound; that's by design (boot-priming gate prevents spurious `pi_stuck_suspected` audit on startup).

## 11. If you find a real bug

Don't try to "be helpful" by silently fixing it. Surface it to Sergio with the file:line, the symptom, and your proposed fix. He's the principal here. The audit + BLESS rounds caught what they caught; you're the next pair of eyes.

---

**Good luck. The Mac-side orchestration was thorough but no plan survives contact with reality. Report back what breaks first.**
