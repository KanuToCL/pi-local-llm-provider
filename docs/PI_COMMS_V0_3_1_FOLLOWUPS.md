# pi-comms v0.3.1 — Tracked Followups

> **Source:** Ring-of-Elders FINAL BLESS round on shipped v0.3.1 (8 commits — `ff1c035` → `43a9de7`).
> **Date:** 2026-05-10
> **Purpose:** Capture deferred-but-tracked items the BLESS round flagged but explicitly chose not to land in v0.3.1.
> **Discipline:** Each item cites the elder + finding ID + file:line so the next session can pick up where this one stopped.

---

## v0.3.1 BLESS final state

| Elder | Verdict |
|---|---|
| Architect | BLESSED-WITH-CONCERNS — all 5 R1 BLOCKERS verified resolved |
| Adversarial | BLESSED-WITH-CONCERNS — all R1+R2 BLOCKERS verified; 1 MED (handleRef race) + 3 LOW |
| PE Skeptic | BLESSED-WITH-CONCERNS — all R1 BLOCKERS verified; 2 new concerns |
| Integration | BLESSED — all R1 BLOCKERS verified; 2 small followups |
| UX Advocate | BLESSED-WITH-CONCERNS — all R1 BLOCKERS verified; 1 carryover concern |
| Testing | BLESSED — all R1 BLOCKERS verified; 4 non-blocking concerns |
| Observability | BLESSED-WITH-CONCERNS — 5 forensic concerns |
| Security | BLESSED — all R1+R2 BLOCKERS verified; 3 suggestions |

**Total: 3 BLESSED, 5 BLESSED-WITH-CONCERNS, 0 NOT-BLESSED, 0 BLOCKERS in shipped code.**

---

## v0.3.1 changeset summary (what shipped)

10 commits closing GB10 MIB-2026-05-09-{0103, 1126, 2305} findings:

