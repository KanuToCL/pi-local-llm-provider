# pi-comms v0.2.2 — Tracked Followups

> **Source:** Ring-of-Elders BLESS round on shipped v0.2.2 (8 commits `11fd80f` → `<FIX-W5>`).
> **Date:** 2026-05-04
> **Purpose:** Capture deferred-but-tracked items the BLESS round flagged but explicitly chose not to land in v0.2.2.
> **Discipline:** Each item cites the elder + finding ID + file:line so the next session can pick up where this one stopped.

---

## v0.2.2 BLESS final state

| Elder | Verdict | Recommendation |
|---|---|---|
| Architect | BLESS-WITH-CONCERNS | fix-then-ship (N3 + N5 — landed in FIX-W5) |
| **Adversarial** (long pole) | BLESSED-WITH-CONCERNS | **ship — "I am clear"** |
| Testing | BLESSED-WITH-CONCERNS | ship |
| UX Advocate | BLESSED-WITH-CONCERNS | ship |
| PE Skeptic | BLESSED-WITH-CONCERNS | fix-then-ship (NEW-2 + NEW-5 — landed in FIX-W5) |
| Security | **BLESSED** | ship |
| Observability | BLESSED-WITH-CONCERNS | ship |
| Integration | BLESSED-WITH-CONCERNS | ship |
| Data Guardian | BLESSED-WITH-CONCERNS | ship |

**0 NOT-BLESSED. 0 BLOCKERS. The long pole (Adversarial) explicitly cleared.**

---

## v0.2.2 changeset summary (what shipped)

8 v0.2.2 commits closing the v0.2.1 production silent-drop bug + 14 multi-elder convergent items + 8 Adversarial-re-bless findings:

- **Architectural fix (Choice D)** — single-source termination via `await session.prompt()` resolution; subscriber loses termination role; verified from pi-mono source at `agent.js:215-396`.
- **`TaskStateManager.markTerminalAndIdle()` atomic primitive** — owns the running→terminal→idle transition cycle with crash-window safety via `await flush()`.
- **State-machine cyclicity** — `completed`/`failed`/`cancelled` are now ephemeral markers (drained to idle automatically). The v0.2.1 silent-drop trap (CAS to running silently failing because `completed → running` not allowed) is structurally impossible.
- **`task_state_cas_failed` audit + operator log** — silent CAS failures now have a forensic trail. `TERMINAL_RACE_KINDS` includes `"idle"` so cancel/watchdog races demote to debug instead of warn-spam.
- **`task_completed_suspiciously_fast` audit** — defense-in-depth alarm fires when `duration_ms < 100ms`. Would have caught v0.2.1's bug class in CI.
- **`task_state_recovered_on_restart` audit** — emitted at boot if disk shows a terminal state from crash-mid-cleanup.
- **Channel-side observability** — `telegram_inbound` + `whatsapp_inbound` promoted from debug→info, NO content fields, salted hash via injected `senderIdHash` opt.
- **Diagnostic-mode discoverability** — `OPERATOR_LOG_LEVEL=debug` documented in INSTALL.md with 4-point security caveat AND surfaced in daemon startup banner footer.
- **SECURITY.md R31** — documents post-v0.2.2 DoS lock-hold-time increase + v0.3 followup (`taskMaxDurationMs`).
- **9 new regression tests** in `tests/session.test.ts` — including the production-replay regression trap for MIB-2026-05-03-2336.

---

## Deferred — design discussion needed

### #1 — `PI_COMMS_TASK_WATCHDOG_MS` env-var config gap

**Source:** PE Skeptic BLESS NEW-1 + Round-1 S1 (compounding).

**Concern:** `src/session.ts:1048,1098` hard-codes `300_000` as the watchdog default. Operator can only override via constructor opts which `src/daemon.ts:513-555` doesn't pass. Add `PI_COMMS_TASK_WATCHDOG_MS` to `src/config.ts:94-157` env schema + thread to `taskWatchdogMs` in SessionManager construction.

**Why deferred:** small but needs a fresh PR to keep v0.2.2 focused on termination correctness. v0.3 P0.

### #2 — `taskMaxDurationMs` per-prompt hard ceiling (R31 mitigation)

**Source:** PE Skeptic + SECURITY.md R31.

