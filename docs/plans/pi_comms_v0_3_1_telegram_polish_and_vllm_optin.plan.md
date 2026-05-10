# Plan v2: pi-comms v0.3.1 — Telegram UX Polish + Studio Hygiene + vLLM Opt-in Backend

> **Source**: GB10 Claude's MIB-2026-05-09-{0103, 1126, 2305} bundle.
> **Predecessor**: v0.3 SHIPPED CLEAN (8 elders BLESSED, 1005 tests pass).
> **Date**: 2026-05-10 PT
> **Author**: Dev-box Claude (Mac orchestrator)
> **Plan version**: v2 (folds Round 1 elder findings — 3 NOT-APPROVED + 5 APPROVED-WITH-CONCERNS-with-blockers; ~13 convergent items; major reframings on F1/F2/F3/F8)
> **Plan output dir**: `docs/plans/`

**Goal**: Close the four telegram-side UX bugs GB10 found in live use AND ship vLLM as an opt-in backend variant — with empirically verified root causes, real predicates, and zero src/ changes for the backend swap itself.

---

## CHANGES FROM v1 (folded elder Round 1 findings)

8/8 elders returned. 3 NOT APPROVED + 5 APPROVED W/ CONCERNS. **13 convergent BLOCKER-class findings** synthesized below. Major reframings:

| # | Convergence | Plan §|
|---|---|---|
| 1 | ★★★★★ Architect+Adversarial+UX+Testing+Security | F2's root-cause hypothesis is empirically false (v3 prompt has zero ✅/done. references — verified). Source is daemon's own `formatChannelEvent` `task_completed` at `src/channels/telegram.ts:971` + `src/channels/whatsapp.ts:1332`. **DROP** Phase 5 (F2 v4 prompt rewrite). **Reframe** F1+F2 as: "kill `✅ done.` at source in formatChannelEvent" + defensive strip helper as belt-and-suspenders. | §F1+F2 |
| 2 | ★★★★★★ Architect+Adversarial+Testing+PE+Integration+Observability | F3 sandbox-denial predicate doesn't exist as a typed flag. Define explicit two-pronged predicate: `BashToolResult.isError && content.text.startsWith("blocked:")` for classifier-block AND new `details.sandboxDenied` flag in `wrap-bash.ts` populated by canonical stderr markers. Includes positive AND negative test fixtures. | §F3 |
| 3 | ★★★★ Architect+Adversarial+PE+Integration | F8's root-cause hypothesis is wrong. Daemon DOES throw on timeout (DaemonBootError → exit 2). Real cause per PE B1: parent's 30s `waitForDaemonReady` < daemon's 5min `STUDIO_MODEL_WAIT_MS` → SIGTERM during boot → graceful-shutdown handler exits 0. Fix: signal handler distinguishes boot-time vs runtime shutdown. Lift `STUDIO_MODEL_WAIT_MS` to `DaemonOpts` for testability. | §F8 |
| 4 | ★★★★ Integration+Testing+UX+Security | F1 missing WhatsApp parity. Same `pi: ✅ done.` formatter at `whatsapp.ts:1332`. Move helper to `src/lib/sanitize.ts`; both channels import. Tests in BOTH `tests/telegram-channel.test.ts` AND `tests/whatsapp-channel.test.ts`. | §F1 |
| 5 | ★★★★★ Adversarial+PE+Integration+UX+Security | F4 needs hardcoded loopback (no STUDIO_DOCTOR_HOST), strict input validation (NaN → exit 2), content sanitization on `/api/health` response (≤64 chars + ASCII printable), parallel scans via `Promise.allSettled`, structured operator-log line. | §F4 |
| 6 | ★★★ Adversarial+PE+Security | F7 literal `apiKey: "vllm"` is R2-class (check-env.js skips lowercase literals → bearer-shaped string ships to whoever binds :8000). Change to env-var name `VLLM_API_KEY`. Pin vLLM version. SECURITY.md R34. | §F7 |
| 7 | ★★ Architect+Integration | F7 example missing `authHeader` field (required by `src/lib/sdk-models-validator.ts:164`). Add explicit `authHeader: false`. | §F7 |
| 8 | ★★★★ UX+Observability+Security+PE | F8 stderr message contract: must be both grep-able (audit event `daemon_boot_failed` with structured payload) AND human-readable (3-line format: what failed, what to do, where to learn more). Run through `redactBotToken`. | §F8 |
| 9 | ★★ Observability+Security | F3 audit row payload extended: `extra.first_denial_age_ms`, `extra.last_cmd_hash_first8`, top-level `sender_id_hash`/`channel`/`task_id`. Drop `task_id` from extra. Scalars only. | §F3 |
| 10 | ★★ UX+Observability | F3 missing operator-logger icon. Add 🪤 to `src/utils/operator-logger.ts` icon registry (per UX C1 precedent from v0.3 BLESS). | §F3 |
| 11 | ★ UX | F3 escape message rewritten — drop `pi:` prefix collision, drop "I'm being blocked" anthropomorphism, use bulleted-options format scannable on phone. Names the actual workable escape (rephrase as read-only) alongside `/unsand` since mobile users may be blocked from terminal ack. | §F3 |
| 12 | ★ Testing | F8 hermetic test requires lifting `STUDIO_MODEL_WAIT_MS` + `STUDIO_MODEL_POLL_MS` to `DaemonOpts` (currently hardcoded module-private 5min — test would hang in CI). | §F8 |
| 13 | ★ Integration | W1 schema-add must be sequenced as W1.0 blocking before session.ts use (mirror v0.3 G7 pattern) so intermediate commits typecheck. | §Wave plan |

Plus ~10 IMPORTANT/NIT-class items (test count gate strengthened, vLLM supply-chain pin, README backend matrix decision tree, SECURITY.md R34+R35 entries, cross-machine push discipline, no-push-between-W1-commits, vLLM observability docs).

---

## Architecture (v2)

Six independent subsystems, file-disjoint waves:

