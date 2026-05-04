# pi-comms v0.2.1 — Tracked Followups

> **Source:** Ring-of-Elders BLESS round on the v0.2.1 ship (14 commits `e3e1219` → `064766d`).
> **Date:** 2026-05-03
> **Purpose:** Capture deferred-but-tracked items the BLESS round flagged but explicitly chose not to land in v0.2.1.
> **Discipline:** Each item cites the elder + finding ID + file:line so the next session can pick up where this one stopped.

---

## v0.2.1 BLESS final state

| Elder | Verdict (Round 1 BLESS) | Re-BLESS verdict on FIX-W4 |
|---|---|---|
| Architect | BLESSED-WITH-CONCERNS | (verified — all 2 IMPORTANTs addressed in FIX-W4) |
| Adversarial | NOT-BLESSED | (verified — all 4 NEW findings addressed in FIX-W4) |
| Testing | BLESSED | (no concerns) |
| UX Advocate | BLESSED-WITH-CONCERNS | (verified — S4 + serial_queue cooldown landed) |
| PE Skeptic | BLESSED-WITH-CONCERNS | (verified — watchdog reset landed; probe caching deferred — see #1) |
| Security | BLESSED-WITH-CONCERNS | (verified — task_failed error_class now redacted) |
| Observability | BLESSED-WITH-CONCERNS | (verified — task_id in mapper hooks landed) |
| Integration | BLESSED-WITH-CONCERNS | (verified — task_completed ChannelEvent now wired) |

All BLESS findings either RESOLVED in v0.2.1 or tracked below.

---

## Deferred — design discussion needed

### #1 — Probe-on-every-inbound caching

**Source:** PE Skeptic BLESS IMPORTANT 2.

**Concern:** `getStudioLoadedModelIds` runs as fire-and-forget on every inbound. In a 30s burst of 10 messages, GlobalQueue serializes the inbounds → 10 sequential GETs against Studio's `/api/inference/status`. Each pays a 2s timeout if Studio is hot. Even though notice cooldown (60s) prevents notification spam, the underlying probe traffic is uncached.

**Why deferred:** Cache TTL design needs thought:
- Cache per-channel or globally?
- 30s TTL aligns with notice-cooldown but might miss legitimate swaps that happen within the window
- LRU vs simple Map<channel, {ids, expiresAt}>?
- Does the cache need to invalidate on swap-detection (so the user-facing notice always reflects the freshest state)?

**v0.3 ticket:** add `private studioLoadedCache: { ids, expiresAt } | null` with configurable TTL (default 30s). Invalidate on detected mismatch so the next inbound re-probes.

**File:** `src/session.ts:840-920` (checkForStudioModelSwap).

---

### #2 — Dedicated `task_watchdog_fired` audit kind

**Source:** Observability BLESS N2.

**Concern:** Watchdog fires write `event: "task_failed"` with `extra.reason: "watchdog_no_terminal_event"`. SQL-style query "all watchdog fires" requires LIKE-matching extra.reason rather than clean GROUP BY. The audit schema's own guidance (`src/audit/schema.ts:36-43`) prefers `extra` first; promote to dedicated kind only if shape is truly distinct. Defensible per-schema-discipline; but worth re-evaluating in v0.3 if forensic queries pile up.

**v0.3 ticket:** evaluate whether the existing schema-bump cost is worth the queryability improvement. Most likely answer is "leave as-is; document the LIKE pattern in the audit-log query playbook."

**File:** `src/session.ts:780-795` (watchdog fire path).

---

### #3 — Watchdog default tunable via env var

**Source:** PE Skeptic BLESS IMPORTANT 1 + Adversarial BLESS NEW-4 (partial — tool_execution_start reset landed in FIX-W4-B-2; default duration knob not yet).

**Concern:** Even with the tool-activity reset, a task that does NO tool calls (e.g., very long pure inference, model thinking blocks for minutes without `tool_execution_*` events) still trips at 5min. Sergio may want to override per-deployment.

**v0.3 ticket:** add `PI_COMMS_TASK_WATCHDOG_MS` env var to `src/config.ts` envSchema. Default 300_000 (5 min). Operators on long-inference workloads can raise it.

**Files:** `src/config.ts` (envSchema); `src/daemon.ts` (pass to SessionManager).

---

### #4 — Per-thread `lastSwapNoticeAt` Map LRU cap

**Source:** Architect BLESS + Security BLESS observation. (Already documented inline at `src/session.ts:266` per FIX-W3-A.)

**Concern:** Today bounded by ChannelId enum cardinality (3 channels). If pi-comms ever supports per-DM-thread channel IDs (e.g., one map entry per Telegram chat ID), the Map becomes a slow leak.

**v0.3 ticket:** if/when ChannelId widens, replace plain Map with LRU-bounded Map (e.g., `lru-cache` package, max 10_000 entries, 24h TTL).

**File:** `src/session.ts:264-269` (the INVARIANT comment is already in place as a tripwire).

---

### #5 — Phase -1 SDK spike

**Source:** Carried over from v0.2.0 PRODUCTION-HANDOFF.md STOP-2.

**Concern:** Pi-mono SDK contract assumptions in `src/lib/sdk-shim.ts` are documented but not probed against an actual production install. The mapper, the `agent_end` reliability, and `customTools` semantics are all currently behavior-by-comment.

**v1 ticket:** run `npm run spike` on Sergio's Windows box; commit `~/.pi-comms/sdk-spike.json` to `docs/spike-results/sdk-spike-2026-MM-DD.json`. Update sdk-shim.ts comments with the real evidence.

**File:** `scripts/sdk-spike.ts`; `docs/spike-results/`.

---

## NITs — fix opportunistically

### #6 — `🔄` icon for `studio_model_swap_detected` doesn't render in plain ASCII (UX W4 nit)

**Source:** UX Advocate BLESS NIT.

**Concern:** Operators viewing operator log via `journalctl -u pi-comms` over plain SSH may see literal `?` instead of `🔄` depending on locale. Existing icons (📱❓pi:✅⚠️ℹ️‼️) have the same issue but Sergio's checks have been emoji-rendering-capable so far.

**v0.3 ticket:** none specific. Track as part of operator-log-vocabulary review when adding more channels / event kinds.

---

### #7 — Visual vocabulary review (8 prefix glyphs)

**Source:** UX Advocate BLESS W4 (REGRESSED).

**Concern:** After v0.2.1, Telegram surface has 8 distinct visible markers (📱❓ pi: ✅ ℹ️ ⚠️ ‼️ + no-prefix-reply). Coherence is "fragile" per UX. The `pi:` prefix is reused for 3 different meanings (still working / going background / done).

**v1 ticket:** dedicated UX pass after dogfooding feedback. Possibly merge `pi:` variants into a single `pi:` family with sub-glyphs (e.g., `pi: ⏳ still on it`, `pi: 📦 going async`, `pi: ✅ done`).

---

### #8 — `tests/session.test.ts:437-439` watchdog default coupling

**Source:** Testing BLESS NIT.

**Concern:** Auto-promote setTimeoutFn test relies on the watchdog default being 300_000. If the default ever shifts, the test passes for the wrong reason.

**v0.2.2 ticket:** add explicit `taskWatchdogMs: 300_000` to the test ctor for self-documenting intent.

---

### #9 — `tests/system-prompt.test.ts:10` + `.gitattributes:3` — `PRODUCTION-FINDINGS-2026-05-03.md` referenced without path prefix

**Source:** Testing BLESS NIT.

**Concern:** File lives at `docs/PRODUCTION-FINDINGS-2026-05-03.md`. Cosmetic doc-pointer drift.

**v0.2.2 ticket:** add `docs/` prefix in both references.

---

### #10 — `tests/integration/ipc-roundtrip.test.ts:11-14` docstring drift

**Source:** Integration BLESS NIT.

**Concern:** File-header docstring lists tell-only as `tell/confirm/reply` but `TELL_ONLY_EVENT_TYPES` actually has 4 entries (also includes `task_completed`). Test assertion at :294 also doesn't probe `task_completed`. No behavior bug; documentation drift.

**v0.2.2 ticket:** add `task_completed` to the test event array + assertion + update header docstring.

---

### #11 — `getStudioLoadedModelIds` is `export`ed unnecessarily

**Source:** Integration BLESS NIT.

**Concern:** Helper is only used internally by daemon.ts. Exporting widens public API surface. Closure binding at the construction site would still work without `export`.

**v0.2.2 ticket:** drop `export` from `src/daemon.ts:1471` `getStudioLoadedModelIds`.

---

### #12 — `tests/session.test.ts` cross-channel cooldown test gap

**Source:** Testing BLESS NIT.

**Concern:** Per-channel cooldown test only exercises same-channel suppression. Doesn't verify "different channel within 60s of original channel → DOES emit notice" (the cooldown is keyed per-channel).

**v0.2.2 ticket:** add the cross-channel cooldown test case.

---

### #13 — Asymmetric timer cleanup between fireWatchdog and fireAutoPromote

**Source:** Architect BLESS NIT.

**Concern:** Both have CAS + state validation but cleanup pattern differs. If a future patch adds "cancel sibling timer on fire" to one path, the other will silently drift.

**v0.2.2 ticket:** extract `clearAllTaskTimers(taskId)` helper that both fire-handlers call when transitioning to terminal state.

---

### #14 — Silent fetch-error swallowing operator visibility

**Source:** Architect BLESS NIT.

**Concern:** `getStudioLoadedModelIds` catch returns null with no signal. Chronically-broken Studio (cert expired, route changed) means probe silently never works. Existing `studio_health_fail` events at boot give a starting signal, but post-boot drift goes unobserved.

**v0.2.2 ticket:** increment a `consecutiveProbeFailures` counter; log a single operator-log warn after N (5?) consecutive failures with no body content.

---

## Out of scope (no ticket)

- **Hard model swap** (re-init agent session on detected change) — explicitly v5+. Loses context; needs SDK research.
- **`/consult` cloud escalation (V5-G)** — plan rows refined; no implementation in v0.2.1.
- **`/setup-comms` wizard (V5-H)** — plan rows refined; no implementation in v0.2.1.
- **State-machine decoupling** — Architect Round-1 W2 design debt. Requires whole-subscriber-loop refactor.
- **A/B prompt rollback via env var** — Adversarial Round 2 conceded; git revert is the right rollback mechanism.

---

## Verification commands for the next session

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
git log --oneline -16          # confirm v0.2.1 commit set
npx tsc --noEmit                # should be clean
npx vitest run                  # should be 915/922 (915 passed + 7 platform-skipped + 0 failed)
```

Sergio's manual smoke (production deploy box) — re-run the §5.1 transcript:

```
/start
you there
who are you?
hey there bro
do you know what model you are there
hello?
halo
hey again, whats the capital of France
```

Expected post-v0.2.1:
- All 8 messages get a reply (no silent drops)
- Replies have NO `📱` prefix (plain text)
- Follow-ups during pi's thinking get `pi: still working on the previous request — your follow-up arrived but is being dropped` (rate-limited to 1 per 30s per channel)
- If Studio's model is swapped mid-session, next inbound shows `⚠️ Studio's loaded model changed since boot (was X, now Y). Daemon is still using X until next restart.`
- Long-running tasks (e.g. "run vitest full suite") get `pi: ✅ done. <result>` instead of plain text when finished

Plus boot log should now show:
- `💚 studio health ok ... model=<id> auto_detected=true`
- `🔄 studio_swap_detection_armed baseline_model=<id>`
- `📝 prompt_version_changed path=prompts/coding-agent.v2.txt sha256_first8=40f11703`

---

*Last updated: 2026-05-03 by orchestrator (post-FIX-W4 wave + Adversarial narrow re-bless).*