**Concern:** Tool-loop attacks via prompt injection can hold the queue indefinitely because watchdog resets on `tool_execution_start`. The 5min watchdog NEVER fires under continuous tool activity. Need a separate `taskMaxDurationMs` that overrides watchdog reset semantics.

**v0.3 ticket:** add `PI_COMMS_TASK_MAX_DURATION_MS` config + force-failure mechanism in fireWatchdog that ignores tool-execution resets after N minutes.

### #3 — `tryTransition` foot-gun: caller asymmetry vs `markTerminalAndIdle`

**Source:** Architect BLESS N1.

**Concern:** Future implementer reading `tryTransition`'s sync signature will reach for it instead of awaiting `markTerminalAndIdle`. The defense-in-depth `normalizeTerminalState` only covers handleInbound — other code paths could re-introduce v0.2.1's silent-drop bug.

**v0.3 ticket:** either (a) make `tryTransition` REJECT terminal-kind targets at runtime with a clear error message, or (b) rename to `_tryTransitionUnsafe` to mark private intent, or (c) move `tryTransition` to truly private and expose only `markTerminalAndIdle` + a named `idleToRunning` primitive.

### #4 — Operator-log retention sweep

**Source:** PE Skeptic BLESS W3 + W4 + Observability BLESS W4.

**Concern:** `src/utils/operator-logger.ts:159-175` rotates per-day but `src/daemon.ts:888-914` only purges audit log, not operator log. At `OPERATOR_LOG_LEVEL=debug` could reach 360MB/year. Not catastrophic on Pi SD card but unbounded growth is unbounded.

**v0.3 ticket:** add operator-log retention sweep to the daily `runAuditPurge` cycle. Add `PI_COMMS_OPERATOR_LOG_RETENTION_DAYS` env var (default 90, matching audit retention).

### #5 — `senderIdHash` daemon-side wiring (salted hash)

**Source:** Security BLESS W1 (Round-1) + Adversarial BLESS NEW-4 (re-bless v2).

**Concern:** Channels accept optional `senderIdHash` opt + fall back to weak local hash with TODO. Daemon doesn't pass the salted variant. Channel-side audit `sender_id_hash` differs from `AuditLog.senderIdHash` for the same input — cross-correlation breaks.

**v0.3 ticket:** wire `senderIdHash: (id) => AuditLog.senderIdHash(id, installSalt)` into both channel constructors at `src/daemon.ts:589-654`. Remove the weak-hash fallback once daemon always passes.

### #6 — Test injection refactor for Test 7 + Test 5

**Source:** Testing BLESS HIGH NEW-1 + MEDIUM NEW-3 + Architect BLESS N2.

**Concern:** Test 7 monkeypatches `tryTransition` directly; Test 5 monkeypatches `session.prompt`. These work today but break if any await is added to the audit-emit chain or if the harness's bookkeeping changes.

**v0.3 ticket:** add `transitionDecorator?: (next, real) => TransitionResult` opt to TaskStateManagerOpts; add `failurePattern: (iter: number) => boolean` opt to `makeFakeSession`. Refactor the two tests.

---

## NITs — fix opportunistically

### #7 — `task_completed_suspiciously_fast` severity-vs-icon mismatch

**Source:** Observability BLESS WARN.

**Concern:** Operator-log uses `.error` but icon is neutral `⏱️` (stopwatch). Operators tailing log see neutral icon next to error-level line. Either demote to `.info` (the audit row IS the alarm) or change icon to something like `🚨` to match severity.

### #8 — `task_state_recovered_on_restart` lacks boot_phase context

**Source:** Observability BLESS WARN.

**Concern:** Audit emit happens BEFORE SDK load. If SDK throws, the audit row exists but daemon never reaches operational state. Add `extra.boot_phase: "pre_sdk_load"` for forensic provenance.

### #9 — Banner footer alignment 1 char short

**Source:** UX Advocate BLESS NEW-UX-2.

**Concern:** `src/utils/operator-logger.ts:212` — the diagnostic-mode tip line has 4 trailing spaces but body lines have 5. Boot screenshots look slightly off.

### #10 — Banner-only diagnostic hint excludes plain/json log styles

**Source:** Observability BLESS SUGGESTION.