- **F1 + F2 (unified)**: Kill `✅ done.` at source. Drop `pi: ✅ done. ${event.finalMessage}` prefix from `formatChannelEvent` `task_completed` in BOTH `src/channels/telegram.ts:971` AND `src/channels/whatsapp.ts:1332`. Replace with bare `pi: ${event.finalMessage}` (preserves agent voice marker, drops the marker the model is mimicking). PLUS defensive `stripFalseSuccessPrefix` in `src/lib/sanitize.ts`, applied in `formatChannelEvent` for `event.type === "reply"` ONLY (not post-format), as belt-and-suspenders against future model regression. Phase 5 (v4 prompt rewrite) **DROPPED** entirely — v3 has nothing to remove; v4 becomes a v0.4 ticket if ever needed.
- **F3 (sandbox-denial loop-breaker)**: Real predicate via two prongs: (a) `BashToolResult.isError && content.text.startsWith("blocked:")` catches classifier-block / confirm-block (canonical per `wrap-bash.ts:215, 223, 236`); (b) NEW field `BashToolResult.details.sandboxDenied: boolean` populated by `runBash` when `result.exitCode !== 0` AND stderr matches `/Permission denied|Operation not permitted|EACCES|Read-only file system|Could not resolve host/`. Per-task counter; one-shot injection. Audit event `sandbox_denial_loop_broken` with extended scalar payload. Operator-logger icon 🪤. Escape message rewritten.
- **F4 (`studio-doctor.js`)**: Read-only port scanner. Hardcoded `127.0.0.1` (no host env var). Strict input validation. Content sanitization (≤64 chars + ASCII printable). Parallel scans. Structured operator-log line in addition to stdout. Marks rows matching launch-studio.sh's `_EXPECTED_STUDIO_ROOT_ID` vs strangers.
- **F5+F6 (docs)**: GB10 §5B "Known quirks" + `/unsand` mobile followup #27 + README backend-matrix decision tree (UX I-2).
- **F7 (vLLM opt-in)**: Promote `examples/models.vllm.json` to passing matrix row. `apiKey: "VLLM_API_KEY"` (env-var pattern, NOT literal). `authHeader: false`. New `docs/INSTALL-VLLM.md`. New `scripts/install-vllm.sh` with pinned vLLM version + dry-run + GPU-contention warning + forensic-pointer section. SECURITY.md R34. Verdict marker PENDING until GB10 returns probe.
- **F8 (`pi-comms run` boot fix)**: Real root cause = SIGTERM-during-boot triggers graceful-shutdown handler exit 0 (PE B1's analysis). Fix: daemon's signal handler distinguishes `bootCompleted` flag — if false, exit 2 not 0. Lift `STUDIO_MODEL_WAIT_MS` and `STUDIO_MODEL_POLL_MS` to `DaemonOpts` for hermetic testing. New `daemon_boot_failed` audit event with structured payload. Three-line stderr message run through `redactBotToken`.
- **SEC (SECURITY.md updates)**: R34 (vLLM auth surface) + R35 (studio-doctor port scanner).

**Tech Stack**: TypeScript ESM (Node ≥20), vitest, grammY ^1.21, Baileys 7.0.0-rc.9 (optional), Python venvs for vLLM (subprocess only).

---

## Files to modify

| File | Reason | Implementer |
|---|---|---|
| `src/channels/telegram.ts` | F1a — drop `pi: ✅ done.` prefix from `formatChannelEvent` `task_completed` (line 971); F1b — apply `stripFalseSuccessPrefix` in `case "reply"` | IMPL-1 |
| `src/channels/whatsapp.ts` | F1a+F1b parity — same drop at line 1332 + same strip wire-in | IMPL-1 |
| `src/lib/sanitize.ts` | F1b — new exported `stripFalseSuccessPrefix(text)` helper alongside `redactBotToken` | IMPL-1 |
| `src/sandbox/wrap-bash.ts` | F3 — populate new `details.sandboxDenied: boolean` field on `BashToolResult` based on stderr canonical markers | IMPL-3 |
| `src/sandbox/exec.ts` | F3 — extend `SandboxedExecResult` with optional `details.sandboxDenied` (NO behavior change in exec; flag is set in wrap-bash from the stderr inspection) | IMPL-3 |
| `src/session.ts` | F3 — per-task counter + injection in tool-result observer; reset at task-start | IMPL-4 |
| `src/audit/schema.ts` | F3 — add `sandbox_denial_loop_broken` event kind; F8 — add `daemon_boot_failed` event kind | IMPL-W1.0 |
| `src/utils/operator-logger.ts` | F3 — icon 🪤 for `sandbox_denial_loop_broken`; F8 — icon for `daemon_boot_failed` | IMPL-4 (folds into F3 commit) |
| `src/daemon.ts` | F8 — lift `STUDIO_MODEL_WAIT_MS` + `STUDIO_MODEL_POLL_MS` to `DaemonOpts`; signal handler distinguishes boot vs runtime via `bootCompleted` flag; emit `daemon_boot_failed` audit BEFORE non-zero exit | IMPL-6 |
| `bin/pi-comms.ts` | F8 — replace `.catch(() => 0)` swallow at line 668 with explicit error propagation; ensure exit code matches child's | IMPL-6 |
| `tests/channels/telegram.test.ts` | F1 — strip helper unit tests (new test file already exists, restart-focused; add minimal F1 assertions here) | IMPL-1 |
| `tests/telegram-channel.test.ts` | F1 — formatChannelEvent regression assertion: `task_completed` no longer emits `✅ done.` | IMPL-1 |
| `tests/whatsapp-channel.test.ts` | F1 — same regression assertion for WhatsApp | IMPL-1 |
| `tests/lib/sanitize.test.ts` (or extend existing) | F1 — strip helper unit tests including production-format string `pi: ✅ done. ...` | IMPL-1 |
| `tests/session.test.ts` | F3 — loop-breaker positive + negative tests with explicit fixtures | IMPL-4 |
| `tests/audit/schema.test.ts` | F3+F8 — positive parse for new event kinds; reuse existing forward-compat assertion | IMPL-W1.0 |
| `tests/sandbox-exec.test.ts` (or wrap-bash.test if exists) | F3 — `details.sandboxDenied` flag fires on canonical stderr markers; does NOT fire on generic POSIX failures | IMPL-3 |
| `docs/GB10_UNSLOTH_SETUP.md` | F5 — §5B "Known quirks" section | IMPL-2 |
| `docs/PI_COMMS_V0_3_FOLLOWUPS.md` | F6 — entry #27 (/unsand mobile-friendly) | IMPL-2 |
| `README.md` | F7 — Backends section: vLLM third opt-in + decision-tree column; matrix update | IMPL-5 |
| `examples/models.vllm.json` | F7 — `apiKey: "VLLM_API_KEY"`, `authHeader: false`, drop placeholder model id, update `_comment` for sk-unsloth-style guidance | IMPL-5 |
| `scripts/pi-launch.sh` | F4 — OPTIONAL one-line invoke `studio-doctor.js` when `STUDIO_DOCTOR=1` | IMPL-7 |
| `SECURITY.md` | SEC — R34 (vLLM auth) + R35 (studio-doctor port scanner) | IMPL-2 |

## Files to create

| File | Reason | Implementer |
|---|---|---|
| `scripts/studio-doctor.js` | F4 — Node script, zero deps, hardcoded loopback, parallel scans, content sanitization, structured operator-log emission | IMPL-7 |
| `docs/INSTALL-VLLM.md` | F7 — install + probe + GPU-contention warning + forensic-pointer section | IMPL-5 |
| `scripts/install-vllm.sh` | F7 — idempotent, dry-run flag, pinned vllm version | IMPL-5 |

(F2 v4 prompt file DROPPED. v3 fixture stays as-is.)

---

## Wave plan (v2)

| Wave | Group | Files | Owner | Sequencing |
|---|---|---|---|---|
| **W0** | Diagnostic — `ss -tlnp \| grep ':888[0-9]'` on GB10 | (none) | GB10 Claude | sequential, ~30 sec; informational |
| **W1.0** | Audit schema — both new event kinds | `src/audit/schema.ts`, `tests/audit/schema.test.ts` | IMPL-W1.0 | **sequential — blocks W1.1's IMPL-4 + IMPL-6 type-check dependency** |
| **W1.1** | F1 — drop daemon prefix + strip helper (BOTH channels) | `src/channels/telegram.ts`, `src/channels/whatsapp.ts`, `src/lib/sanitize.ts`, `tests/telegram-channel.test.ts`, `tests/whatsapp-channel.test.ts`, `tests/lib/sanitize.test.ts` | IMPL-1 | parallel after W1.0 |
| **W1.1** | F5+F6+SEC — pure docs | `docs/GB10_UNSLOTH_SETUP.md`, `docs/PI_COMMS_V0_3_FOLLOWUPS.md`, `SECURITY.md` | IMPL-2 | parallel after W1.0 |
| **W1.1** | F3a — sandboxDenied flag in wrap-bash + exec | `src/sandbox/wrap-bash.ts`, `src/sandbox/exec.ts`, `tests/sandbox-exec.test.ts` | IMPL-3 | parallel after W1.0 |
| **W1.1** | F3b — loop-breaker counter + injection + icon | `src/session.ts`, `src/utils/operator-logger.ts`, `tests/session.test.ts` | IMPL-4 | **sequential after IMPL-3** (depends on `details.sandboxDenied` flag existing) |
| **W1.1** | F7 — vLLM opt-in scaffolding | `examples/models.vllm.json`, `docs/INSTALL-VLLM.md` (NEW), `scripts/install-vllm.sh` (NEW), `README.md` | IMPL-5 | parallel after W1.0 |
| **W1.1** | F8 — pi-comms run boot fix + signal handler + DaemonOpts injection | `src/daemon.ts`, `bin/pi-comms.ts`, `tests/integration/daemon-test-harness.ts` (extend), `tests/integration/run-cli-boot.test.ts` (NEW) | IMPL-6 | parallel after W1.0 |
| **W1.1** | F4 — studio-doctor scanner + pi-launch wire-up | `scripts/studio-doctor.js` (NEW), `scripts/pi-launch.sh` | IMPL-7 | parallel after W1.0 |

**File-disjointness verified.** No two W1.1 implementers touch the same file (modulo IMPL-4 sequential after IMPL-3 within same parallel slot due to type-dependency).

| **W2** | Audit Wave — 5 parallel auditors | (read-only) | AUDIT-A...E | after all W1.1 commits land |
| **W3** | Personal verify (orchestrator) | (read-only) | dev-box Claude | after W2 |
| **W4** | BLESS round (Ring of Elders) | (read-only) | 8 elders default scope | after W3 |
| **W5** | Reply MiB to GB10 | `docs/MIB-2026-05-XX-XXXX.md` (NEW) | dev-box Claude | after W4 |

---

## Step-by-step plan (v2)

### Phase 0 — Pre-work + diagnostic

#### Step 0.1 — Confirm pre-conditions

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
git log --oneline -5                          # head should be bf777d7 or later
npx tsc --noEmit                               # clean baseline
npx vitest run --reporter=basic 2>&1 | tail -5 # 1005/1005 pass + 7 platform-skip + 0 fail
```

#### Step 0.2 — Diagnostic ask to GB10

`ss -tlnp | grep ':888[0-9]'` — informational only. F4 ships either way.

---

### Phase 1 — Wave 1.0 (audit schema, blocking)

#### Step 1.0.1 — IMPL-W1.0 (audit schema add)

**Files**: `src/audit/schema.ts`, `tests/audit/schema.test.ts`.

**Add to `AuditEventTypeSchema` enum**:

```typescript
// v0.3.1 — Sandbox-denial loop-breaker (F3, MIB-2305 §4)
"sandbox_denial_loop_broken",
// v0.3.1 — Daemon boot-time failure surface (F8, MIB-2305 §5)
"daemon_boot_failed",
```

**Tests**:
- Positive parse for both new event kinds.
- Confirm existing forward-compat assertion (`AuditEntrySchema.parse({event: "future_v0_5_event_kind"})`) STILL passes (regression guard for v0.3 §G7 schema relaxation).

**Commit**:
```bash
git add src/audit/schema.ts tests/audit/schema.test.ts
git commit -m "feat(audit): v0.3.1 event kinds — sandbox_denial_loop_broken + daemon_boot_failed (W1.0)"
```

---

### Phase 1 — Wave 1.1 (parallel after W1.0)

#### Step 1.1 — IMPL-1 (F1: drop daemon prefix + strip helper, BOTH channels)

**Files**: `src/channels/telegram.ts`, `src/channels/whatsapp.ts`, `src/lib/sanitize.ts`, `tests/telegram-channel.test.ts`, `tests/whatsapp-channel.test.ts`, `tests/lib/sanitize.test.ts`.

**1.1a — Add helper to `src/lib/sanitize.ts`**:

```typescript
/**
 * Strip model-emitted false-success markers from REPLY text BEFORE chunking.
 *
 * Per MIB-2026-05-09-2305 §1: the local Qwen3.6 over-generalizes from its
 * own conversation history (where the daemon's task_completed formatter
 * historically rendered "pi: ✅ done. ...") and emits the marker as a prefix
 * on plain reply turns — including ones that say "the sandbox is having
 * issues right now". This is a UX disaster on Telegram.
 *
 * Plan v0.3.1 has TWO mitigations:
 *   1. Drop the "pi: ✅ done. " prefix from formatChannelEvent's
 *      task_completed rendering (kills the pattern in the model's input
 *      history at source).
 *   2. This defensive strip — applied in formatChannelEvent for "reply"
 *      events ONLY (not post-format) — catches residual emissions while
 *      the model's training-history influence fades.
 *
 * Anchored at start with optional "pi:" prefix. Capped at 10 iterations
 * to bound worst-case ReDoS surface. Mid-text occurrences are NEVER
 * stripped (the model legitimately uses ✅ as inline content).
 */
const FALSE_SUCCESS_PREFIX_RE = /^(?:pi:\s*)?(?:\s*✅\s*done\.?\s*\n?){1,10}/i;

export function stripFalseSuccessPrefix(text: string): string {
  return text.replace(FALSE_SUCCESS_PREFIX_RE, "");
}
```

**1.1b — Drop the daemon-side prefix in `src/channels/telegram.ts:970-971`**:

```typescript
// BEFORE:
case "task_completed":
  return `pi: ✅ done. ${event.finalMessage}`;

// AFTER (v0.3.1):
case "task_completed":
  return `pi: ${event.finalMessage}`;
```

**1.1c — Same change in `src/channels/whatsapp.ts:1331-1332`** (verify exact line; pattern is identical).

**1.1d — Apply strip in `formatChannelEvent` for `case "reply"` ONLY** (both telegram.ts and whatsapp.ts):

```typescript
import { stripFalseSuccessPrefix } from "../lib/sanitize.js";

// In formatChannelEvent (both channels):
case "reply":
  return stripFalseSuccessPrefix(event.text);
```

NOT in the post-`formatChannelEvent` chunkOutbound boundary — that's where the daemon's own task_completed prefix lives, and we've already cleaned it via 1.1b.

**1.1e — Tests** (REQUIRED test set):

`tests/lib/sanitize.test.ts` (new or extend):
- `stripFalseSuccessPrefix("pi: ✅ done. The sandbox seems to be having issues...")` → `"The sandbox seems to be having issues..."` (THE production format)
- `stripFalseSuccessPrefix("✅ done. text")` → `"text"`
- `stripFalseSuccessPrefix("pi: ✅ done.\npi: ✅ done. Let me try...")` → `"Let me try..."` (multi-prefix; tests the `{1,10}` quantifier)
- `stripFalseSuccessPrefix("Plain reply with ✅ done. embedded mid-text")` → unchanged (anchor protection)
- `stripFalseSuccessPrefix("")` → `""`
- `stripFalseSuccessPrefix("done.")` → `"done."` (no marker; unchanged)
- `stripFalseSuccessPrefix("pi: ✅ done.")` → `""` (full strip; verify chunkOutbound's empty-handling is OK with this OR add a fallback to "pi: ok" if empty post-strip)

`tests/telegram-channel.test.ts` regression assertion:
- `formatChannelEvent({type: "task_completed", finalMessage: "All tests passed."})` → `"pi: All tests passed."` (verify the ✅ done. drop)
- `formatChannelEvent({type: "reply", text: "pi: ✅ done. The sandbox is broken"})` → `"The sandbox is broken"` (verify strip applies here)

`tests/whatsapp-channel.test.ts` parity assertion:
- Same two tests as telegram, against WhatsApp channel.

**1.1f — Commit**:
```bash
git add src/channels/telegram.ts src/channels/whatsapp.ts src/lib/sanitize.ts \
  tests/telegram-channel.test.ts tests/whatsapp-channel.test.ts \
  tests/lib/sanitize.test.ts
git commit -m "fix(channels): kill ✅ done. at source + defensive strip (F1+F2 v0.3.1)

Per gx10-831a MIB-2026-05-09-2305 §1.  Real root cause: the daemon's
formatChannelEvent for task_completed rendered 'pi: ✅ done. ...' which
the local Qwen3.6 saw in its own conversation history and over-
generalized into emitting the marker on tool-failure replies.

Two mitigations:
1. Drop the daemon-side ✅ done. prefix (kills the pattern at source
   for both Telegram and WhatsApp).
2. Defensive stripFalseSuccessPrefix in src/lib/sanitize.ts applied at
   formatChannelEvent's 'reply' case only (not post-format) — belt-and-
   suspenders against model regression.

DROPS Phase 5 (v3→v4 prompt rewrite from v0.3.1 plan v1) — empirical
verification confirmed v3 prompt has zero ✅/done. references, so the
'root fix in v4' framing was wrong."
```

---

#### Step 1.2 — IMPL-2 (F5+F6+SEC: docs)

**Files**: `docs/GB10_UNSLOTH_SETUP.md`, `docs/PI_COMMS_V0_3_FOLLOWUPS.md`, `SECURITY.md`.

**1.2a — F5 GB10 §5B "Known quirks"**: per GB10 MIB-0103 §3 suggested copy. Insert AFTER §5A.

**1.2b — F6 followups #27** (`/unsand` mobile): design conversation, not code. Cite a/b/c options from MIB-2305 §2.

**1.2c — SEC R34** (vLLM auth surface):
```markdown
### R34 — vLLM auth surface (post-v0.3.1)

The v0.3.1 vLLM opt-in backend (F7 — see plan §F7) introduces a new auth
surface alongside Studio. Three concrete risks:

1. **Literal apiKey shipping as bearer.** `examples/models.vllm.json`'s
   default is `apiKey: "VLLM_API_KEY"` (env-var name, validated by
   `check-env.js`'s `^[A-Z_][A-Z0-9_]*$` regex). Operators MUST set the
   env var before launching pi-mono. Mitigation parallels R2.
2. **Supply-chain risk on `pip install vllm`.** `scripts/install-vllm.sh`
   pins to a specific vLLM version (`pip install "vllm==<pinned>"`).
   Operators reinstalling later get the same pinned version. Bump
   requires re-probing.
3. **0.0.0.0 bind regression** (R9-class). vLLM's default bind is
   `0.0.0.0:8000`. The daemon's `assertLoopbackUrl` (per v0.3) catches
   this — refuses to start if `baseUrl` resolves to a non-loopback IP.
   `INSTALL-VLLM.md` MUST instruct `vllm serve --host 127.0.0.1`.
```

**1.2d — SEC R35** (studio-doctor):
```markdown
### R35 — studio-doctor port scanner (post-v0.3.1)

`scripts/studio-doctor.js` (F4) scans loopback ports 8888-8908 for
Studio responders. Three invariants:

1. **Loopback-only by hardcode** — host is the literal `127.0.0.1`,
   NOT a configurable env var. Prevents R14-class probe-egress regression.
2. **Strict input validation** on `STUDIO_DOCTOR_PORT_RANGE`: NaN, ranges
   >100 ports, missing dash all → exit 2 with clear stderr.
3. **Content sanitization** on `/api/health` JSON response: `studio_root_id`
   and `loaded` model name truncated to 64 chars + ASCII-printable filtered.
   Prevents terminal-hijack via ANSI escape sequences from a malicious
   process binding a port and returning crafted JSON.

Read-only by design: NO port killing, NO Studio mutation, NO
auto-baseUrl-rewrite. Per Plan v0.3.1 Pitfall #2.
```

**1.2e — Commit**:
```bash
git add docs/GB10_UNSLOTH_SETUP.md docs/PI_COMMS_V0_3_FOLLOWUPS.md SECURITY.md
git commit -m "docs: GB10 §5B + /unsand mobile followup + R34 vLLM + R35 studio-doctor (v0.3.1)"
```

---

#### Step 1.3 — IMPL-3 (F3a: sandboxDenied flag in wrap-bash + exec)

**Files**: `src/sandbox/wrap-bash.ts`, `src/sandbox/exec.ts`, `tests/sandbox-exec.test.ts`.

**1.3a — Extend `BashToolResult.details` shape** in `wrap-bash.ts`. Add:

```typescript
interface BashToolResultDetails {
  // existing fields...
  /**
   * v0.3.1 (F3): true when the wrapped exec returned non-zero AND stderr
   * matches a canonical sandbox-denial marker. Used by SessionManager's
   * loop-breaker (per plan §F3) to count consecutive sandbox-denials and
   * inject an escape message after threshold N.
   *
   * NOT set on:
   *   - generic POSIX failures (file-not-found, permission errors that
   *     match user-cwd-state, network-down, OOM)
   *   - classifier-block / confirm-block (those return errorResult("blocked: ...")
   *     and are detected via the "blocked:" text prefix instead)
   *   - aborted=true (AbortSignal-driven cancellation, NOT policy denial)
   *
   * Canonical markers (regex):
   *   /Permission denied|Operation not permitted|EACCES|Read-only file system|Could not resolve host|cannot create directory.*Read-only/
   *
   * The markers are bwrap/sandbox-exec failure modes; we observe them in
   * stderr because the kernel emits them on the sandbox-denied syscall.
   * Locale note: English-only markers; non-English locales (fr_FR, etc.)
   * silently bypass — accepted limitation per v0.3.1 scope.
   */
  sandboxDenied?: boolean;
}
```

**1.3b — Populate the flag** in `runBash` AFTER `execSandboxed`/`execRaw` returns:

```typescript
const result = await execSandboxed({...});
const sandboxDenied = result.exitCode !== 0 && SANDBOX_DENIAL_RE.test(result.stderr);

return {
  // existing fields...
  details: {
    // existing details...
    sandboxDenied,
  },
};
```

Where `SANDBOX_DENIAL_RE = /Permission denied|Operation not permitted|EACCES|Read-only file system|Could not resolve host|cannot create directory.*Read-only/`.

**1.3c — Tests** (`tests/sandbox-exec.test.ts` extend OR new `tests/sandbox-wrap-bash.test.ts`):

Positive (sandboxDenied=true):
- Stderr containing `mkdir: cannot create directory '/etc/foo': Read-only file system` → flag set.
- Stderr containing `curl: (6) Could not resolve host example.com` (bwrap `--unshare-net`) → flag set.
- Stderr containing `Operation not permitted` (sandbox-exec deny) → flag set.

Negative (sandboxDenied=false):
- Stderr `bash: foo: command not found` → flag NOT set (not sandbox; user error).
- Stderr `cat: /tmp/missing: No such file or directory` → flag NOT set (file-not-found, not denial).
- Stderr `Killed` (OOM) → flag NOT set.
- Empty stderr + exit 0 → flag NOT set.
- `aborted=true` (signal) + Permission-denied stderr → flag NOT set (aborted takes precedence; this is a /cancel race, not a policy denial).

**1.3d — Commit**:
```bash
git add src/sandbox/wrap-bash.ts src/sandbox/exec.ts tests/sandbox-exec.test.ts
git commit -m "feat(sandbox): details.sandboxDenied flag from canonical stderr markers (F3a v0.3.1)

Per gx10-831a MIB-2026-05-09-2305 §4 + Ring of Elders convergent finding
on F3 predicate.  Pre: 'sandbox denied this' had no canonical typed signal
in BashToolResult.  Post: details.sandboxDenied is true iff exec returned
non-zero AND stderr matches canonical markers (Permission denied, EACCES,
Read-only file system, Could not resolve host).  IMPL-4's loop-breaker
counter consumes this flag.  Negative-case fixtures included."
```

---

#### Step 1.4 — IMPL-4 (F3b: loop-breaker counter + injection + icon) — sequential after IMPL-3

**Files**: `src/session.ts`, `src/utils/operator-logger.ts`, `tests/session.test.ts`.

**1.4a — Counter + injection in SessionManager**:

Locate the bash-tool-result observer in `src/session.ts`. Per IMPL-3's flag:
```typescript
private consecutiveSandboxDenials = 0;
private loopBreakerEmittedThisTask = false;
private firstDenialMonotonicMs: number | null = null;
private lastCmdHashFirst8: string | null = null;
private readonly SANDBOX_DENIAL_LOOP_THRESHOLD = 3;

// On every bash tool result:
if (result.details?.sandboxDenied || (result.isError && result.content[0]?.text?.startsWith("blocked:"))) {
  if (this.consecutiveSandboxDenials === 0) {
    this.firstDenialMonotonicMs = monotonicMs();
  }
  this.consecutiveSandboxDenials++;
  this.lastCmdHashFirst8 = sha256(cmd).substring(0, 16);
  if (
    this.consecutiveSandboxDenials >= this.SANDBOX_DENIAL_LOOP_THRESHOLD &&
    !this.loopBreakerEmittedThisTask
  ) {
    this.injectLoopBreakerNotice();
    this.loopBreakerEmittedThisTask = true;
    void this.opts.auditLog.append({
      event: "sandbox_denial_loop_broken",
      task_id: this.currentTaskId,
      channel: this.currentChannel,
      sender_id_hash: this.currentSenderHash,
      extra: {
        consecutive_denials: this.consecutiveSandboxDenials,
        first_denial_age_ms: monotonicMs() - this.firstDenialMonotonicMs!,
        last_cmd_hash_first8: this.lastCmdHashFirst8,
      },
    });
  }
} else if (!result.isError) {
  // Successful tool call — reset
  this.consecutiveSandboxDenials = 0;
  this.firstDenialMonotonicMs = null;
  this.lastCmdHashFirst8 = null;
  // Note: loopBreakerEmittedThisTask stays true for the rest of THIS task
  // (one-shot per task per Pitfall #5 + plan v1 §1.5b)
}
```

Reset all four fields at task-start in handleInbound's task-creation path.

**1.4b — Injection text** (UX BLOCKER-2 fix):

```typescript
private injectLoopBreakerNotice(): void {
  this.opts.sink.send({
    type: "system_notice",
    severity: "warn",
    text:
      "sandbox blocked 3 attempts. options:\n" +
      "  • /unsand from a terminal (one-time per first session)\n" +
      "  • rephrase as read-only (\"can you describe X\")\n" +
      "  • /cancel",
  });
}
```

NO `pi:` prefix. Channel formatter adds the `ℹ️`/`⚠️` prefix.

**1.4c — Add icon in `src/utils/operator-logger.ts`**:

In the icons map, add (sandbox cluster):
```typescript
sandbox_denial_loop_broken: "🪤",
daemon_boot_failed: "💔",  // reuse existing studio_health_fail icon for symmetry
```

**1.4d — Tests** (`tests/session.test.ts`):

- 3 consecutive results with `details.sandboxDenied=true` → injection fires + audit row + counter resets nothing (one-shot)
- 4th denial after injection → NO second injection
- Successful tool call after 2 denials → counter resets; need 3 NEW denials
- Cross-task: counter resets at task-start; loop-breaker can fire again for new task
- Negative: 3 consecutive `command not found` (sandboxDenied=false) → loop-breaker NEVER fires
- Negative: 3 consecutive `blocked:` text (classifier-block path) → DOES fire (the alternate branch)
- Audit payload includes `extra.first_denial_age_ms`, `extra.last_cmd_hash_first8`, top-level `sender_id_hash`/`channel`/`task_id`

**1.4e — Commit**:
```bash
git add src/session.ts src/utils/operator-logger.ts tests/session.test.ts
git commit -m "feat(session): sandbox-denial loop-breaker (F3b v0.3.1)

Per MIB-2305 §4. Counter consumes IMPL-3's details.sandboxDenied flag
(canonical predicate, not heuristic).  N=3 consecutive denials within a
single task → one-shot injection of escape message + audit row.
Negative fixtures verify: command-not-found / file-not-found / OOM do
NOT trip the counter.  Per-task isolation; counter resets at task-start."
```

---

#### Step 1.5 — IMPL-5 (F7: vLLM opt-in)

**Files**: `examples/models.vllm.json`, `docs/INSTALL-VLLM.md` (NEW), `scripts/install-vllm.sh` (NEW), `README.md`.

**1.5a — Update `examples/models.vllm.json`**:

```json
{
  "_comment": "pi-mono custom-provider config for vLLM. Pre-req: vLLM started with --enable-auto-tool-choice --tool-call-parser hermes (for Qwen3-class) AND --host 127.0.0.1 (R9 mitigation). Set VLLM_API_KEY env var matching whatever you launched vLLM with via --api-key (or any non-empty string if vLLM has no auth). Probe with: VLLM_API_KEY=<your-key> PROBE_ENDPOINT=http://localhost:8000/v1 PROBE_MODEL=<your-model-id> node scripts/probe-toolcalls.js. VERIFIED 2026-05-XX (PENDING — see CONTRIBUTING.md probe verdict matrix).",
  "providers": {
    "vllm-local": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "VLLM_API_KEY",
      "authHeader": false,
      "models": [
        {
          "id": "Qwen/Qwen3.6-27B-Instruct",
          "name": "Qwen3.6 27B (vLLM, local)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false,
            "maxTokensField": "max_tokens"
          }
        }
      ]
    }
  }
}
```

**1.5b — Write `docs/INSTALL-VLLM.md`** (NEW). Sections:
1. Why vLLM as opt-in (production-box parity, GPU contention with Studio).
2. Pre-req — Linux/CUDA, Python 3.12, ~12GB free disk for venv.
3. Install via `scripts/install-vllm.sh` (idempotent, dry-run flag).
4. Launch invocation — `vllm serve <model> --host 127.0.0.1 --port 8000 --enable-auto-tool-choice --tool-call-parser hermes --served-model-name <pi-mono-id> --api-key <your-key>`.
5. Probe gate — `node scripts/probe-toolcalls.js`.
6. models.json swap — `chmod 600`, set `VLLM_API_KEY`.
7. Co-existence with Studio — **GPU memory contention warning** per PE I5: don't run both with large models simultaneously.
8. Forensic pointers — vLLM has its own logs; pi-comms can't see them. When something fails: (1) `vllm serve` stderr/stdout; (2) `curl http://localhost:8000/v1/models`; (3) pi-comms operator log.
9. When to use vLLM vs Studio — decision tree.

