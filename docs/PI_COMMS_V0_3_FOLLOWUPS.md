# pi-comms v0.3 — Tracked Followups

> **Source:** Ring-of-Elders BLESS round on the v0.3 ship (8 commits — `d6709c4`...`ce5b127` + post-BLESS polish FIX-W5).
> **Date:** 2026-05-05
> **Purpose:** Capture deferred-but-tracked items the BLESS round flagged but explicitly chose not to land in v0.3.
> **Discipline:** Each item cites the elder + finding ID + file:line so the next session can pick up where this one stopped.

---

## v0.3 BLESS final state

| Elder | Round-1 verdict (plan) | Final BLESS verdict (shipped code) |
|---|---|---|
| Architect | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS — all 4 BLOCKERS verified addressed |
| Adversarial | NOT APPROVED → APPROVED W/ CONCERNS in v3 | BLESSED-WITH-CONCERNS — "Ship v0.3" |
| PE Skeptic | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS — "Ship v0.3" |
| Integration | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS — MED-1 (forward-compat test) nullified by grep verification |
| UX Advocate | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS |
| Testing | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS — all 3 BLOCKERS discharged |
| Observability | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS — "Ship v0.3" |
| Security | APPROVED W/ CONCERNS | BLESSED-WITH-CONCERNS — "Ship v0.3" |

**Total: 8/8 BLESSED, 0/8 NOT-BLESSED, 0 BLOCKERs in shipped code.**

Convergent findings folded into FIX-W5 polish commit:
- 3-elder convergence (Adversarial IMP-2 + Obs W1 + Security C1): drop empty `heartbeat_ages_json` from synchronous emit
- 2-elder convergence (Integration NIT-S1 + Security C2): delete stale "INLINE TEMPORARY" comment header
- UX C1: add 7 v0.3 icons to operator-logger registry

---

## Deferred — design discussion needed (v0.4 candidates)

### #1 — Per-Bot undici dispatcher for true TCP isolation across restart()

**Source:** Adversarial v3 narrow re-bless CONCERN-1.

**Concern:** Node 18+ global `fetch` shares an undici Agent / connection pool keyed by origin across the entire process. When `restart()` reconstructs the Bot via `botFactory(token)`, the new Bot's `bot.api` shares the same pooled connection as the old Bot. If the H1/H2 root cause for the production hang is "TCP socket FD leaked into spawned child and is now half-open", reconstructing Bot does NOT discard that pooled connection — the next `getUpdates` may pick the same broken socket.

**Why deferred:** Requires empirical RCA on whether H1/H2 actually involves pooled-socket persistence. The watchdog's restart() already recovers from this in the worst case (just slower than expected — the new Bot eventually picks a fresh connection from the pool when the broken one fails).

**v0.4 ticket:** Pass `clientConfig.baseFetchConfig.dispatcher = new undici.Agent()` per-Bot construction so each restart gets a fresh undici Agent with its own connection pool.

**File:** `src/channels/telegram.ts:441` (`this.bot = this.botFactory(this.botToken)`).

---

### #2 — Outbound TCP staleness watchdog

**Source:** Adversarial Round-1 BLOCKER-2 (deferral after pivot to full Bot reconstruction).

**Concern:** v0.3's `restart()` reconstructs the full Bot, addressing the "outbound `bot.api.sendMessage` shares same TCP as inbound poll" concern at restart time. But the daemon doesn't actively monitor outbound health between restarts — if outbound starts failing while inbound polling stays healthy, the watchdog won't notice.

**Why deferred:** Outbound failures already log via `telegram_send_error` operator-log + the user notices a missing reply → manual restart. Active monitoring is defense-in-depth, not load-bearing.

**v0.4 ticket:** Track last-successful-`sendMessage` timestamp; if > N minutes since last successful outbound (and outbound was attempted), trigger `restart("outbound_silent_too_long")`.

**File:** `src/channels/telegram.ts:377` (sendMessage call site) + `src/daemon.ts` watchdog.

---

### #3 — `sendMessage` in-flight queue with restart-aware dispatch

**Source:** PE Skeptic v3 BLESS C1.

**Concern:** Per Pitfall #2 in plan v3: orphan-sendMessage during restart. An in-flight `bot.api.sendMessage` against the OLD `bot.api` can resolve AFTER reconstruction; v0.3 logs `telegram_send_error` and continues. Multi-chunk replies can fragment silently mid-restart (chunk 1 sent successfully, chunk 2 errors mid-restart).

**Why deferred:** Per `Sink` "best-effort" contract; rare path (requires restart during multi-chunk reply). Operator notices via missing reply and can re-prompt.

**v0.4 ticket:** Track outbound chunks in a queue; on restart, hold queued chunks and replay to new bot.api. Surface via `/status`.