**Concern:** Banner footer renders only in pretty style. Operators on `OPERATOR_LOG_STYLE=plain` won't see the discoverability hint. Consider emitting `operator_log_tip` event after banner.

### #11 — UX serial_queue_blocked notice silently swallows 2nd-Nth follow-ups

**Source:** UX Advocate BLESS NEW-UX-1 (MEDIUM).

**Concern:** 30s cooldown means user sending 5 follow-ups in 10s gets ONE notice ("your follow-up arrived"). Msgs 3-5 are dropped silently (audit-logged but no notice). Consider: drop cooldown to 5-10s OR include count ("your follow-ups (×3) arrived").

### #12 — UX CAS-to-running notice too terse

**Source:** UX Advocate BLESS NEW-UX-3 (LOW).

**Concern:** "pi: failed to start your request — please re-send." If the failure is a tight-loop transient race, user immediately re-sends and triggers more drops. Soften to "pi: hit a transient state-machine race — please wait a moment and re-send."

### #13 — Visual vocabulary glyph collisions

**Source:** UX Advocate BLESS NEW-UX-4 + Observability BLESS WARN + Audit-V2-B BLESS NIT-2.

**Concern:** `♻️` shared by `reset` + `session_recreate` + `task_state_recovered_on_restart`. `🚧` (task_state_cas_failed) and `⏰` (auto_promote_fired/confirm_timed_out) similar visual weight. Consolidate operator-log vocabulary in v0.3.

### #14 — Banner header/footer (50) vs body (54) alignment misalignment

**Source:** Audit-V2-B BLESS NIT-1.

**Concern:** Pre-existing in pre-v0.2.2 commit; not introduced here. v0.3 polish.

### #15 — `extra`-field type safety for state-machine fields

**Source:** Observability BLESS SUGGESTION + Architect BLESS N6.

**Concern:** `task_state_cas_failed.extra.from/to` are open strings; future malformed implementer could pass `"Running"` or `"in_flight"` and break aggregate queries. Add runtime assertion in `emitCasFailure` checking values against `ALLOWED_KINDS` set.

### #16 — `priorState` vs `recovered` consumer-intent doc

**Source:** Architect BLESS N6.

**Concern:** `RestoreResult.priorState` is now used by tests (debug); `recovered` is the audit-consumption path. Add doc clarifying intent.

### #17 — Audit asymmetry between `task_failed` paths

**Source:** Adversarial BLESS SUGGESTION.

**Concern:** `markTaskFailedAndIdle` emits `error_class` only. `fireWatchdog` emits BOTH `error_class` AND `extra.reason`. Forensic queries that look for `extra.reason` miss the handleInbound-throw path.

### #18 — Resilient watchdog handle hygiene

**Source:** Adversarial BLESS MINOR.

**Concern:** `resetWatchdogIfRunning` doesn't null `watchdogHandle` between clear + re-arm. Native `clearTimeoutFn` doesn't throw, but a user-injected mock could. Defensive cleanup.

### #19 — Corrupt persisted state silent drop

**Source:** Adversarial BLESS SUGGESTION.

**Concern:** `task-state.ts:454-462` `hasChannelShape` rejects unknown values; falls through to idle silently. Emit `audit_log_corruption_detected` (already in schema) for forensic correlation.

### #20 — Cross-restart recovery audit duplication (low blast radius)

**Source:** Data Guardian BLESS WARN.

**Concern:** If recovery boot itself crashes mid-flush, next boot emits another `task_state_recovered_on_restart` for same taskId. Mitigated by FIX-W5-B's `await this.flush()` in restoreFromDisk recovery branch. Track if it ever surfaces.

### #21 — `RecoveredTaskInfo.priorKind` lockstep type narrowing

**Source:** Integration BLESS MEDIUM.

**Concern:** If a future deserialize() gains a new terminal kind, `RecoveredTaskInfo` union must extend in lockstep. Add type-level test or exhaustiveness assertion.

### #22 — `RestoreResult` test-harness compatibility

**Source:** Integration BLESS MEDIUM.

**Concern:** `recovered` is non-optional. External test/harness shadowing `taskState.restoreFromDisk` without `recovered: null` will fail TS compilation. Search downstream for shadow patterns.

