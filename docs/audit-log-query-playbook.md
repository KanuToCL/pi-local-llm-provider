# Audit-log query playbook (post-v0.3)

> **Purpose.** Forensic recipes for the `~/.pi-comms/audit/audit.YYYY-MM-DD.jsonl`
> stream after the v0.3 polling-resilience changes landed.
>
> **Audience.** Operators investigating an incident on a daemon that has been
> running v0.3 (or later). If you're on v0.2.x, see the v0.2.2 followups doc
> instead — the semantics in §1 below do NOT apply pre-v0.3.

---

## §1 — Semantic shifts in v0.3

The v0.3 wave changed what two audit kinds *mean* in production. Internalise
this before paging on either of them.

### `pi_stuck_suspected stale_source=telegram-poll`

| | Pre-v0.3 (v0.2.x) | Post-v0.3 |
|---|---|---|
| **Trigger** | The `telegram-poll` heartbeat was only refreshed when an *update was delivered* (i.e. someone messaged the bot). A 10-minute idle window with zero inbound DMs was indistinguishable from a wedged poller. | The `telegram-poll` heartbeat is refreshed on every successful `getUpdates` long-poll resolve — empty *or* with updates. A stale heartbeat now genuinely means the polling layer is wedged. |
| **Operator interpretation** | NOISY. False-positives during legitimate quiet hours were the dominant cause of these rows. Most of them resolved themselves when the next inbound finally arrived. | ACTIONABLE. If you see this row, the polling layer is silent for longer than `telegramPollWatchdogStaleMs` (default 120s). The G2 watchdog will attempt `restart()` automatically; if that also fails repeatedly the bot will go dark. Investigate immediately. |
| **Self-healing** | None — relied on next inbound to refresh. | Yes — the daemon-side watchdog calls `telegramChannel.restart()` (full Bot reconstruction including a fresh `bot.api` for outbound TCP recovery) on stale-detection. See incident-pattern §3 below. |

### `pi-ping` (unchanged)

The `pi-ping` heartbeat source still means "the embedded pi-mono session is
making progress" — same semantics as v0.2.x. A stale `pi-ping` typically
points to model inference or sandbox-exec being stuck, not to the polling
layer. The v0.3 changes do not touch `pi-ping`.

### Other heartbeat sources

`baileys-poll` (WhatsApp) retains its v0.2.x semantics in v0.3 — it has not
been migrated to a poll-attempt model yet (tracked in
`docs/PI_COMMS_V0_3_FOLLOWUPS.md`). A stale `baileys-poll` is still
ambiguous between "wedged" and "legitimately quiet" the same way Telegram
was pre-v0.3.

---

## §2 — Forensic jq one-liner

The canonical filter for any post-v0.3 polling/restart incident:

```bash
jq -c 'select(
  .event=="telegram_restart"
  or .event=="telegram_restart_failed"
  or .event=="telegram_restart_skipped"
  or .event=="pi_stuck_suspected"
  or .event=="telegram_disconnect"
) | {ts, event, reason: (.extra.reason // .extra.stale_source), task_id}' \
  ~/.pi-comms/audit/audit.*.jsonl
```

The projection collapses the two distinct payload shapes (the watchdog uses
`extra.reason`; the heartbeat code uses `extra.stale_source`) into one
`reason` column for grep-friendly output. `task_id` is included so you can
correlate restarts against in-flight tasks.

### Scoping by date range

The jsonl files rotate daily and are named `audit.YYYY-MM-DD.jsonl`. To scope
a single day, glob the date directly:

```bash
jq -c '...' ~/.pi-comms/audit/audit.2026-05-05.jsonl
```

For an arbitrary range, prefer a shell-side glob (cheap) over a jq-side
timestamp comparison (loads the full stream):

```bash
# Last 7 days
ls -t ~/.pi-comms/audit/audit.*.jsonl | head -7 | xargs jq -c '...'
```

For sub-day windows, add a jq-side timestamp filter inside the existing
`select()`:

```bash
jq -c 'select(
  (.ts >= "2026-05-05T14:00:00Z" and .ts < "2026-05-05T15:00:00Z")
  and (.event=="telegram_restart" or ...)
) | {...}' ~/.pi-comms/audit/audit.2026-05-05.jsonl
```

