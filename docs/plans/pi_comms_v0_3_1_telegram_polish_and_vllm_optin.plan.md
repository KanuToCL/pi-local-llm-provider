# Plan v1: pi-comms v0.3.1 — Telegram UX Polish + Studio Hygiene + vLLM Opt-in Backend

> **Source**: GB10 Claude's MIB-2026-05-09-{0103, 1126, 2305} bundle — three live-fire findings across two operator sessions on gx10-831a.
> **Predecessor**: v0.3 SHIPPED CLEAN — GrammY transformer + watchdog + system prompt OS hint + token redactor (8 elders BLESSED, 1005 tests pass).
> **Date**: 2026-05-09 PT
> **Author**: Dev-box Claude (Mac orchestrator)
> **Plan version**: v1 (first draft, pre-elder)
> **Plan output dir**: `docs/plans/` (per existing repo convention; matches v0.3 plan placement)

**Goal**: Close the four telegram-side UX bugs GB10 found in live use (false-success ✅ framing, sandbox-denial retry loop, swap-detect false-positive, dup-Studio detection) AND ship vLLM as an opt-in backend variant alongside Studio (architecture pre-supports this; pure config + docs + scripts; zero `src/` changes for the backend swap itself) — without regressing v0.3's polling resilience or v0.2.2's termination correctness.

**Architecture**: Six independent subsystems, each with surgically minimal blast radius:
- **F1** (✅-strip): defensive regex in `TelegramChannel` outbound, NO model dependency. Band-aid that ships now to stop active UX bleeding.
- **F2** (system-prompt v4): root fix for F1 — bump `coding-agent.v3.txt → v4.txt`, remove the success-marker convention the model is over-generalizing. Lands in **Phase 5** AFTER F1 stabilizes (per GB10 MIB-2305 §1: "Don't ship both at once — they'd interact").
- **F3** (sandbox-denial loop-breaker): per-task counter in `SessionManager`, injects single user-facing escape message after N consecutive bash-denials. New audit event `sandbox_denial_loop_broken`.
- **F4** (`studio-doctor.js`): read-only port scanner (8888-8908), parses `/api/health` `studio_root_id`, prints one-line table when >1 Studio answers. NO auto-actions.
- **F5+F6** (docs only): `GB10_UNSLOTH_SETUP.md` §5B "Known quirks" for the cosmetic VRAM warning + `PI_COMMS_V0_3_FOLLOWUPS.md` log entry for `/unsand` mobile-friendly variant (deferred design conversation).
- **F7** (vLLM opt-in backend): promote `examples/models.vllm.json` skeleton → passing matrix row; new `docs/INSTALL-VLLM.md`; new `scripts/install-vllm.sh`; README backend section update. **Zero `src/` changes** — the architecture is provider-agnostic by design (`docs/ARCHITECTURE.md` §1).
- **F8** (`pi-comms run` boot fix): the foreground-runner exits code 0 during the studio-readiness gate when Studio's model isn't loaded (per MIB-2305 §5). Fix the gate to surface the real failure or block until ready, not silently exit.

**Tech Stack**: TypeScript ESM (Node ≥20), vitest, grammY ^1.21, Baileys 7.0.0-rc.9 (optional), Python venvs for vLLM (subprocess only — no daemon dependency on Python).

---

## Files to modify