| SHA | What |
|---|---|
| `bf777d7` | plan v1 (pre-elder) |
| `0f5974d` | plan v2 (folded Round 1 — 13 convergent findings) |
| `e8d0bac` | plan v3 (folded Round 2 Adversarial NB-1..NB-4) |
| `80f3cd5` | plan v3 final (Adversarial I-B fix) |
| `ff1c035` | W1.0 — audit schema kinds: `sandbox_denial_loop_broken` + `daemon_boot_failed` |
| `e95fe9a` | docs IMPL-2 (GB10 §5B + followup #27 + R34 + R35); also captured IMPL-7 files (wave-collision, content correct) |
| `786085f` | F3a — `BashToolResult.details.sandboxDenied` flag in wrap-bash from canonical stderr markers |
| `c84ec4a` | F1+F2 — drop daemon `pi: ✅ done.` prefix from `formatChannelEvent` (BOTH telegram + whatsapp) + defensive strip |
| `7aea83e` | F7 — vLLM opt-in scaffolding (apiKey env-var, authHeader, version pinned 0.6.5) |
| `5d638bf` | F8 — daemon signal handler distinguishes boot vs runtime; `daemon_boot_failed` audit; `STUDIO_MODEL_WAIT_MS` lifted to DaemonOpts |
| `c026364` | F3b — sandbox-denial loop-breaker counter + injection + icon |
| `43a9de7` | post-AUDIT-D — `pi-comms run` propagates attach-failure exit code |

**Test count: 1047/1054 pass + 7 platform-skip + 0 fail.** Test count delta: +44 net-new tests (target ≥25, exceeded).

---

## Deferred — convergent findings (multi-elder agreement)

### #1 — Observability C-O1: audit playbook stale; F3/F8 events invisible

**Source:** Observability BLESS C-O1.

**Concern:** `docs/audit-log-query-playbook.md:47-54` jq one-liner only selects `telegram_restart*` family. New events `sandbox_denial_loop_broken` and `daemon_boot_failed` are invisible. Operator following the playbook verbatim sees zero rows for an F3 sandbox-loop incident or F8 boot failure → wrong conclusion.

**v0.3.2 ticket:** Extend §2 jq projection + add §3 Pattern D (sandbox-denial loop) and §3 Pattern E (boot-time studio failure). Doc-only.

**File:** `docs/audit-log-query-playbook.md`.

---

### #2 — Observability C-O2: `daemon_boot_failed` never reaches operator-log

**Source:** Observability BLESS C-O2.

**Concern:** `src/daemon.ts:862-901` (studio-model-load-timeout path) emits the audit row + writes 3 lines to stderr, but does NOT call `operatorLogger.error("daemon_boot_failed", ...)`. The 💔 icon registered at `src/utils/operator-logger.ts:178` for that event has no firing call site. Operators with `OPERATOR_LOG_FILE=...` lose the boot-failure event from their persisted operator log.

**v0.3.2 ticket:** Add `operatorLogger.error("daemon_boot_failed", { reason, studio_url, configured_model_id, timeout_ms })` immediately before the audit append in `bootAfterLock`.

**File:** `src/daemon.ts:881-895`.

---

### #3 — Adversarial MED-A / Architect W-1: handleRef race window

**Source:** Adversarial MED-A + Architect W-1.

**Concern:** Between `bootCompleted = true` (`src/daemon.ts:1384`) and `handleRef.current = handle` (line 1641), ~257 lines of post-bind init code execute. A SIGTERM in this window enters the runtime branch but reads `handleRef.current === null` and falls into the defensive `process.exit(2)` — ungraceful exit with no shutdown drain. Comment at line 806 ("should be unreachable") is incorrect.

**v0.3.2 ticket:** Move `handleRef.current = handle` immediately after `bootCompleted = true` (or wrap post-bind work in a separate function), OR introduce `inPostBindInit` intermediate state.

**File:** `src/daemon.ts:1384` + `:1641` + `:806`.

---

### #4 — Observability C-O3: F8 audit row uses `extra.timeout_ms` instead of top-level `duration_ms`

**Source:** Observability BLESS C-O3.

**Concern:** `src/daemon.ts:891-894` puts the configured timeout in `extra.timeout_ms`. The audit schema reserves top-level `duration_ms` for elapsed-wall-time on time-spanning events (`src/audit/schema.ts:249`). Result: (1) recorded value is configured budget, not actual elapsed wait; (2) `jq 'select(.duration_ms > 60000)'` for "what slow operations happened today" silently misses boot timeouts.

**v0.3.2 ticket:** Capture actual elapsed wait in `bootAfterLock`, write top-level `duration_ms: actualElapsedMs`. Keep `extra.timeout_ms` for the configured value (useful for forensics).

**File:** `src/daemon.ts:881-895`.

---

### #5 — Observability C-O4: `daemon_boot_aborted_by_signal` operator event has no icon

**Source:** Observability BLESS C-O4.

**Concern:** `src/daemon.ts:784` emits `daemon_boot_aborted_by_signal` but no icon registered in `src/utils/operator-logger.ts`. Falls through to severity-default `⚠️`.

**v0.3.2 ticket:** Reuse 💔 (semantically equivalent to `daemon_boot_failed`) or add 🛑.

**File:** `src/utils/operator-logger.ts:178`.

---

### #6 — Observability C-O5: F8 signal-handler audit append fire-and-forget

**Source:** Observability BLESS C-O5.

**Concern:** `src/daemon.ts:785-797` queues the audit append then chains `.finally(() => process.exit(2))`. AppendFile passes through libuv thread pool; a slow disk + queued long-running write can lose the row when `process.exit` preempts the kernel page-cache flush. Audit log is intentionally not fsync'd per `src/audit/log.ts:23-26`.

**v0.3.2 ticket:** Bound the wait — `await Promise.race([appendP, sleep(2000)])` so wedged disk doesn't block exit forever, but row lands in the typical case.

**File:** `src/daemon.ts:785-797`.

---

### #7 — Adversarial LOW-A: `pi: pi: ok` double-prefix when model emits literal `pi: ✅ done.` as `finalMessage`

**Source:** Adversarial BLESS LOW-A.

**Concern:** `formatChannelEvent({type: "task_completed", finalMessage: "pi: ✅ done."})` produces `"pi: pi: ok"` because the NB-4 fallback returns `"pi: ok"` and the task_completed branch wraps with `pi: ${...}`. Cosmetic but ugly.

**v0.3.2 ticket:** Either (a) make NB-4 fallback return `"ok"` (caller adds prefix) or (b) special-case the task_completed branch to detect `"pi: ok"` from the helper.

**File:** `src/lib/sanitize.ts:266` + `src/channels/telegram.ts:981` + `src/channels/whatsapp.ts:1343`.

---

### #8 — Adversarial LOW-B / Testing C1: F8 hermetic test doesn't exercise SIGTERM-during-boot path

**Source:** Adversarial BLESS LOW-B + Testing C1.

**Concern:** `tests/integration/run-cli-boot.test.ts` covers the `studio_model_load_timeout` reason but never sends SIGTERM during boot. The `boot_aborted_by_signal` reason at `src/daemon.ts:792` exists in code but is never asserted by any test. A future regression in `earlySignalHandler` would not be caught.

**v0.3.2 ticket:** Add a third test case using a slow-readiness stub + `process.emit('SIGTERM')` from the test, asserts `boot_aborted_by_signal` audit row.

**File:** `tests/integration/run-cli-boot.test.ts`.

---

### #9 — UX Advocate I-UX-1 carryover: F1 daemon-prefix-drop user-facing implication not communicated

**Source:** UX Advocate Round 2 I-UX-1 + BLESS.

**Concern:** Long-running task replies no longer prefix `✅ done.` — the daemon used to add this; users may have built mental shortcuts on the prefix. No release notes / CHANGELOG / §5B note announces the change. Users discover by observation.

**v0.3.2 ticket:** Add a 2-line note to this followups doc OR create a v0.3.1 release-notes section in README — e.g. "Long-running task replies no longer prefix `✅ done.` — the daemon used to add this, but the local Qwen model began over-generalizing the marker onto failure replies (MIB-2305 §1)."

**File:** `docs/PI_COMMS_V0_3_1_FOLLOWUPS.md` (this file) or `README.md`.

---

### #10 — PE Skeptic W-1: `waitForStudioModelLoaded` lacks per-fetch AbortSignal.timeout

**Source:** PE Skeptic BLESS W-1.

**Concern:** `src/daemon.ts:2066-2069` calls `await opts.fetchFn(statusUrl, ...)` without `AbortSignal.timeout()`. Compare to `getStudioLoadedModelIds` (line 2153) which DOES use `AbortSignal.timeout(2000)` (per Round 1 PE Skeptic W5). If Studio TCP-accepts but never responds during heavy GGUF load, boot wait can exceed `STUDIO_MODEL_WAIT_MS`.

**v0.3.2 ticket:** Add `signal: AbortSignal.timeout(Math.min(pollMs, 2000))` to the boot probe. Same pattern as cold-start probe.

**File:** `src/daemon.ts:2066-2069`.

---

### #11 — Integration W1 / Testing C-S2: `pi-launch.ps1` parity for studio-doctor wire-up

**Source:** Integration BLESS W1 + Testing followup.

**Concern:** `scripts/pi-launch.sh:51-52` has the `STUDIO_DOCTOR=1` opt-in invocation. `scripts/pi-launch.ps1` (Windows wrapper) does NOT. Cross-platform parity gap.

**v0.3.2 ticket:** Add equivalent PowerShell line to `pi-launch.ps1`.

**File:** `scripts/pi-launch.ps1`.

---

### #12 — F4 studio-doctor missing tests

**Source:** Integration W2 + Testing follow.

**Concern:** `scripts/studio-doctor.js` ships without tests (per plan §1.7c "omit per scope"). The `parseRange` function has 4 distinct exit-2 paths — all unverified.

**v0.3.2 ticket:** Add minimal smoke test mocking `fetch` + `process.env`.

**File:** `tests/scripts/studio-doctor.test.js` (NEW).

---

### #13 — Architect W-3: loop-breaker per-task one-shot has no session-lifetime cap

**Source:** Architect BLESS W-3.

**Concern:** Across 100 tasks, the user can in theory get 100 loop-breaker notices. Probably correct (per-task is the natural rate boundary for a single-user tool) but worth documenting as a deliberate design tradeoff.

**v0.3.2 ticket:** Document in code comment or accept and move on. Per-day cap would be over-engineering for single-user.

**File:** `src/session.ts:329` (loopBreakerEmittedThisTask comment block).

---

### #14 — Adversarial LOW-C / Testing concern: /cancel mid-denial-burst race not directly tested

**Source:** Adversarial BLESS LOW-C.

**Concern:** `src/session.ts:2046-2052` defensively handles the race where state has drained back to idle between bash result and observer firing. Code reads correctly; no test exercises it specifically.

**v0.3.2 ticket:** Add a test that drives 2 denials, calls `/cancel` concurrently with the 3rd, asserts no audit row + no `system_notice`.

**File:** `tests/session.test.ts`.

---

### #15 — Stale comment in session.ts about old prefix rendering

**Source:** Adversarial NIT + UX nit.

**Concern:** `src/session.ts:1701` comment still references `pi: ✅ done. ${finalMessage}` rendering. After F1, channels render `pi: ${stripFalseSuccessPrefix(finalMessage)}`. Cosmetic.

**v0.3.2 ticket:** Update comment.

**File:** `src/session.ts:1701`.

---

### #16 — Architect S-1: single source of truth for `pi:` prefix string

**Source:** Architect BLESS S-1.

**Concern:** `pi:` literal appears in `telegram.ts:981`, `whatsapp.ts:1343`, AND inside `stripFalseSuccessPrefix` fallback. Future rename would touch 3 places.

**v0.3.2 ticket:** `const PI_VOICE_PREFIX = "pi:"` exported from a single module.

**File:** `src/lib/sanitize.ts` or a new `src/lib/voice.ts`.

---

### #17 — PE Skeptic W-2: restart hard-timeout factor not exposed for ops tuning

**Source:** PE Skeptic BLESS W-2.

**Concern:** `src/daemon.ts:501` sets `restartHardTimeoutMs = staleMs * 2`. Default 240s (4 min wedge before defense-2 unsticks). Not exposed in `DaemonOpts`. Acceptable but would help debug-mode iteration.

**v0.3.2 ticket:** Lift `restartHardTimeoutFactor` to `DaemonOpts`.

**File:** `src/daemon.ts:501`.

---

### #18 — Security S-1: `assertLoopbackUrl` checks hostname literal, not DNS resolution

**Source:** Security BLESS S-1.

**Concern:** `src/daemon.ts:2001-2023` checks `parsed.hostname` against `localhost` / `127.0.0.1` / `[::1]` / `::1`. Does NOT resolve DNS. `/etc/hosts` tampering where `localhost` resolves to non-loopback would slip through.

**v0.3.2 ticket:** Either (a) DNS-resolve and verify all addresses are loopback, OR (b) tighten SECURITY.md R34.3 wording from "resolves to" to "hostname is". Option (b) is the cheaper documented-as-known-limit fix.

**File:** `src/daemon.ts:2001-2023` or `SECURITY.md:R34`.

---

### #19 — Security S-2: `studio_url` not redacted in `daemon_boot_failed` audit row

**Source:** Security BLESS S-2.

**Concern:** `src/daemon.ts:892` passes `studio_url` verbatim. Defensible (baseUrl from models.json, not network error blob), but cheap belt-and-braces.

**v0.3.2 ticket:** Apply `redactBotToken(studio_url)` for symmetry with other event payloads.

**File:** `src/daemon.ts:892`.

---

### #20 — UX Advocate N-UX-3: F4 box-drawing characters render inconsistently on mobile

**Source:** UX Advocate Round 1 N-UX-3 carryover.

**Concern:** `scripts/studio-doctor.js` output uses `━` U+2501 box-drawing. If operator copy-pastes into Telegram/WhatsApp for support, mobile font rendering varies.

**v0.3.2 ticket:** Use ASCII `---` separators OR document as console-only output.

**File:** `scripts/studio-doctor.js`.

---

## Out of scope (no v0.3.2 ticket — explicit deferrals)

- **F2 v4 prompt rewrite** — DROPPED entirely from v0.3.1 per empirical disconfirmation. No v0.4 ticket unless model behavior in production warrants.
- **STRANGER markers in studio-doctor** — UX I-UX-2 deferred to v0.4 per plan §F4.
- **Non-English locale sandbox-denial markers** — F3 predicate is English-only. Accepted limitation per plan.
- **Heartbeat source rename** — v0.4 (existing v0.3 followup #5).
- **Per-Bot undici dispatcher** — v0.4 (existing v0.3 followup #1).
- **AppContainer sandbox on Windows** — v2.

---

## Verification commands for the next session

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
git log --oneline | head -15        # confirm v0.3.1 commit set
npx tsc --noEmit                    # should be clean
npx vitest run                      # 1047/1054 pass + 7 platform-skip + 0 fail
```

Sergio's manual smoke (production deploy box) — same pattern as v0.3:
1. Smoke 1 (single-message latency, sanity)
2. Smoke 2 (canonical 3-message regression — MIB-2026-05-03 transcript)
3. Smoke 3 (sandbox-denial loop-breaker — trigger 3 sandbox-blocked bash calls; verify escape message + audit row)
4. Smoke 4 (F8 boot fix — start daemon with Studio model NOT loaded; verify exit 2 + 3-line stderr + audit row)
5. Smoke 5 (F1 — verify completed task replies no longer prefix `✅ done.`)

---

*Last updated: 2026-05-10 by orchestrator (post-Final-BLESS).*