ISO-8601 timestamps sort lexically, so `>=` / `<` string comparison is
correct.

---

## §3 — Common incident patterns (post-v0.3)

Three canonical patterns cover ~all v0.3 telegram-side incidents. Match
your audit grep against one of them before paging:

### Pattern A — Self-healing watchdog (no operator action needed)

```
ts=T0   event=pi_stuck_suspected     reason=telegram-poll
ts=T0+s event=telegram_restart       reason=poll_silent_too_long
ts=T1   <next inbound resumes; bot processes it normally>
```

The watchdog detected stale poll-attempt heartbeat, called
`telegramChannel.restart()`, the restart succeeded (no
`telegram_restart_failed` row), and inbound traffic resumed. **This is the
v0.3 design working as intended** — log it for posterity, do not page.

Operator-log evidence: matching `telegram_restart_initiated` (warn) and
`telegram_restart_completed` (info) entries with a `latency_ms` field.

### Pattern B — Restart cycles failed (operator action needed)

```
ts=T0   event=pi_stuck_suspected      reason=telegram-poll
ts=T0+s event=telegram_restart        reason=poll_silent_too_long
ts=T0+s event=telegram_restart_failed reason=poll_silent_too_long  (× ≥1)
... watchdog retries within cooldown window ...
ts=Tk   event=telegram_restart_skipped reason=consecutive_failures_exceeded
```

Three consecutive `telegram_restart_failed` rows trip the cooldown brake
(default 10 min, see `telegramRestartFailureCooldownMs`). After that the
watchdog enters a backoff and emits `telegram_restart_skipped` rows
instead of attempting further restarts. The matching operator-log row is
`telegram_restart_giving_up` (error level) with `failures` and `cooldown_ms`
fields.

**Operator action.**
1. Check the bot token is still valid (visit @BotFather, confirm token is
   listed). A revoked token surfaces here as the failure cascade.
2. Check network connectivity from the daemon host to `api.telegram.org`
   (TCP 443). A broken upstream surfaces here.
3. If both look fine, read the operator log for the `error_class` field on
   each `telegram_restart_failed` row — that names the underlying exception
   class (e.g. `GrammyError`, `HttpError`, `Error`).
4. Mitigation: re-issue the token in @BotFather if revoked, fix the network,
   then `pi-comms shutdown && <re-launch>` to clear the cooldown state.
   The watchdog cooldown does NOT persist across daemon restarts (it lives
   in-memory on `Daemon.restartCooldownUntil`).

### Pattern C — `pi_stuck_suspected` with no `telegram_restart` follow-up

```
ts=T0   event=pi_stuck_suspected reason=telegram-poll
ts=T1   <no telegram_restart row appears, ever>
```

This means one of:
- The G2 watchdog is disabled (operator set `telegramPollWatchdogTickMs`
  intentionally large or there's a config-load error — check operator log
  at boot).
- The daemon entered shutdown between the stuck-suspected detection and
  the watchdog's next tick (the shutdown CAS guard bails the watchdog
  before it dispatches a restart).
- The `telegramRestartInFlight` guard is held by a still-pending earlier
  restart that hasn't resolved or failed yet (rare; `restart()` has a hard
  timeout in v0.3 G2 — check operator log for `telegram_restart_failed
  error_class=TimeoutError`).

**Operator action.** Confirm the daemon is still running
(`pi-comms status`). If it is, read the most recent operator-log entries
for either `telegram_poll_watchdog_error` (warn — watchdog tick threw) or
`telegram_restart_giving_up` (error — already cooled down). If neither is
present and the daemon is up, file a bug — the watchdog should have fired.

---

## §4 — Cross-reference

- **R32** (audit log volume amplification) and **R33** (host-OS prompt
  injection) in `SECURITY.md` — threat model entries that this playbook
  helps detect operationally.
- `docs/INSTALL.md` §"Diagnostic mode" — operator note on the v0.3
  semantic shift.
- `docs/PI_COMMS_V0_3_FOLLOWUPS.md` (when it lands) — deferred work
  including outbound-TCP staleness watchdog and `baileys-poll` migration.
- `~/.llms/plans/pi_comms_v0_3_polling_resilience.plan.md` §3.1 — the
  source-of-truth plan section that mandated this playbook.