**1.5c — Write `scripts/install-vllm.sh`** (NEW):
- Refuse non-Linux with clear stderr.
- Detect CUDA (warn, don't refuse).
- `~/.venvs/vllm/` separate venv.
- `pip install "vllm==0.6.5"` (PINNED — bump requires re-probe).
- Idempotent: skip steps already done.
- Dry-run flag (`-n`): print commands, don't execute. NO pip install in dry-run mode.
- Print recommended `vllm serve` invocation tailored to detected GPU.
- NO auto-run of `vllm serve`.

**1.5d — Update `README.md`**:
- Backends matrix: vLLM row → "PASS — verified by gx10-831a YYYY-MM-DD (PENDING)" with link to INSTALL-VLLM.md.
- Add "Pick this backend if..." column or above-matrix decision tree (UX I-2).

**1.5e — Commit**:
```bash
git add examples/models.vllm.json docs/INSTALL-VLLM.md scripts/install-vllm.sh README.md
git commit -m "feat(backends): vLLM as opt-in backend variant (F7 v0.3.1)

Per Sergio MIB-2305 §6.  Zero src/ changes (architecture is provider-
agnostic per docs/ARCHITECTURE.md §1).

Hardening per Ring of Elders Round 1:
- apiKey: 'VLLM_API_KEY' (env-var pattern; check-env.js validates;
  R34-class regression class avoided)
- authHeader: false (matches existing skeleton)
- vLLM version pinned in install-vllm.sh (supply-chain mitigation)
- INSTALL-VLLM.md includes GPU-contention warning + forensic-pointer
  section + decision tree

Verdict marker PENDING until GB10 returns probe."
```

---

#### Step 1.6 — IMPL-6 (F8: pi-comms run boot fix)

**Files**: `src/daemon.ts`, `bin/pi-comms.ts`, `tests/integration/daemon-test-harness.ts`, `tests/integration/run-cli-boot.test.ts` (NEW).

**1.6a — Real root cause** (per PE B1):
- Parent's `waitForDaemonReady` (`bin/pi-comms.ts:643`) has 30s timeout.
- Daemon's `STUDIO_MODEL_WAIT_MS` (`src/daemon.ts:126`) is 5min.
- When Studio model isn't loaded, daemon waits up to 5min in step 6 BEFORE binding IPC socket at step 17.
- Parent's 30s expires; sends SIGTERM; daemon's signal handler (`src/daemon.ts:2042-2046`) does graceful shutdown → exit 0.
- Parent sees `child.exitCode = 0` → reports success.

**1.6b — Fix in `src/daemon.ts`**:

Add `bootCompleted` boolean to daemon state. Set to `true` after IPC socket binds (step 17). Modify SIGTERM/SIGINT handler:

```typescript
const signalHandler = (sig: NodeJS.Signals) => {
  if (!bootCompleted) {
    // Boot-time shutdown — exit non-zero so parent + autostart see real failure
    operatorLogger.error("daemon_boot_aborted_by_signal", { signal: sig });
    void auditLog.append({
      event: "daemon_boot_failed",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
      extra: {
        reason: "boot_aborted_by_signal",
        signal: sig,
      },
    });
    process.exit(2);
  }
  // Runtime shutdown — graceful exit 0
  void shutdown(sig).then(() => process.exit(0));
};
```

**1.6c — Lift `STUDIO_MODEL_WAIT_MS` + `STUDIO_MODEL_POLL_MS` to `DaemonOpts`**:

```typescript
export interface DaemonOpts {
  // existing fields...
  /** Test injection: max time to wait for Studio model load. Default 5min. */
  studioModelWaitMs?: number;
  /** Test injection: poll interval for Studio readiness. Default 5s. */
  studioModelPollMs?: number;
}

// In start():
const studioModelWaitMs = opts.studioModelWaitMs ?? STUDIO_MODEL_WAIT_MS;
const studioModelPollMs = opts.studioModelPollMs ?? STUDIO_MODEL_POLL_MS;
// Pass to waitForStudioModelLoaded.
```

**1.6d — Emit `daemon_boot_failed` audit BEFORE non-zero exit** in main():

```typescript
} catch (e) {
  if (e instanceof DaemonBootError) {
    const message = redactBotToken(e.message);
    process.stderr.write(`pi-comms: cannot start — ${message}\n\n`);
    process.stderr.write(
      `Likely cause: open Studio's web UI (${studioUrl}) and load the\n` +
      `model named in ~/.pi/agent/models.json. Then re-run pi-comms run.\n\n` +
      `If this is your first install: see docs/INSTALL.md §3.\n`
    );
    void auditLog.append({
      event: "daemon_boot_failed",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
      extra: {
        reason: "studio_model_load_timeout",
        configured_model_id: redactBotToken(modelId),
        studio_url: studioUrl,
        timeout_ms: studioModelWaitMs,
      },
    });
    process.exit(2);
  }
  throw e;
}
```

**1.6e — Fix in `bin/pi-comms.ts:668`**: replace `.catch(() => 0)` with explicit error propagation:

```typescript
// BEFORE:
const attachExitCode = await runAttach({...}).catch(() => 0);