| File | Reason | Implementer |
|---|---|---|
| `src/channels/telegram.ts` | F1 — strip leading `✅ done.` (and other model-emitted false-success markers) from each outbound chunk in the `chunkOutbound` integration path |  IMPL-1 |
| `src/session.ts` | F3 — per-task counter in handleInbound's tool-result observer + escape-message injection after threshold |  IMPL-5 |
| `src/audit/schema.ts` | F3 — add `sandbox_denial_loop_broken` event kind to `AuditEventTypeSchema` |  IMPL-5 |
| `prompts/coding-agent.v3.txt` | F2 — KEEP (regression-guard fixture + rollback fallback per Plan v3 Pitfall #9 discipline) — **NOT modified in v0.3.1** |  Phase 5 |
| `src/lib/system-prompt.ts` | F2 (Phase 5) — default `basePromptPath` v3→v4 bump |  Phase 5 |
| `src/session.ts:380` (default path constant) | F2 (Phase 5) — same bump |  Phase 5 |
| `tests/system-prompt.test.ts` | F2 (Phase 5) — add `EXPECTED_SHA256_V4` pin (LF-normalized); KEEP existing `EXPECTED_SHA256_V3` pin (regression guard for fallback) |  Phase 5 |
| `tests/channels/telegram.test.ts` | F1 — test that `✅ done.` prefix is stripped before send |  IMPL-1 |
| `tests/session.test.ts` | F3 — test loop-breaker fires after N consecutive denials + emits audit row |  IMPL-5 |
| `tests/audit/schema.test.ts` | F3 — positive parse for new event kind |  IMPL-5 |
| `docs/GB10_UNSLOTH_SETUP.md` | F5 — new §5B "Known quirks" section with the mem_get_info/unified-memory cosmetic warning explanation |  IMPL-3 |
| `docs/PI_COMMS_V0_3_FOLLOWUPS.md` | F6 — new entry (#27?) for `/unsand` mobile-friendly variant; design discussion deferred |  IMPL-3 |
| `README.md` | F7 — Backends section: add vLLM as third opt-in backend with link to new INSTALL-VLLM.md; matrix row update |  IMPL-4 |
| `examples/models.vllm.json` | F7 — promote from "UNTESTED skeleton" → "passing matrix row"; remove placeholder model id; update `_comment` to reference the verdict commit |  IMPL-4 |
| `scripts/pi-launch.sh` | F4 — OPTIONAL one-line wire-up: invoke `studio-doctor.js` before `studio-status.js` when `STUDIO_DOCTOR=1` (defaults off so existing flow unchanged) |  IMPL-2 |
| `bin/pi-comms.ts` | F8 — fix the studio-readiness gate so it does NOT exit code 0 silently when Studio's model isn't loaded (root-cause first; see Pitfall #4) |  IMPL-6 |

## Files to create

| File | Reason | Implementer |
|---|---|---|
| `scripts/studio-doctor.js` | F4 — Node script, zero-deps, scans 8888-8908 for `/api/health` responders, prints `studio_root_id` per port. Exit 0 always (informational). |  IMPL-2 |
| `docs/INSTALL-VLLM.md` | F7 — peer to existing `docs/INSTALL.md`. Covers GGUF→safetensors decision tree, vLLM serve invocation, `--served-model-name` alignment so models.json swap is one line, probe gate. |  IMPL-4 |
| `scripts/install-vllm.sh` | F7 — idempotent, dry-run flag, follows `install-systemd.sh` pattern. Creates a venv, installs vLLM, prints the recommended `vllm serve` invocation for Qwen3.6-27B with structured tool-calling. |  IMPL-4 |
| `prompts/coding-agent.v4.txt` | F2 (Phase 5) — copy of v3 with the success-marker convention removed (per IMPL-7 brief) |  Phase 5 |

---

## Wave plan

| Wave | Group | Files | Owner | Sequencing |
|---|---|---|---|---|
| **W0** | Diagnostic — `ss -tlnp \| grep ':888[0-9]'` on GB10 | (none) | GB10 Claude | sequential, ~30 sec; result determines F4 urgency tier (fix-now if dup confirmed; defense-in-depth otherwise). Asynchronous to dev-box work. |
| **W1.1** | F1 — `✅` strip in TelegramChannel outbound | `src/channels/telegram.ts`, `tests/channels/telegram.test.ts` | IMPL-1 | parallel after W0 |
| **W1.1** | F4 — studio-doctor scanner | `scripts/studio-doctor.js` (NEW), `scripts/pi-launch.sh` | IMPL-2 | parallel after W0 |
| **W1.1** | F5+F6 — docs additions | `docs/GB10_UNSLOTH_SETUP.md`, `docs/PI_COMMS_V0_3_FOLLOWUPS.md` | IMPL-3 | parallel after W0 |
| **W1.1** | F7 — vLLM opt-in scaffolding | `examples/models.vllm.json`, `docs/INSTALL-VLLM.md` (NEW), `scripts/install-vllm.sh` (NEW), `README.md` | IMPL-4 | parallel after W0 |
| **W1.1** | F3 — sandbox-denial loop-breaker | `src/session.ts`, `src/audit/schema.ts`, `tests/session.test.ts`, `tests/audit/schema.test.ts` | IMPL-5 | parallel after W0 |
| **W1.1** | F8 — `pi-comms run` boot fix | `bin/pi-comms.ts`, possibly `src/daemon.ts` (root-cause-dependent) | IMPL-6 | parallel after W0 |

**File-disjointness verified.** No two W1.1 implementers touch the same file.
- IMPL-1 owns `src/channels/telegram.ts` (outbound formatter section); IMPL-5 owns `src/session.ts` + `src/audit/schema.ts`. F1 and F3 are file-disjoint.
- IMPL-2 owns `scripts/pi-launch.sh` (F4 wire-up). No other implementer touches it.
- IMPL-4 owns `README.md`. IMPL-3's docs are all under `docs/` — no overlap.
- IMPL-6 may touch `src/daemon.ts` if F8's root cause is in the boot sequence; IMPL-5 touches `src/session.ts` not daemon.ts. Disjoint.

| **W2** | Audit Wave — 5 parallel auditors | (read-only) | AUDIT-A...E | after all W1.1 commits land |
| **W3** | Personal verify (orchestrator) | (read-only) | dev-box Claude | after W2 |
| **W4** | BLESS round (Ring of Elders) | (read-only) | 8 elders | after W3 |
| **W5** | F2 system-prompt v3→v4 sub-cycle | `prompts/coding-agent.v4.txt` (NEW), `src/lib/system-prompt.ts`, `src/session.ts`, `tests/system-prompt.test.ts` | IMPL-7 | sequential after W4; only AFTER W1's F1 has been verified as the band-aid that holds |
| **W6** | Reply MiB to GB10 | `docs/MIB-2026-05-XX-XXXX.md` (NEW) | dev-box Claude | after W5 |

---

## Step-by-step plan

### Phase 0 — Pre-work + diagnostic

#### Step 0.1 — Confirm pre-conditions (dev-box)

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
git log --oneline -5                          # head should be d57bbcd or later
npx tsc --noEmit                               # clean baseline
npx vitest run --reporter=basic 2>&1 | tail -5 # 1005/1005 pass + 7 platform-skip + 0 fail
```

If baseline doesn't match, STOP — investigate before proceeding.

#### Step 0.2 — Diagnostic ask to GB10 (asynchronous)

Send (via MIB or in-channel) the single command:

```bash
ss -tlnp | grep ':888[0-9]'
```

**Branch on result:**
- **>1 listener**: dup-Studio confirmed. F4 `studio-doctor.js` becomes a fix-now priority + the v0.3.1 reply MIB asks GB10 to kill the duplicate before resuming. The MIB-2305 §3a P1 hypothesis is confirmed.
- **1 listener** (or 0): not dup-Studio. F4 ships as defense-in-depth; MIB-2305 §3a falls to P2 (Studio LRU auto-unload) or P3 (swap-detect bug). If the latter, file a separate bug — out of scope for v0.3.1.

The diagnostic does NOT block W1.1 — F4 ships either way; only the urgency framing changes.

---

### Phase 1 — Wave 1 (six parallel implementers, file-disjoint)

#### Step 1.1 — IMPL-1 (F1: `✅`-strip in TelegramChannel outbound)

**Files**: `src/channels/telegram.ts`, `tests/channels/telegram.test.ts`.

**Surface area**: the outbound `send()` path. Identify the function or method that calls `chunkOutbound(text, chunkSize)` and bot.api.sendMessage per chunk (per `src/channels/telegram.ts:195-198` JSDoc).

**1.1a — Add a helper** at module scope:

```typescript
/**
 * Strip model-emitted false-success markers from an assistant text block
 * BEFORE chunking + sending. The local Qwen3.6 class over-generalizes the
 * system-prompt's success-marker convention (see prompts/coding-agent.v3.txt
 * "✅ done" pattern) — emitting the marker even when the wrapped tool call
 * returned an error.
 *
 * On Telegram this reads as the bot succeeded N times in a row while
 * manifestly nothing worked (per MIB-2026-05-09-2305 §1 transcript).
 *
 * Defense:
 *   - Defensive REGEX strip applied at outbound formatting time.
 *   - Surface-only — does NOT alter pi-mono's session log or audit-log
 *     content; only the user-visible Telegram render.
 *   - Phase 5 (F2) addresses the root cause via system-prompt v4 rewrite,
 *     at which point this helper becomes a no-op (kept as defense-in-depth
 *     so a future model regression doesn't re-introduce the UX bleed).
 */
const FALSE_SUCCESS_PREFIX_RE = /^(?:\s*✅\s*done\.?\s*\n?)+/i;

export function stripFalseSuccessPrefix(text: string): string {
  return text.replace(FALSE_SUCCESS_PREFIX_RE, "");
}
```

**1.1b — Apply at the outbound boundary**, immediately before `chunkOutbound`:

```typescript
const cleanText = stripFalseSuccessPrefix(text);
for (const chunk of chunkOutbound(cleanText, chunkSize)) {
  await bot.api.sendMessage(activeChatId, chunk);
}
```

**1.1c — Tests** (`tests/channels/telegram.test.ts` extension):

- `stripFalseSuccessPrefix("✅ done. The sandbox seems to be having issues...") → "The sandbox seems to be having issues..."` (single prefix)
- `stripFalseSuccessPrefix("✅ done.\n✅ done. Let me try...") → "Let me try..."` (multi-prefix; alternation regex)
- `stripFalseSuccessPrefix("Plain reply with ✅ done. embedded mid-text") → unchanged` (only LEADING markers)
- `stripFalseSuccessPrefix("") → ""` (empty)
- `stripFalseSuccessPrefix("done.") → "done."` (no marker; unchanged)

**1.1d — Commit**:
```bash
git add src/channels/telegram.ts tests/channels/telegram.test.ts
git commit -m "fix(telegram): strip model-emitted false-success ✅ prefix from outbound (F1 v0.3.1)

Per gx10-831a MIB-2026-05-09-2305 §1.  Local Qwen3.6 class over-
generalizes the system-prompt's success-marker convention, emitting
✅ done. as a prefix to messages that immediately say the tool call
failed.  Defensive band-aid; root-fix lands in Phase 5 (F2 system-
prompt v4 rewrite).  Helper kept after F2 ships as defense-in-depth."
```

---

#### Step 1.2 — IMPL-2 (F4: `studio-doctor.js` scanner)

**Files**: `scripts/studio-doctor.js` (NEW), `scripts/pi-launch.sh` (one-line opt-in wire-up).

**1.2a — Write `scripts/studio-doctor.js`**: Node ≥20, zero deps. Scans `127.0.0.1` ports 8888-8908, hits `GET /api/health` with a 500ms timeout, parses `studio_root_id`, prints a one-line table.

```javascript
#!/usr/bin/env node
/**
 * studio-doctor — read-only Unsloth Studio multiplicity scanner.
 *
 * Per gx10-831a MIB-2026-05-09-1126 §1: Studio's launch-studio.sh silently
 * port-hops to :8889 (then :8890, etc.) when an existing healthy Studio
 * has a different `studio_root_id`. The user has no signal that two
 * Studios are running, and pi-mono routes to whichever the configured
 * `baseUrl` happens to resolve to — which may not have the model the
 * user intends.
 *
 * This scanner is read-only by design: it observes, names, and exits.
 * No port killing, no Studio-side mutation, no auto-baseUrl-rewrite.
 * That kind of "helpful" auto-action is the kind of thing that hurts
 * the next agent's debug session — see Plan v3 Pitfall #1 for prior art.
 *
 * Exit 0 always (informational).  STUDIO_QUIET=1 suppresses output.
 *
 * Usage:
 *   node scripts/studio-doctor.js
 *   STUDIO_DOCTOR_PORT_RANGE=8888-8898 node scripts/studio-doctor.js
 */

const RANGE = (process.env.STUDIO_DOCTOR_PORT_RANGE ?? "8888-8908")
  .split("-").map(Number);
const TIMEOUT_MS = 500;
// ... scan loop, fetch with AbortController timeout, parse JSON,
//     pretty-print port + studio_root_id (truncated 8 hex chars) + status
```

Implementer fills in the scan loop. Per-port `fetch('http://127.0.0.1:<p>/api/health', { signal: AbortSignal.timeout(TIMEOUT_MS) })` then JSON parse. Output format:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Studio doctor — scanning 127.0.0.1:8888-8908
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  :8888  studio_root_id=9641c062  status=healthy  loaded=Qwen3.6-27B-GGUF
  :8889  studio_root_id=12ab34cd  status=healthy  loaded=Qwen3.6-35B-A3B
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠ More than one Studio responded.  pi-mono routes to whichever
   `baseUrl` in ~/.pi/agent/models.json resolves to.  If you didn't
   intentionally start a second Studio, kill the unintended one
   (see launch-studio.sh — _check_health rejects on studio_root_id
   mismatch and silently spawns a duplicate; MIB-2026-05-09-1126 §1).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

When only one Studio responds: print one-line OK and exit. When zero respond: print one-line "no Studio detected" and exit (not a doctor failure — Studio just isn't running).

**1.2b — Wire optional invocation in `pi-launch.sh`**: ONE line, gated on `STUDIO_DOCTOR=1`. Defaults off so existing `pi-launch.sh` flow is byte-identical for users who don't opt in.

```bash
[ "$STUDIO_DOCTOR" = "1" ] && node "$(dirname "$0")/studio-doctor.js"
```

**1.2c — Tests**: omit per scope (zero-dep informational script; test surface is mostly process.exit and stdout). If tests are added, they go to `tests/` as a separate `studio-doctor.test.js` mocking fetch.

**1.2d — Commit**:
```bash
git add scripts/studio-doctor.js scripts/pi-launch.sh
git commit -m "feat(scripts): studio-doctor.js — read-only multiplicity scanner (F4 v0.3.1)

Per gx10-831a MIB-2026-05-09-1126 §1.  Studio's launch-studio.sh silently
port-hops + spawns duplicate instances on studio_root_id mismatch; pi-mono
routes to whatever the configured baseUrl resolves to.  Scanner is read-
only by design: observes + names + exits.  No port killing, no Studio-side
mutation.  Opt-in via STUDIO_DOCTOR=1 in pi-launch.sh."
```

---

#### Step 1.3 — IMPL-3 (F5+F6: pure docs)

**Files**: `docs/GB10_UNSLOTH_SETUP.md`, `docs/PI_COMMS_V0_3_FOLLOWUPS.md`.

**1.3a — F5 GB10 §5B "Known quirks"** — add the section per GB10 MIB-0103 §3 suggested copy. Insert AFTER §5A Option A (the Studio install section) and BEFORE Option B (llama-server). Renames the old "Choose ONE based on your priority" section to allow inserting a §5B without breaking flow.

```markdown
### 5B. Known Studio quirks on GB10 (worth knowing before you tune ctx)

#### Studio's "Exceeds estimated VRAM" warning is cosmetic on Grace-Blackwell

When the chat-settings slider goes above 4096, the UI may flash:
> "Exceeds estimated VRAM capacity (4,096 tokens). The model may use
> system RAM."

**Ignore it on GB10.** ...[full GB10-suggested copy]...
```

**1.3b — F6 followups entry** — append to `docs/PI_COMMS_V0_3_FOLLOWUPS.md` as a new item (next sequential ID, presumably #27).

```markdown
### #27 — `/unsand` mobile-friendly variant for legitimately-blocked users

**Source:** GB10 Claude MIB-2026-05-09-2305 §2 (live-fire trace).

**Concern:** The first-session ack policy for `/unsand` requires a terminal
ack — sound default for the threat model in `docs/DESIGN.md` (untrusted
Telegram message widens local filesystem access).  But the live transcript
caught the case where the user is mobile, the desk is unavailable
("hmm i cant"), the agent is stuck in a sandbox-denial loop, and there is
no escalation path.

**Why deferred:** This is a threat-model conversation, not a code change.
Two design alternatives both have non-trivial trade-offs:
  (a) Time-bounded `/unsand` from a verified senderId authenticated at the
      desk in the past 24h.
  (b) A reduced "/look-around" verb that widens reads (only) without
      needing a full `/unsand`.

(b) is structurally safer (read-only blast radius), but lands an
asymmetry between read-vs-write privileges that the current state machine
doesn't model.  Belongs in design review with the operator before
implementation.

**v0.4 ticket:** Open a design-review thread; pick (a) vs (b) vs neither;
implement only after threat-model alignment.

**File:** `src/commands/slash.ts` (slash-router) + `src/sandbox/policy.ts`
(if (b) chosen).
```

**1.3c — Commit**:
```bash
git add docs/GB10_UNSLOTH_SETUP.md docs/PI_COMMS_V0_3_FOLLOWUPS.md
git commit -m "docs: GB10 §5B Known quirks + /unsand mobile followup (F5+F6 v0.3.1)

Per gx10-831a MIB-2026-05-09-{0103, 2305}.  §5B documents that Studio's
'Exceeds estimated VRAM' warning is cosmetic on Grace-Blackwell unified
memory (mem_get_info doesn't model the unified pool correctly).  Followup
#27 logs the /unsand mobile-user blocking gap; design-review-first, not a
code change."
```

---

#### Step 1.4 — IMPL-4 (F7: vLLM opt-in scaffolding)

**Files**: `examples/models.vllm.json` (modify), `docs/INSTALL-VLLM.md` (NEW), `scripts/install-vllm.sh` (NEW), `README.md` (modify).

**v0.3.1 explicit constraint** (per Sergio's framing in MIB-2305 §6 + GB10's softening):
- vLLM ships as **opt-in** alongside Studio. Studio remains the documented default.
- **Zero `src/` changes**. All daemon/channel/sandbox code is provider-agnostic.
- README must keep production-box's Studio path as the canonical install. vLLM is a footnote / "for Linux+CUDA boxes that want more speed".

**1.4a — Promote `examples/models.vllm.json`**:

Drop the `_comment`'s "UNTESTED skeleton" hedge. Replace with:

```json
"_comment": "pi-mono custom-provider config for vLLM (verified PASS 2026-05-XX on GB10 / Qwen3.6-27B-Instruct BF16 — see CONTRIBUTING.md probe verdict matrix). Default port :8000.  Replace `models[].id` with the value vLLM reports at /v1/models (must match vLLM's --served-model-name).  Pre-req: vLLM started with --enable-auto-tool-choice --tool-call-parser hermes for Qwen3-class models. Schema reference: <pi-coding-agent>/docs/models.md."
```

Replace `REPLACE_WITH_YOUR_MODEL_ID` placeholder with the actual probed model id (TBD by GB10's probe — `unsloth/Qwen3.6-27B-GGUF` if `--served-model-name` aligned, else the canonical HF id).

Update `cost` block: keep zeros (local).

Keep the apiKey literal `"vllm"` placeholder — vLLM's auth is opt-in via `--api-key` at server launch.

**1.4b — Write `docs/INSTALL-VLLM.md`** (NEW). Sections:
1. **Why vLLM is an opt-in alternative to Studio.** Trade-off table: vLLM = order-of-magnitude faster decode (CUDA graph + paged attention; predicted 30-60 tok/s on GB10 vs Studio's 5.83) but second-class GGUF support + no GUI + structured-output via `outlines`/`lm-format-enforcer` (less battle-tested with Qwen3 chat template than llama.cpp's `--jinja`).
2. **Pre-req.** Linux/CUDA box + Python 3.12 + the model in BF16 safetensors form (or convert from GGUF — script provided).
3. **Install path.** `scripts/install-vllm.sh` step-by-step.
4. **Launch invocation.** Recommended `vllm serve <model> --enable-auto-tool-choice --tool-call-parser hermes --served-model-name <pi-mono-id>` so models.json swap is one-line.
5. **Probe gate.** Same `node scripts/probe-toolcalls.js` with `PROBE_ENDPOINT=http://localhost:8000/v1`. PASS gate is non-negotiable before production use.
6. **models.json swap.** `cp examples/models.vllm.json ~/.pi/agent/models.json` (or merge), `chmod 600`.
7. **Co-existence with Studio.** Both can run simultaneously on different ports; pi-mono just resolves whichever provider you pass `--provider <id>` for.
8. **When to use vLLM vs Studio.** Decision tree.

**1.4c — Write `scripts/install-vllm.sh`** (NEW). Idempotent, dry-run flag (`-n`), follows `install-systemd.sh` pattern. Steps:
1. Detect platform (refuse non-Linux with a clear message — vLLM on macOS is not supported by upstream).
2. Detect CUDA (warn but don't refuse — CPU-only vLLM is technically possible but not recommended).
3. Create `~/.venvs/vllm/` (separate from `~/.venvs/unsloth/`).
4. `pip install vllm`.
5. Print the recommended `vllm serve` command tailored to the user's hardware (parsed from `nvidia-smi`).
6. Print pointers to INSTALL-VLLM.md for the next steps (model download, probe, models.json).

NO auto-run of `vllm serve` — operator decides when to start the server.

**1.4d — Update `README.md`**:
- Backends matrix (line 228-233): change vLLM row from "untested skeleton" to "PASS — verified by gx10-831a 2026-05-XX (Qwen3.6-27B-Instruct BF16)" with link to `docs/INSTALL-VLLM.md`.
- New short subsection under "Three-step install" or near the top: "Backends (Studio default, vLLM opt-in)" — one paragraph each, link out to per-backend INSTALL doc.
- Production-box parity note: "If you're on Windows or want guaranteed compatibility with the verified production-box stack, use Studio (default). vLLM is recommended for Linux+CUDA boxes wanting higher throughput."

**1.4e — Commit**:
```bash
git add examples/models.vllm.json docs/INSTALL-VLLM.md scripts/install-vllm.sh README.md
git commit -m "feat(backends): vLLM as opt-in backend variant (F7 v0.3.1)

Per Sergio's framing in MIB-2305 §6 — vLLM ships opt-in alongside
Studio (default unchanged for production-box parity).  Zero src/
changes: pi-comms architecture is provider-agnostic by design
(docs/ARCHITECTURE.md §1).

- examples/models.vllm.json: skeleton → passing matrix row
- docs/INSTALL-VLLM.md: peer to INSTALL.md; install + probe + co-exist
- scripts/install-vllm.sh: idempotent installer + dry-run
- README.md: backends matrix updated; opt-in framing"
```

**Note**: the actual probe PASS verdict in `examples/models.vllm.json` `_comment` is contingent on GB10's probe run. Until GB10 runs `node scripts/probe-toolcalls.js` against vLLM and reports back, the example file lands with a "VERIFIED 2026-05-XX (PENDING)" placeholder; date + verdict line gets a follow-up commit when GB10's MIB lands the result.

---

#### Step 1.5 — IMPL-5 (F3: sandbox-denial loop-breaker)

**Files**: `src/session.ts`, `src/audit/schema.ts`, `tests/session.test.ts`, `tests/audit/schema.test.ts`.

**Surface area**: the session's tool-result observer path. Counter increments on each bash-tool result with `aborted=true` AND `denied-by-sandbox` semantics (per `src/sandbox/exec.ts:75-77` `aborted` field + the policy.ts denial rendering). Counter resets on any successful tool call.

**1.5a — New event kind in `src/audit/schema.ts`**:

```typescript
// v0.3.1 — Sandbox-denial loop-breaker (F3, MIB-2305 §4).  Fires when
// the daemon detects N consecutive sandbox-denied bash invocations within
// a single task and injects a user-facing escape message naming /unsand
// as the path forward.  `extra.consecutive_denials` carries the count;
// `extra.task_id` is the in-flight task.
"sandbox_denial_loop_broken",
```

Add positive parse test in `tests/audit/schema.test.ts`.

**1.5b — Counter + injection in `src/session.ts`**:

Identify the tool-result fan-out point in `SessionManager` (around `pi-mono`'s `onToolResult` callback or the `defineSandboxedBashTool` wrapper at line 62). Track per-task:
```typescript
private consecutiveSandboxDenials = 0;
private readonly SANDBOX_DENIAL_LOOP_THRESHOLD = 3;  // tunable; conservative
```

On every bash tool result:
- IF result indicates sandbox denial (canonical signal — see Pitfall #6 for exact predicate):
  - `consecutiveSandboxDenials++`
  - IF `consecutiveSandboxDenials >= THRESHOLD` AND `loopBreakerEmitted === false` (per-task):
    - Inject ONE system_notice via the configured Sink: `"pi: I'm being blocked by the sandbox on every attempt. Reply /unsand to widen access (requires terminal ack), or rephrase what you want me to find."`
    - Audit `sandbox_denial_loop_broken` with `extra.consecutive_denials = N`, `extra.task_id`.
    - Set `loopBreakerEmitted = true` so the message fires exactly once per task (avoid spam).
- ELSE (non-denial result): `consecutiveSandboxDenials = 0; loopBreakerEmitted = false`.

Reset both at task-start (in handleInbound's task-creation path).

**1.5c — Tests** (`tests/session.test.ts`):
- 3 consecutive denials → inject fires + audit row + `loopBreakerEmitted=true`.
- 4th denial after injection → NO second injection (one-shot per task).
- Successful tool call between denials resets counter; need 3 NEW consecutive denials to fire.
- Cross-task: counter resets on next task; loop-breaker can fire again for the new task.

**1.5d — Commit**:
```bash
git add src/session.ts src/audit/schema.ts tests/session.test.ts tests/audit/schema.test.ts
git commit -m "feat(session): sandbox-denial loop-breaker (F3 v0.3.1)

Per gx10-831a MIB-2026-05-09-2305 §4.  After N=3 consecutive sandbox-
denied bash calls within a single task, inject one user-facing system
notice naming /unsand as the path forward + audit
'sandbox_denial_loop_broken'.  One-shot per task; counter resets on any
successful tool call or on task-start.  Bounds the unproductive-retry-
loop UX failure mode the Telegram transcript exhibited."
```

---

#### Step 1.6 — IMPL-6 (F8: `pi-comms run` boot fix)

**Files**: `bin/pi-comms.ts`, possibly `src/daemon.ts` (root-cause-dependent).

**Per MIB-2305 §5**: "The `pi-comms run` boot path itself is currently exiting code 0 during the studio-readiness gate when Studio's model isn't loaded — root cause unconfirmed, deliberately deferred."

**1.6a — Root-cause investigation FIRST** (per `10x-engineer:root-cause-tracing` skill — never fix the symptom). Two candidate paths:

**A. The studio-readiness gate exits via wrong code path.**
Inspect `bin/pi-comms.ts:455+` (the `pi-comms run` subcommand). The gate likely waits for `loaded[]` to contain the configured model, but on timeout falls through a path that returns 0 instead of non-zero. The MIB hints at this with "exiting code 0... when Studio's model isn't loaded".

**B. The daemon's own studio-readiness check (in `src/daemon.ts:waitForStudioModelLoaded`) succeeds incorrectly when the model isn't loaded.**
Inspect `src/daemon.ts` for the `waitForStudioModelLoaded` call. Per the function's contract, it should wait up to `STUDIO_MODEL_WAIT_MS = 5min` for the model to load, then either return the loaded model id or throw. If it returns silently when the model never loads, that's the bug.

**1.6b — Fix at root cause**. Once identified:
- If A: ensure the gate exits non-zero when the model-load wait times out. Print a clear stderr message naming the configured model + URL + timeout.
- If B: add the throw to `waitForStudioModelLoaded`, ensure callers catch + propagate.

**1.6c — Test** (depends on root cause). At minimum: a hermetic test that boots the daemon with a stubbed Studio that never reports the model loaded; assert non-zero exit + stderr message.

**1.6d — Commit**:
```bash
git add bin/pi-comms.ts [+ src/daemon.ts if needed] tests/...
git commit -m "fix(cli): pi-comms run no longer silently exits 0 on Studio model-load timeout (F8 v0.3.1)

Per gx10-831a MIB-2026-05-09-2305 §5: pi-comms run was exiting code 0
during the studio-readiness gate when Studio's loaded[] never included
the configured model.  Root cause: <FILL IN AFTER INVESTIGATION>.
Fixed by: <FILL IN>.  Test asserts non-zero exit + clear stderr message
when boot stalls on model-not-loaded."
```

---

### Phase 2 — Audit Wave (5 parallel auditors)

| Auditor | Reviews | Spec |
|---|---|---|
| AUDIT-A | IMPL-1 F1 ✅-strip | Regex correctness, leading-only behavior, multi-prefix coverage, no over-strip on legit content |
| AUDIT-B | IMPL-2 F4 + IMPL-4 F7 (combined; both new files, similar concerns: scope discipline, side effects, defaults) | studio-doctor: read-only invariant; vLLM: zero src/ changes verified, opt-in framing intact, README parity not broken |
| AUDIT-C | IMPL-3 F5+F6 docs | §5B copy fidelity to GB10's MIB-0103 wording; followup #27 design alternatives clearly framed |
| AUDIT-D | IMPL-5 F3 loop-breaker | Counter reset semantics; cross-task isolation; one-shot-per-task; audit row schema correctness |
| AUDIT-E | IMPL-6 F8 boot fix | Root-cause-fixed (not symptom); test asserts the actual failure mode; no regression on successful boot path |

Each auditor invokes `10x-engineer:testing-anti-patterns` + `verification-before-completion`. NO rubber-stamps; if no real findings, justify why.

---

### Phase 3 — Personal verify (orchestrator)

```bash
git log --oneline -10                          # confirm 6 W1 commits + the BLESS sub-commits
git status                                     # clean
npx tsc --noEmit                               # clean
npx vitest run                                 # baseline 1005 + new tests (target: 1015+)
git diff <pre-W1>..HEAD -- src/ scripts/ examples/  # spot-read every diff
```

Open every audit-flagged file diff. Reject + dispatch fix-implementer if any auditor said REJECTED or APPROVED-WITH-FIXES with non-trivial fixes.

---

### Phase 4 — BLESS round (Ring of Elders on shipped W1 code)

8 elders (default scope: 5 core + 3 domain). Default scope: Architect, Adversarial, PE Skeptic, Integration, UX Advocate + Testing, Observability, Security.

Each elder receives: paths to W1 commits + actual files + their original Round-1 plan-stage concerns to verify against.

Synthesize: BLESSED / BLESSED-WITH-CONCERNS / NOT-BLESSED. Address blockers; defer non-blockers to `docs/PI_COMMS_V0_3_1_FOLLOWUPS.md` (NEW; mirror v0.3 followups doc).

---

### Phase 5 — F2 system-prompt v3→v4 sub-cycle

Sequential after W4 BLESS. Only proceeds if W1's F1 ✅-strip is verified holding in production (GB10 reports the strip works on real Telegram traffic).

#### Step 5.1 — IMPL-7 (F2 system-prompt v4)

**Files**: `prompts/coding-agent.v4.txt` (NEW), `src/lib/system-prompt.ts`, `src/session.ts:380`, `tests/system-prompt.test.ts`.

**5.1a — Create `prompts/coding-agent.v4.txt`**: copy v3 verbatim, then surgically remove the success-marker convention. Specifically:
- Find any line in v3 that prescribes `"✅ done"` or similar success-marker output (search v3 for `✅` and `done` patterns).
- Either delete the convention entirely OR replace with explicit anti-pattern: "Use `❌` ONLY when a tool call returned an error. Do NOT prefix successful or failed responses with any marker — the daemon adds appropriate framing based on the actual tool-result stream."

**5.1b — SHA pin discipline** (per Plan v3 §1.3d Testing B1):
1. Compute LF-normalized SHA256 of `prompts/coding-agent.v4.txt`.
2. Paste hex into `tests/system-prompt.test.ts` as `EXPECTED_SHA256_V4`.
3. KEEP existing `EXPECTED_SHA256_V3` pin (regression guard for fallback path).
4. Commit prompt + test together in one atomic commit.

**5.1c — Modify `src/lib/system-prompt.ts`**: bump default `basePromptPath` from `prompts/coding-agent.v3.txt` to `prompts/coding-agent.v4.txt`. Same for `src/session.ts:380` constant.

**5.1d — Tests**:
- SHA pin v4 (LF-normalized) — pinned to `EXPECTED_SHA256_V4`.
- SHA pin v3 (LF-normalized) — KEEP existing pin.
- Composed prompt with `hostOs: 'darwin'` does NOT contain `✅` or "done" marker prescriptions.
- Same for `hostOs: 'win32'` and `'linux'`.

**5.1e — Commit**:
```bash
git add prompts/coding-agent.v4.txt src/lib/system-prompt.ts src/session.ts tests/system-prompt.test.ts
git commit -m "feat(prompt): bump v3→v4 — remove success-marker convention (F2 v0.3.1)

Per gx10-831a MIB-2026-05-09-2305 §1 — root fix for the false-success
✅ done. UX bleed.  v3.txt's success-marker convention was the upstream
that local Qwen3.6 over-generalized into emitting the marker on tool
failures.  v4 removes the convention; defensive F1 strip in
TelegramChannel kept as defense-in-depth.  v3 preserved as fallback
fixture per Pitfall #9 discipline."
```

#### Step 5.2 — Light audit + verify on F2

Single auditor (AUDIT-F2). Personal verify. NO full BLESS round — F2 is a small, well-scoped prompt edit; the W4 BLESS round on W1 already cleared the architecture.

---

### Phase 6 — Reply MiB to GB10

Single commit. Acknowledges all 6 implementations + F2 + flags vLLM probe-PASS dependency back to GB10. Cites all commit SHAs. Same MiB pattern as previous replies.

---

## Pitfalls catalog

1. **F1 vs F2 sequencing** — they interact. Ship F1 (regex strip) in W1; F2 (system-prompt rewrite) only in Phase 5 after F1 has been verified holding in production. Per GB10's explicit guidance.

2. **studio-doctor scope creep** — the temptation to add "and pick the right one for you" or "and kill the wrong one" is real. RESIST. The script is read-only by design (Plan v3 Pitfall #1 prior art on additive-only scanners). Auto-actions in launchers create exactly the failure mode they claim to fix.

3. **vLLM probe verdict is contingent** — IMPL-4's commit lands the example file with a placeholder verdict pending GB10's probe run. The reply MIB (Phase 6) explicitly asks GB10 to probe vLLM-on-GB10 and report. Until that returns, the matrix row is "PENDING" not "PASS". Don't mis-claim a PASS.

4. **F8 root-cause discipline** — do NOT patch the symptom (e.g., "if exit 0 and model-not-loaded, exit 1"). Find the actual code path and fix it there. Per `10x-engineer:root-cause-tracing` skill. If root cause is in `waitForStudioModelLoaded`'s timeout-success-confusion, fix THAT — not the caller's exit-code interpretation.

5. **F3 counter taint across tasks** — the counter MUST reset at task-start, not just on success. A task that ends with a denial (and another task starts) should see counter=0 for the new task. Tested in 1.5c.

6. **F3 sandbox-denial signal predicate** — the canonical "sandbox denied this" signal needs verification. Two candidates: (a) `SandboxedExecResult.aborted=true` + a synthetic "denied" stderr the wrap-bash injects, OR (b) the policy layer's own denial event. Implementer must trace the actual path and pick one — DON'T guess. Audit-D verifies.

7. **Audit schema forward-compat** — `sandbox_denial_loop_broken` is added to `AuditEventTypeSchema` (write-side enum). The read-side parser is already `z.string()` post-v0.3, so v0.2/v0.3 daemons can replay v0.3.1 audit logs. Don't accidentally tighten the read-side schema.

8. **vLLM safety-by-default** — `examples/models.vllm.json` apiKey literal is `"vllm"` (placeholder). If a user copies the example to `~/.pi/agent/models.json` and starts vLLM with `--api-key not-vllm`, the bearer mismatches. INSTALL-VLLM.md must explicitly call this out: either match the literal in models.json OR change apiKey to an env-var name.

9. **F4 port-range default safety** — scanning ports outside the Studio range (8888-8908) is not a v0.3.1 concern, but operators MIGHT customize via `STUDIO_DOCTOR_PORT_RANGE`. Document the env-var in the script's JSDoc; refuse ranges > 100 ports as a sanity guard against accidental network-wide scans.

10. **README backend matrix integrity** — IMPL-4 updates the existing matrix row. Don't accidentally drop the existing Studio + Ollama rows. Diff carefully; AUDIT-B verifies.

11. **vLLM GGUF vs safetensors** — INSTALL-VLLM.md MUST be honest about the GGUF support being experimental. The recommended path is BF16 safetensors download (~54GB re-download for 27B, but no quant-loader bugs). GGUF as a fast path is OK but flag the upstream gaps.

12. **F2 prompt-template change risk** — bumping v3→v4 changes the model's behavior for every consumer (CLI users, Telegram users, future channels). The light audit + personal verify in Phase 5.2 must include manual smoke against at least the canonical 3-message regression case (per MIB-2026-05-05-1751 Smoke 2). Don't ship F2 if the smoke regresses.

13. **Cross-machine MIB cadence** — each W1 commit lands ahead of GB10's pull cycle. Don't push each commit individually; batch the W1 commits + Phase 6 reply MIB so GB10's pull surfaces the entire wave atomically. Reduces context-switch cost on their side.

---

## Out of scope (no v0.3.1 ticket — tracked in followups)

- **deep-agents replacement of pi-mono** — DROPPED per GB10 MIB-1126 §3 + dev-box concur. Re-evaluate only if pi-mono drops a load-bearing primitive (e.g., tool-call streaming) that deep-agents uniquely solves.
- **`/unsand` mobile-friendly variant** — design conversation, not code (F6 logs only).
- **Studio launch-studio.sh upstream WARN patch** — file as a Studio-side bug; out of scope for this repo.
- **vLLM as default backend** — explicit no per Sergio's framing in MIB-2305 §6. Studio stays default.
- **pi-mono package rename `@mariozechner/...` → `@earendil-works/...`** — DEFERRED per dev-box MIB-2026-05-08-2330 §2. Re-evaluate when production-box reinstalls.
- **vLLM cross-quant probe matrix** — vLLM probe lands as one row (BF16). Q4/Q8 vLLM verification is a v0.4 expansion if useful.
- **Studio-side fix for `mem_get_info` unified-memory accounting** — file as a Studio-side bug; out of scope here.
- **Heartbeat source rename `telegram-poll → telegram-poll-attempt`** — still v0.4 per existing v0.3 followup #5.

---

## Verification gates

```bash
# Pre-W1
git log --oneline -3                # head should be d57bbcd or later
npx tsc --noEmit                    # clean baseline
npx vitest run                      # 1005/1005 pass + 7 platform-skip

# Post-W1 (after all 6 implementer commits)
npx tsc --noEmit                    # clean
npx vitest run                      # 1005 + new tests:
                                    #   IMPL-1: ~5 ✅-strip tests
                                    #   IMPL-5: ~4 loop-breaker tests + 1 audit
                                    #   IMPL-6: ~1 boot-fix test
                                    #   total target: ~1015+
git status                          # clean

# Post-W2 audit + W3 personal verify
# (no test delta beyond what audit-find-fixes contribute)

# Pre-W5 (F2)
npx vitest run                      # all W1 tests still passing

# Post-W5 (F2)
npx tsc --noEmit                    # clean
npx vitest run                      # +SHA pin v4 + ~3 prompt-content tests
sha256sum prompts/coding-agent.v4.txt  # matches EXPECTED_SHA256_V4
sha256sum prompts/coding-agent.v3.txt  # matches EXPECTED_SHA256_V3 (regression guard)

# Pre-ship
grep -c "stripFalseSuccessPrefix\|sandbox_denial_loop_broken" src/  # ≥2
grep -c "studio-doctor" scripts/                                     # ≥1
grep -c "vllm-local" examples/models.vllm.json                       # 1 (provider key)
ls docs/INSTALL-VLLM.md scripts/install-vllm.sh                       # both exist
```

---

## Executor handoff

This plan will be executed via the standard 7-stage Wave/Audit/BLESS pipeline (per `~/.claude/rules/agent-orchestration.md`):
- **Stage 4 (waves)**: 6 parallel `general-purpose` subagents per W1 group, `10x-engineer:test-driven-development` + `verification-before-completion` required
- **Stage 5 (audit)**: 5 parallel `general-purpose` auditors with `10x-engineer:testing-anti-patterns` + `verification-before-completion` required
- **Stage 6 (personal verify)**: orchestrator runs all gates, reads audit-flagged diffs personally
- **Stage 7 (BLESS)**: 8-elder default scope on shipped W1 code; iterate on blockers; defer non-blockers to v0.3.1 followups doc
- **Phase 5 (F2)**: lighter-weight sub-cycle (1 auditor + personal verify; no full BLESS). Justified by tight scope (one prompt edit + SHA pin + 4-line code change).
- **Phase 6 (MIB)**: reply MIB to GB10 with all SHAs + vLLM probe handoff.

Each subagent prompt MUST cite this plan + step number + skill names + commit-message template.

---

*Last updated: 2026-05-09 by dev-box orchestrator (Mac), v1 — pre-elder. Awaiting Ring of Elders Round 1 (8 elders, default scope).*