### #23 — Cyclicity-normalize defense-in-depth rot

**Source:** Integration BLESS LOW.

**Concern:** v0.2.2 contract makes the cyclicity-normalize branch dead code if `markTerminalAndIdle` is always used. Dead defense-in-depth code drifts. Consider an `assert(false, "should never fire post-v0.2.2")` in test mode.

### #24 — Test 1.5 negative case (final-message_end-after-prompt-resolution)

**Source:** Testing BLESS LOW.

**Concern:** Test 1 verifies intermediate message_end events DON'T terminate. No companion test verifying the FINAL message_end (after prompt resolves) ALSO doesn't terminate. Future implementer who re-adds termination only on final event would slip past Test 1.

### #25 — Test 9 production-race coverage gap

**Source:** Testing BLESS MEDIUM.

**Concern:** Test 9 forces state to `completed` directly instead of going through `markTerminalAndIdle` + slow JsonStore write. The cyclicity-guard path is exercised but not the actual production race window. Add a test that injects a slow JsonStore.write to actually race.

---

## Out of scope (no ticket — explicit deferrals)

- **Hard model swap** (re-init agent session on detected change) — v5+
- **`/consult` cloud escalation (V5-G)** — plan rows refined; no implementation in v0.2.2
- **`/setup-comms` wizard (V5-H)** — plan rows refined; no implementation in v0.2.2
- **State-machine decoupling beyond markTerminalAndIdle** — Architect Round-1 W2 design debt
- **A/B prompt rollback via env var** — Adversarial Round-2 conceded; git revert is correct rollback
- **Per-channel inbound log sampling** — addressable v0.3 if volume becomes a concern

---

## Verification commands for the next session

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
git log --oneline -10                    # confirm v0.2.2 commit set
npx tsc --noEmit                         # should be clean
npx vitest run                           # should be 933+/940 + 7 platform-skips + 0 failed
shasum -a 256 prompts/coding-agent.v2.txt  # SHA pin baseline
```

Sergio's manual smoke (Windows post-pull):

1. **Single-message latency**: `pi-comms shutdown && npm run daemon`. Send any single message. Expected: reply lands with NO `📱` prefix; audit shows `task_completed.duration_ms ≥ 100ms`; NO `task_completed_suspiciously_fast` audit row.

2. **Multi-message follow-up (THE bug)**: reproduce MIB-2026-05-03-2336 transcript:
   ```
   say only: i am terminator
   say now: im snow white
   again?
   ```
   Expected: ALL THREE get individual replies. NO silent drops. 3× `task_started` + 3× `task_completed` audit rows with realistic `duration_ms ≥ 100ms`. 0× `task_state_cas_failed`. 0× `pi_stuck_suspected` (per Obs W7 — confirms pi-ping touches mid-stream).

3. **Burst stress**: send 10 messages all at once (paste multi-line). Expected: 1 reply + 9 either rate-limited (per-sender 10/min) OR `pi: still working...` notices (max 1 per 30s/channel). NO silent drops.

4. **Watchdog test**: trigger a long task (vitest full suite via the daemon's bash tool). At 5min mark, expect `system_notice` "previous task didn't emit a terminal event within the watchdog window" + AbortSignal aborts pi-mono (FIX-W5-A change), so no late-reply confusion.

5. **Diagnostic mode**: set `OPERATOR_LOG_LEVEL=debug` in `.env` + restart. Boot banner should show the `tip:` footer line. Subsequent inbounds emit `telegram_inbound` audit + operator-log lines (no content, only `sender_id_hash` + `message_type`).

If smoke fails: switch on `OPERATOR_LOG_LEVEL=debug` per docs/INSTALL.md "Diagnostic mode" + send another MiB.

---

## Production-side checklist for the dev-box

- [ ] BLESS round complete (9 elders, 0 NOT-BLESSED, 0 BLOCKERS)
- [ ] FIX-W5 wave landed (PE NEW-2/NEW-5 + Architect N3/N5 + Adversarial WARNING)
- [ ] v0.2.2 followups doc (this file) written
- [ ] Personal verify final state (tsc + vitest)
- [ ] Commit + push when Sergio approves

---

*Last updated: 2026-05-04 by orchestrator (post-FIX-W5).*