**File:** `src/channels/telegram.ts:520-540` (chunked send loop).

---

### #4 — Per-source heartbeat thresholds

**Source:** Plan v3 §G3 dropped per Architect dissent (YAGNI).

**Concern:** If a future failure mode produces partial-stale heartbeat (e.g., `baileys-poll` fine, `telegram-poll` silent under thresholds the global default doesn't catch), per-source thresholds become useful.

**Why deferred:** YAGNI for v0.3. The G1 Transformer fix removed the F2 false-positive root cause cleanly.

**v0.4 ticket:** Add `perSourceThresholds?: Partial<Record<HeartbeatSource, { healthyMs, degradedMs }>>` to `HeartbeatOpts`.

**File:** `src/lib/heartbeat.ts:60-100`.

---

### #5 — Heartbeat source rename `telegram-poll` → `telegram-poll-attempt`

**Source:** Adversarial Round-1 NIT-2.

**Concern:** Post-v0.3, `telegram-poll` heartbeat source semantically means "poll-attempt success" (was "update receipt"). The source name still says "telegram-poll". Operator semantics drift.

**Why deferred:** Schema migration cost vs operator-comprehension benefit. The semantic shift is documented in `docs/audit-log-query-playbook.md` §1.

**v0.4 ticket:** Rename the HeartbeatSource enum value + migrate audit consumers.

**File:** `src/lib/heartbeat.ts:53` (closed enum).

---

### #6 — Switch to `@grammyjs/runner`

**Source:** Adversarial Round-1 alternative path.

**Concern:** grammY's official runner exposes runtime hooks the daemon could use — a more elegant solution than the Transformer-based approach if subclass approach proves brittle.

**Why deferred:** Dependency add not warranted while Transformer-based approach works. Defer until a v0.3 production limitation surfaces.

**v0.4 ticket:** Evaluate `@grammyjs/runner` integration cost vs marginal benefit.

**File:** `src/channels/telegram.ts` (Bot construction site).

---

### #7 — `unknownEventBehavior: 'skip' | 'throw'` config knob for audit replay

**Source:** PE Skeptic Round-1 IMPORTANT-6 + Integration v3 narrow re-bless.

**Concern:** v0.3 audit `event` field is `z.string()` for forward-compat (replay v0.4 events on v0.3 daemon). But there's no operator-controlled fallback if a future event kind contains malformed data. Per Integration: external consumers doing `assertNever(audit.event)` exhaustive switch break silently on unknown events.

**Why deferred:** No external consumers exist today.

**v0.4 ticket:** Add config knob; document in audit-log-query-playbook.md.

**File:** `src/audit/log.ts` parser.

---

## Followups — small cleanup tasks

### #8 — `telegram_poll_silent_burst` defense-in-depth catcher

**Source:** Observability v3 BLESS S1.

**Concern:** v0.2.2 added `task_completed_suspiciously_fast` as the v0.2.1 catcher. v0.3 needs the equivalent — a metric that would fire if a future refactor accidentally re-introduces "heartbeat only on update-delivered" semantics.

**v0.4 ticket:** Fire `telegram_poll_silent_burst` audit event when `lastPollAttemptMonotonicMs` mirror is updated but the gap from the previous mirror update exceeds `pollTimeoutMs * 1.5` while bot is `isConnected()`. Mirrors `task_completed_suspiciously_fast`'s "watch the inverse-of-the-bug-fixed metric" pattern.

**File:** `src/daemon.ts` watchdog `notePollAttempt()` method.

---

### #9 — `restart()` log line ordering documentation

**Source:** Adversarial v3 BLESS IMPORTANT-1.

**Concern:** FIX-B's fire-and-forget snapshot post-decision means `telegram_poll_stale_restart_full_snapshot` (with full ages) may land AFTER `telegram_poll_stale_restart` (without ages) AND can land out-of-order vs subsequent watchdog ticks. Forensic timeline ordering is correlative not strictly causal.

**v0.4 ticket:** Tag the deferred snapshot log line with `tick_seq` or `decision_at_monotonic_ms` so post-incident review can re-order. Document in playbook §3.

**File:** `src/daemon.ts` `checkLiveness()` snapshot enrichment.

---

### #10 — `lastPollAttemptMonotonicMs` reset/transformer-fire race

**Source:** Architect v3 BLESS W1.

**Concern:** `daemon.ts:499` resets the monotonic mirror to `monotonicMs()` on successful restart. If a fresh Bot's transformer fires concurrently between `await restartP` resolving and the `.then()` running, the mirror could be SET by transformer then OVERWRITTEN backward by the `.then()`. Net effect: tiny age delta, never a stale-restart loop. Cosmetic.

**v0.4 ticket:** Add a brief code comment noting the benign reset/transformer-fire race.

**File:** `src/daemon.ts:499`.

---

### #11 — `restart_giving_up` audit twin asymmetry

**Source:** Observability v3 BLESS W3.

**Concern:** `telegram_restart_giving_up` fires operator-log only ONCE on cooldown entry. `telegram_restart_skipped` audit fires on EVERY tick during cooldown. A jq histogram of `telegram_restart_skipped` could be misleading.

**v0.4 ticket:** Either suppress repeated audit rows during cooldown OR document the asymmetry in playbook §3.

**File:** `src/daemon.ts` `checkLiveness()` cooldown path.

---

### #12 — `monotonicNs()` precision for sub-ms callers

**Source:** AUDIT-G1 NIT-2.

**Concern:** `process.hrtime.bigint()` returns nanoseconds; integer division by `1_000_000n` floors to ms. Acceptable for restart latency + stall windows but a v0.4 caller wanting microsecond precision would be surprised.

**v0.4 ticket:** Add `monotonicNs()` only if/when needed.

**File:** `src/lib/clock.ts`.

---

### #13 — `EXPECTED_SHA256_V3` length defensive assertion

**Source:** Testing v3 BLESS suggestion.

**v0.4 ticket:** Assert `EXPECTED_SHA256_V3.length === 64` defensively. One LOC.

**File:** `tests/system-prompt.test.ts`.

---

### #14 — Stop-during-pending-handler microtask test

**Source:** Testing v3 BLESS B3 micro-gap.

**Concern:** No test for "channel.stop() called while inside a pending handler microtask". Single-threaded event loop bounds the risk; documented for completeness.

**v0.4 ticket:** Add a focused test that documents the contract.

**File:** `tests/channels/telegram.test.ts`.

---

### #15 — `tsc` execution debt

**Source:** Integration v3 BLESS MED-2.

**Concern:** Integration elder noted they couldn't run `tsc --noEmit` from the read-only review environment. Orchestrator (this orchestrator) ran it personally — clean.

**Status:** Discharged by orchestrator personal-verify. No action needed.

---

### #16 — `WatchdogHeartbeat` interface duplication

**Source:** AUDIT-G2 NIT-6.

**Concern:** `WatchdogHeartbeat` re-declares `{state, ages, fileAgeMs}` instead of `Pick<HeartbeatSnapshot, ...>`. Drift risk if `Heartbeat.snapshot` adds a field.

**v0.4 ticket:** Use `Pick<HeartbeatSnapshot, "state" | "ages" | "fileAgeMs">` import.

**File:** `src/daemon.ts:198-203`.

---

### #17 — Harness drain marker uses production audit event name

**Source:** AUDIT-G2 MINOR-4.

**Concern:** `tests/integration/daemon-test-harness.ts:336-344` uses real `audit_log_corruption_detected` event name as a benign sentinel. Future test that adds an audit-corruption assertion may see the ghost row.

**v0.4 ticket:** Use a string event name the schema accepts but production never emits, e.g. `"_harness_drain_marker"`.

**File:** `tests/integration/daemon-test-harness.ts`.

---

### #18 — Test for "no parallel restart" needs to advance monotonic time first

**Source:** AUDIT-G2 MINOR-5.

**Concern:** The success-path test for "next tick after fresh poll-attempt should NOT fire" never advances monotonic time before the final `checkLiveness`. The assertion would pass even without the success-resets-mirror logic.

**v0.4 ticket:** Advance monotonic by `< staleMs` first to genuinely verify the mirror was reset.

**File:** `tests/integration/telegram-restart.test.ts`.

---

### #19 — Late-timeout absorption test

**Source:** Adversarial v3 BLESS test gap.

**Concern:** Tests verify the timeout fires AND clears state, but no test for the specific race "timeout fires AFTER restart resolves" (timeoutP rejects post-restartP-success). Promise.race semantics handle it but the assertion isn't enforced.

**v0.4 ticket:** Add a test: setManualResolution(true), fire restart, resolveNextRestart(), then `fireSetTimeoutsAfter(240_001)` AFTER — assert `_getConsecutiveFailures()` stays 0.

**File:** `tests/integration/telegram-restart.test.ts`.

---

### #20 — `hashSenderId` weak-hash fallback removal

**Source:** Adversarial v3 BLESS NIT-B.

**Concern:** `src/channels/telegram.ts:1001-1010` retains the local `hashSenderId` fallback with `TODO(v0.3): remove the fallback` — v0.3 is shipping; the TODO should be re-dated to `TODO(v0.4)` or actually removed.

**v0.4 ticket:** Re-date or remove the TODO; consolidate hashSenderId to a single salted source.

**File:** `src/channels/telegram.ts:1001-1010`.

---

### #21 — `AuditEventType` dual-meaning deprecation

**Source:** AUDIT-G7+G9 NIT.

**Concern:** `src/audit/schema.ts:185-186` exports `AuditEventType` as both a value (alias of `AuditEventTypeSchema`) and a type. Backward-compat shim from v0.2.2.

**v0.4 ticket:** Deprecate the value-export; migrate consumers to `AuditEventTypeSchema`.

**File:** `src/audit/schema.ts:185-186`.

---

### #22 — Vocabulary coherence introduction in playbook

**Source:** UX v3 BLESS suggestion.

**Concern:** v0.3 added 8 names in the `telegram_restart` family. While each is semantically distinguished + the playbook §3 maps them onto 3 incident patterns, a new operator faces cognitive load.

**v0.4 ticket:** Add a §0 "telegram restart family" introduction to the playbook before §1 to introduce the 8-name vocabulary.

**File:** `docs/audit-log-query-playbook.md`.

---

### #23 — Native Windows `HANDLE_FLAG_INHERIT=false` enforcement

**Source:** Plan v3 §"Out of scope" (deferred from v0.3).

**Concern:** H1 mitigation if libuv defaults insufficient (per MIB-2026-05-05-1751 §4 H1).

**v0.4 ticket:** Native addon to enforce `HANDLE_FLAG_INHERIT=false` on Windows. Defer until empirical RCA on whether H1 is actually the root cause.

**File:** `src/sandbox/exec.ts`.

---

### #24 — Bash POSIX→cmd.exe rewriter (V2)

**Source:** Plan v3 §"Out of scope" (dropped from v0.3 per Adversarial B4/B5 data destruction risk).

**Concern:** Future v0.4 could ship a SAFER pattern table OR replaced by "block + suggest" model (Architect Round-1 I1 Option C — error to agent rather than silent rewrite).

**v0.4 ticket:** If F3-A prompt-only doesn't suffice in production, design a safer rewriter (block + suggest mode).

**File:** `src/sandbox/wrap-bash.ts`.

---

### #25 — `${HOST_OS}` placeholder regex defense-in-depth

**Source:** AUDIT-G4 informational nit.

**Concern:** `composeSystemPrompt` post-substitution scan uses `.includes("${HOST_ENV_SECTION}")` + `.includes("${HOST_OS}")` (hardcoded literal token list). Future v4 prompt that introduces a new `${FOO_BAR}` placeholder would need to update the literal list. A regex-based fallback like `/\$\{[A-Z_]+\}/` would be a safety net for any unsubstituted placeholder.

**v0.4 ticket:** Add the regex fallback as defense-in-depth.

**File:** `src/lib/system-prompt.ts:160`.

---

### #26 — Audit-log forensic limitations §

**Source:** Observability v3 BLESS W2.

**Concern:** Transformer-pivot loses per-poll error context (offset, retry count, time-since-last-success). grammY's internal `bot.catch` is the source; our visibility is limited.

**v0.4 ticket:** Add §"Known forensic limitations" entry to the audit-log-query-playbook.md so a 3 AM oncall doesn't waste 20 minutes hunting for missing context.

**File:** `docs/audit-log-query-playbook.md`.

---

## Out of scope (no v0.4 ticket — explicit deferral)

- **Multi-tenant SaaS hardening** — pi-comms is single-user by design. v0.3's worst-case time-to-recovery from hung-restart (~390s) is acceptable for operator-on-phone semantics; not for multi-tenant.
- **Full UX vocabulary review** — the v0.2.1 followup #7 ("dedicated UX pass after dogfooding feedback") still applies. Defer until production usage produces operator complaints.
- **Audit log retention size cap** — current 90-day default works at single-user volume; revisit if multi-user.

---

## Verification commands for the next session

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
git log --oneline | head -12          # confirm v0.3 commit set + FIX-W5 polish
npx tsc --noEmit                       # should be clean
npx vitest run                         # ~1005/1005 pass + 7 platform-skip + 0 fail
sha256sum prompts/coding-agent.v3.txt  # matches EXPECTED_SHA256_V3 in tests
```

Sergio's manual smoke (production deploy box) — see MiB-2026-05-XX dev-box reply for canonical smoke instructions:
1. Smoke 1 (single-message latency, sanity)
2. Smoke 2 (canonical 3-message regression — MiB-2026-05-03 transcript)
3. Smoke 3 (bash-heavy hang + watchdog recovery if hang reproduces)

---

*Last updated: 2026-05-05 by orchestrator (post-BLESS-round-2 + FIX-W5 polish).*