// AFTER:
const attachExitCode = await runAttach({...}).catch((e) => {
  process.stderr.write(`pi-comms: attach failed: ${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
});
```

**1.6f — Hermetic test** (`tests/integration/run-cli-boot.test.ts` NEW):

Use the daemon-test-harness with `studioModelWaitMs: 100` injection + a stubbed `fetchFn` that always returns "no models loaded". Assert:
- `daemon_boot_failed` audit row fires within ~100ms.
- `process.exit(2)` called.
- Stderr contains the 3-line message format.
- No `bot token`-shaped content in stderr.

**1.6g — Commit**:
```bash
git add src/daemon.ts bin/pi-comms.ts tests/integration/daemon-test-harness.ts tests/integration/run-cli-boot.test.ts
git commit -m "fix(daemon): signal handler distinguishes boot vs runtime; daemon_boot_failed audit (F8 v0.3.1)

Per Ring of Elders Round 1 — PE B1's analysis on the actual root cause.
Pre: parent's 30s waitForDaemonReady < daemon's 5min STUDIO_MODEL_WAIT_MS;
SIGTERM during boot triggered graceful-shutdown handler (exit 0); user
saw silent code-0 success while bot was actually broken.

Post: signal handler checks bootCompleted flag — pre-bind shutdown emits
daemon_boot_failed audit + exits 2.  STUDIO_MODEL_WAIT_MS lifted to
DaemonOpts for hermetic testing.  bin/pi-comms.ts:668 .catch(() => 0)
swallow replaced with explicit error propagation.  Stderr formatted
3-line: what failed / what to do / where to learn more.  redactBotToken
applied defensively."
```

---

#### Step 1.7 — IMPL-7 (F4: studio-doctor)

**Files**: `scripts/studio-doctor.js` (NEW), `scripts/pi-launch.sh`.

**1.7a — Write `scripts/studio-doctor.js`**:

```javascript
#!/usr/bin/env node
/**
 * studio-doctor — read-only Unsloth Studio multiplicity scanner.
 *
 * Per gx10-831a MIB-2026-05-09-1126 §1 (dup-Studio silent spawn) +
 * Ring of Elders v0.3.1 Round 1 (loopback-only invariant, content
 * sanitization, parallel scans).
 *
 * Exit 0 always (informational). NO port killing, NO Studio mutation,
 * NO auto-baseUrl-rewrite.
 *
 * Usage:
 *   node scripts/studio-doctor.js
 *   STUDIO_DOCTOR_PORT_RANGE=8888-8898 node scripts/studio-doctor.js
 */

// Hardcoded loopback (R35 invariant). NOT configurable.
const HOST = "127.0.0.1";
const TIMEOUT_MS = 500;
const MAX_PORT_SPAN = 100;

// Strict input validation (per Ring of Elders Round 1 PE I3 + Adversarial #6).
function parseRange(env) {
  const raw = env ?? "8888-8908";
  const parts = raw.split("-");
  if (parts.length !== 2) {
    console.error(`studio-doctor: STUDIO_DOCTOR_PORT_RANGE must be 'start-end' (got: '${raw}')`);
    process.exit(2);
  }
  const [start, end] = parts.map(Number);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    console.error(`studio-doctor: STUDIO_DOCTOR_PORT_RANGE must be integers (got: '${raw}')`);
    process.exit(2);
  }
  if (start <= 0 || end > 65535 || end < start) {
    console.error(`studio-doctor: invalid range ${start}-${end}`);
    process.exit(2);
  }
  if (end - start > MAX_PORT_SPAN) {
    console.error(`studio-doctor: range too wide (${end - start} > ${MAX_PORT_SPAN})`);
    process.exit(2);
  }
  return [start, end];
}

const [START, END] = parseRange(process.env.STUDIO_DOCTOR_PORT_RANGE);

// Content sanitization (Security W2): truncate + ASCII-printable only.
function sanitize(s) {
  if (typeof s !== "string") return "(non-string)";
  return s.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
}

// Parallel scans via Promise.allSettled (PE I6).
async function probe(port) {
  try {
    const resp = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return { port, status: "non-ok", code: resp.status };
    const data = await resp.json().catch(() => null);
    if (!data) return { port, status: "non-json" };
    return {
      port,
      status: "healthy",
      studio_root_id: sanitize(data.studio_root_id ?? ""),
      loaded: sanitize(data.loaded ?? ""),
    };
  } catch (e) {
    return null; // not responding
  }
}

const ports = [];
for (let p = START; p <= END; p++) ports.push(p);
const results = (await Promise.allSettled(ports.map(probe)))
  .map((r) => (r.status === "fulfilled" ? r.value : null))
  .filter(Boolean);

// Output
if (process.env.STUDIO_QUIET === "1") process.exit(0);

const sep = "━".repeat(67);
console.log(sep);
console.log(`studio-doctor — scanning ${HOST}:${START}-${END}`);
console.log(sep);
if (results.length === 0) {
  console.log("  no Studio responded.");
} else {
  for (const r of results) {
    const tag = r.status === "healthy"
      ? `studio_root_id=${r.studio_root_id.slice(0, 8)}…  loaded=${r.loaded}`
      : `${r.status}${r.code ? ` (HTTP ${r.code})` : ""}`;
    console.log(`  :${r.port}  ${tag}`);
  }
}
console.log(sep);
if (results.length > 1) {
  console.log("⚠  More than one Studio responded.  pi-mono routes to whichever");
  console.log("    `baseUrl` in ~/.pi/agent/models.json resolves to.");
}
console.log(sep);

// Structured operator-log line (Observability I-O3).
console.error(JSON.stringify({
  event: "studio_doctor_observed",
  studio_count: results.length,
  ports_responding: results.map((r) => r.port).join(","),
}));

process.exit(0);
```

**1.7b — `pi-launch.sh` opt-in wire-up**:

```bash
[ "$STUDIO_DOCTOR" = "1" ] && node "$(dirname "$0")/studio-doctor.js"
```

ONE line. Defaults off.

**1.7c — Tests**: omit per scope (zero-dep informational script).

**1.7d — Commit**:
```bash
git add scripts/studio-doctor.js scripts/pi-launch.sh
git commit -m "feat(scripts): studio-doctor.js — loopback-only multiplicity scanner (F4 v0.3.1)

Per gx10-831a MIB-2026-05-09-1126 §1.  Read-only by design.  Hardening
per Ring of Elders Round 1:
- Hardcoded 127.0.0.1 (R35 invariant; no STUDIO_DOCTOR_HOST env var)
- Strict input validation on STUDIO_DOCTOR_PORT_RANGE (NaN, missing
  dash, ranges >100 ports → exit 2)
- Content sanitization on /api/health response (≤64 chars + ASCII-
  printable; prevents ANSI-hijack)
- Parallel scans via Promise.allSettled
- Structured operator-log JSON line in addition to stdout"
```

---

### Phase 2 — Audit Wave (5 parallel auditors)

| Auditor | Reviews | Spec |
|---|---|---|
| AUDIT-A | IMPL-1 F1 (drop prefix + strip helper, BOTH channels) + IMPL-W1.0 (audit schema) | regex correctness on production format `pi: ✅ done. ...`; daemon-prefix drop verified in BOTH channels; tests cover negative cases (no over-strip on legit content); audit schema add doesn't break forward-compat |
| AUDIT-B | IMPL-3 F3a (sandboxDenied flag) + IMPL-4 F3b (loop-breaker) | predicate is canonical (not heuristic); positive AND negative test fixtures land; audit payload includes all required scalars; icon registered; escape message has no `pi:` prefix collision |
| AUDIT-C | IMPL-2 (docs) + IMPL-5 F7 (vLLM) | §5B copy fidelity; followup #27 design alternatives clearly framed; vLLM example schema validates (authHeader present); apiKey is env-var name (not literal); vLLM version pinned; SECURITY.md R34+R35 land |
| AUDIT-D | IMPL-6 F8 (boot fix) | bootCompleted flag wired correctly; signal handler distinguishes boot vs runtime; STUDIO_MODEL_WAIT_MS injectable; daemon_boot_failed audit fires; stderr 3-line format; bin/pi-comms.ts `.catch(() => 0)` removed; redactBotToken applied; hermetic test asserts non-zero exit |
| AUDIT-E | IMPL-7 F4 (studio-doctor) | hardcoded 127.0.0.1 (no host env var); input validation cap-100; content sanitization; parallel via Promise.allSettled; structured operator-log line emitted; `grep -E "kill\|fetch.*sandbox\|process.*kill\|spawn\|/api/inference" scripts/studio-doctor.js` returns ZERO matches (per N4); pi-launch.sh opt-in line is one-line and gated |

Each auditor invokes `10x-engineer:testing-anti-patterns` + `verification-before-completion`. NO rubber-stamps; if no real findings, justify why.

---

### Phase 3 — Personal verify (orchestrator)

```bash
git log --oneline -15                         # confirm W1.0 + 6 W1.1 commits + audit fixes if any
git status                                     # clean
npx tsc --noEmit                               # clean
npx vitest run --reporter=basic 2>&1 | tail -5 # baseline 1005 + new tests
                                               #   IMPL-1: ~6 sanitize + 4 channel regression = ~10
                                               #   IMPL-3: ~6 sandboxDenied predicate
                                               #   IMPL-4: ~6 loop-breaker
                                               #   IMPL-6: ~3 boot-fix
                                               #   IMPL-W1.0: 2 audit schema
                                               # total target: ~1032+

# Strengthened test-count gate (Adversarial #12, Testing I-6)
git diff bf777d7..HEAD -- "tests/**" | grep -cE '^\+\s*(it|test)\('
# Should be ≥ 25 net-new tests

# Pre-ship grep gates
grep -c "stripFalseSuccessPrefix\|sandboxDenied\|sandbox_denial_loop_broken\|daemon_boot_failed" src/  # ≥6
grep -c "studio-doctor" scripts/                                     # ≥1
grep "127.0.0.1" scripts/studio-doctor.js                            # exactly 1 (hardcoded)
grep -c "VLLM_API_KEY" examples/models.vllm.json                     # 1
grep "authHeader" examples/models.vllm.json                          # exists
ls docs/INSTALL-VLLM.md scripts/install-vllm.sh                       # both exist
node -e "const v = require('./examples/models.vllm.json'); console.log('OK')"  # parses
grep -E "R34|R35" SECURITY.md | wc -l                                # ≥2
grep "pip install" scripts/install-vllm.sh | grep "vllm=="            # pinned version
```

Open every audit-flagged file diff. Reject + dispatch fix-implementer if any auditor said REJECTED or APPROVED-WITH-FIXES with non-trivial fixes.

---

### Phase 4 — BLESS round (Ring of Elders on shipped code)

8 elders default scope. Each receives: paths to W1 commits + actual files + their original Round-1 concerns to verify against.

Synthesize: BLESSED / BLESSED-WITH-CONCERNS / NOT-BLESSED. Address blockers; defer non-blockers to `docs/PI_COMMS_V0_3_1_FOLLOWUPS.md` (NEW; mirror v0.3 followups doc).

---

### Phase 5 — Reply MiB to GB10

Single commit. Acknowledges all 6 implementations + signal-handler boot fix + flags vLLM probe-PASS dependency back to GB10. Cites all commit SHAs.

---

## Pitfalls catalog (v2)

1. **F1 drop daemon prefix vs. strip helper** — both must land in same commit. Dropping the daemon prefix without the strip leaves residual model emissions; the strip without the drop is a band-aid that doesn't address source. Test both pre-strip and post-strip behavior.
2. **F1 strip placement** — apply in `formatChannelEvent` for `case "reply"` ONLY, NOT post-format. The post-format text contains `pi: ✅ done.` from v0.2.x history that's been migrated; we want to preserve the daemon's own brand IF it ever uses similar prefix in future.
3. **F1 strip empty result** — `stripFalseSuccessPrefix("pi: ✅ done.")` returns `""`. Verify chunkOutbound handles empty string OR add fallback.
4. **F3 predicate two-pronged** — both branches must land. The classifier-block path (`text.startsWith("blocked:")`) catches synthetic denials; the new `sandboxDenied` flag catches real-exec denials. Missing either means missed-bug class.
5. **F3 cross-task reset** — counter, firstDenialMonotonicMs, lastCmdHashFirst8, AND loopBreakerEmittedThisTask all reset at task-start.
6. **F3 escape message no `pi:` prefix** — the `system_notice` formatter adds its own glyph; adding `pi:` inside the text would mimic agent voice (security W3 collision risk).
7. **F3 audit payload scalars-only** — `extra` schema is `z.record(z.union([z.string(), z.number(), z.boolean()]))`. No nested objects. `last_cmd_hash_first8` is a string.
8. **F4 STUDIO_DOCTOR_PORT_RANGE strict parse** — fail loud on NaN, missing-dash, range>100. Silent skip is worse than refusal.
9. **F4 hardcoded loopback** — NEVER add a `STUDIO_DOCTOR_HOST` env var. If a future operator wants LAN scan, they file a separate ticket. R35 invariant.
10. **F4 content sanitization** — `studio_root_id` and `loaded` from `/api/health` are operator-input from a network response. Truncate + ASCII-filter before printing to protect against terminal-hijack.
11. **F7 apiKey env-var pattern** — `"VLLM_API_KEY"` (uppercase, matches `check-env.js` regex). NOT literal `"vllm"`.
12. **F7 vLLM version pinning** — `pip install "vllm==0.6.5"` (or whatever version GB10 probes against). Bumping requires re-probe.
13. **F7 GPU contention** — INSTALL-VLLM.md MUST warn about Studio + vLLM running both with large models simultaneously (unified-memory OOM on GB10).
14. **F8 bootCompleted flag** — set to `true` AFTER IPC socket binds. Signal handler checks it; pre-bind shutdown is exit 2, post-bind is exit 0.
15. **F8 redactBotToken in stderr** — defensive; the configured baseUrl shouldn't have credentials but apply redactor anyway.
16. **F8 DaemonOpts injection backward-compat** — existing callers of `start({})` don't pass `studioModelWaitMs`. Default to existing constant. Don't break production.
17. **W1.0 sequencing** — IMPL-W1.0 (audit schema) MUST commit BEFORE IMPL-4 (which uses the new event kind). Without this, IMPL-4's intermediate commit fails `tsc --noEmit`. Mirror v0.3 G7 pattern.
18. **Cross-machine push discipline** — DO NOT `git push` between W1 commits. Push only after Phase 3 personal-verify OR Phase 5 reply MIB.
19. **vLLM probe verdict honesty** — `examples/models.vllm.json` ships with "PENDING" verdict marker. Upgrade to "PASS — verified YYYY-MM-DD" only after GB10's probe MIB returns.
20. **F1 daemon-prefix-drop affects downstream consumers** — anyone parsing daemon output for `✅` patterns (operator log scrapers, dashboards) needs to know. Mention in commit message + reply MIB.

---

## Out of scope (no v0.3.1 ticket — tracked in followups)

- **F2 v4 prompt rewrite** — DROPPED. v3 prompt has zero `✅`/`done.` references; nothing to remove. If future model behavior requires explicit anti-pattern instruction, ship as v0.4 ticket with empirical evidence.
- **`/unsand` mobile-friendly variant** — design conversation per F6 (logs only).
- **Studio launch-studio.sh upstream WARN patch** — file as Studio-side bug.
- **vLLM as default backend** — explicit no.
- **deep-agents replacement** — DROPPED.
- **pi-mono package rename** — DEFERRED.
- **vLLM cross-quant probe matrix** — v0.4.
- **Studio-side fix for `mem_get_info`** — file as Studio-side bug.
- **Heartbeat source rename** — v0.4 (existing followup #5).
- **Non-English locale sandbox-denial markers** — F3 predicate is English-only. Accepted limitation.
- **`telegram_poll_silent_burst` defense-in-depth catcher** — v0.4 (existing followup #8).
- **Per-Bot undici dispatcher** — v0.4 (existing followup #1).
- **AppContainer sandbox on Windows** — v2.

---

## Verification gates

```bash
# Pre-W1
git log --oneline -3                # head should be bf777d7
npx tsc --noEmit                    # clean baseline
npx vitest run                      # 1005/1005 pass + 7 platform-skip

# Post-W1.0 (audit schema)
npx tsc --noEmit                    # clean
npx vitest run                      # +2 audit schema tests = 1007

# Post-W1.1 (all implementers)
npx tsc --noEmit                    # clean
npx vitest run                      # +25 tests = ~1032
git diff bf777d7..HEAD -- "tests/**" | grep -cE '^\+\s*(it|test)\('  # ≥ 25
git status                          # clean

# Pre-ship
grep -c "stripFalseSuccessPrefix\|sandboxDenied\|sandbox_denial_loop_broken\|daemon_boot_failed" src/  # ≥6
grep "127.0.0.1" scripts/studio-doctor.js                            # 1
grep -c "VLLM_API_KEY\|authHeader" examples/models.vllm.json         # 2
grep -E "R34|R35" SECURITY.md                                        # both present
node -e "const v = JSON.parse(require('fs').readFileSync('examples/models.vllm.json', 'utf8')); console.log(v.providers['vllm-local'].apiKey, v.providers['vllm-local'].authHeader)"
# Expected output: VLLM_API_KEY false
```

---

## Executor handoff

7-stage pipeline (per `~/.claude/rules/agent-orchestration.md`):
- **W1.0 + W1.1**: parallel `general-purpose` subagents per group, `10x-engineer:test-driven-development` + `verification-before-completion` required
- **W2 audit**: 5 parallel auditors with `10x-engineer:testing-anti-patterns` + `verification-before-completion`
- **W3 personal verify**: orchestrator runs all gates, reads audit-flagged diffs personally
- **W4 BLESS**: 8-elder default scope on shipped W1 code; iterate on blockers; defer non-blockers to v0.3.1 followups doc
- **W5 MIB**: reply to GB10 with all SHAs + vLLM probe handoff

Each subagent prompt MUST cite this plan + step number + skill names + commit-message template.

---

*Last updated: 2026-05-10 by dev-box orchestrator (Mac), v2 — folds 13 convergent Round 1 elder findings + drops Phase 5 (F2 v4 prompt) per empirical disconfirmation. Ready for narrow re-bless of 3 NOT-APPROVED elders (Architect, Adversarial, UX Advocate).*
