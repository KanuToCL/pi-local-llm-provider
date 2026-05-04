# Production findings — 2026-05-03

> **From:** Windows-side Claude (production box, Sergio's RTX 5070)
> **To:** Mac-side Claude (dev box, orchestrator)
> **Re:** First end-to-end Telegram smoke. Two real bugs fixed in-place; one critical UX bug needs your judgment + likely an SDK + prompt fix that belongs upstream of production.

---

## 1. What I did

Picked up after `PRODUCTION-HANDOFF.md`. Ran the pre-flight checklist on the Windows box; ran the test suite; got the daemon booting; got Telegram talking; identified the conversational-path bug below. Did **not** run the Phase -1 SDK spike yet — see §6.

---

## 2. Pre-flight results — green except for two tangents

| Check | Result |
|---|---|
| Node v24.13.0 / npm 11.12.1 / git 2.48.1 | ✅ |
| Repo clean, up to date with `origin/main` | ✅ |
| `pi --list-models` shows Qwen3.6-27B-GGUF | ✅ |
| Studio on `:8888` (after manual launch) | ✅ |
| `UNSLOTH_API_KEY` in env | ✅ |
| `probe-toolcalls.js` against live Studio | ✅ PASS — `tool_calls[]` correct |
| `npm install` | ✅ |
| `npx tsc --noEmit` | ✅ clean |
| `npx vitest run` | ⚠️ 31 failed / 846 passed / 4 skipped — **see §3 (none are logic bugs)** |
| Studio variant | ⚠️ Sergio is running `gemma-4-E2B-it-GGUF` and `Qwen3.6-35B-A3B-GGUF UD-IQ2_M`, NOT the `Qwen3.6-27B-GGUF UD-Q4_K_XL` the handoff specified |

---

## 3. Test failures — all 31 categorized, none are daemon-logic bugs

| # | Files | Failures | Root cause | Fix scope |
|---|---|---|---|---|
| A | `ipc-roundtrip.test.ts`, `daemon-cli-smoke.test.ts`, `daemon-lock-engaged.test.ts`, `audit-purge-and-corruption.test.ts` | 18 | Tests construct `.sock` paths in `%TEMP%` and call `server.listen()`. Windows Node.js can't `listen()` on arbitrary FS paths — needs named pipes (`\\.\pipe\…`). **Production daemon already does this correctly via `defaultSocketPath()` (`src/daemon.ts:1580`)** — only the test harness is wrong. | Test harness: when `process.platform === 'win32'`, generate a `\\.\pipe\pi-comms-test-<rand>` path instead of joining tmpdir. Possibly a shared helper. |
| B | `system-prompt.test.ts` | 1 | SHA256 of `prompts/coding-agent.v1.txt` mismatches pin. Cause is **CRLF on Windows checkout**: LF-normalized hash matches the pin exactly (`fca4407…`). Verified with a one-liner: `crypto.createHash('sha256').update(raw.replace(/\r\n/g,'\n')).digest('hex')`. | Add `prompts/*.txt text eol=lf` to `.gitattributes`, OR normalize line endings in the test before hashing. |
| C | `config.test.ts` | 1 | `PI_COMMS_HOME=/var/lib/pi-comms` cascades to `\var\lib\pi-comms\workspace` on Windows (path.join uses `\`). Test asserts `/var/lib/pi-comms/workspace`. | Either platform-gate the test or normalize path separators in the assertion. |
| D | `dead-man-script.test.ts` | 4 | Tests `dead-man.sh` (bash) — not executable on Windows. | Platform-gate with `process.platform !== 'win32'`. |
| E | `install-scripts.test.ts` | 4 | `install-systemd.sh` is Linux-only. `install-windows-task.ps1 -DryRun` test passed ✅. | Platform-gate the systemd-specific cases. |
| F | `audit-purge-and-corruption.test.ts` | 3 | Spawning `pi-comms purge` returns `null` exit code — bin not on PATH from spawn context. | Either build to dist + invoke that, or `npx tsx bin/pi-comms.ts purge` with explicit interpreter. |

**Bottom line on tests:** every failure is platform/test-infra hygiene. The daemon's production code paths are clean. Bug A is the most important to fix because it currently blocks the integration suite from telling us if real production daemon-IPC paths regress on Windows.

---

## 4. Two bugs I fixed in-place (pushed in this commit)

### 4.1 Studio health check missing `Authorization` header → 401 at boot

**Symptom:** Daemon banner prints `pi-comms online`, then `💔 studio health fail attempt=1 status=401`, then exits.

**Root cause:** `waitForStudioModelLoaded` (`src/daemon.ts:1350`) and `probeStudioModelLoaded` (`src/daemon.ts:1437`) both `fetch(statusUrl, { method: 'GET' })` with **no Authorization header**. Sergio's Studio install requires the bearer token on `/api/inference/status`. (`probe-toolcalls.js` was passing because it sets `Authorization: Bearer ${UNSLOTH_API_KEY}` explicitly.)

**Fix (committed):** added `apiKey` field to `StudioWaitOpts` + `StudioProbeOpts`; both fetches now send `headers: { Authorization: \`Bearer \${opts.apiKey}\` }`. Both call sites pass `config.unslothApiKey`.

**Question for you:** is this 401 reproducible on your Mac Studio? If your Mac install lets through unauthenticated GETs to `/api/inference/status`, that explains why this slipped past the audit/BLESS waves. Either way the auth header is correct behavior — even if some Studio builds allow unauthenticated probes, the next one might not.

### 4.2 `PI_COMMS_DEFAULT_MODEL=unsloth-studio/auto` — accept whatever Studio has loaded

**Symptom:** Sergio swapped the loaded model in Studio between sessions (qwen3.6-35B-A3B → gemma-4-E2B). Daemon booted, hit `studio health fail reason=model_not_loaded` (Studio was up, just had a different model than `.env` declared), exited.

**Sergio's perspective verbatim:**
> *"i thought i had to launch unsloth studio and daemon would pick up whatever model is selected there"*

That's the right product expectation. Hard-coding a model ID in `.env` and expecting Studio to track it is friction.

**Fix (committed):** `waitForStudioModelLoaded` now returns `Promise<string>` (the resolved model ID) and supports `modelId === "auto"`: accepts any non-empty `loaded[]` and returns `loaded[0]`. `probeStudioModelLoaded` mirrors the same logic. Call site at `src/daemon.ts:366` captures the resolved ID into `coldStartModelId`. `.env` updated to `PI_COMMS_DEFAULT_MODEL=unsloth-studio/auto`. The `unsloth-studio` provider lookup in `extractStudioBaseUrl` only needs `provider.baseUrl` — model ID is not validated against `models.json`'s `models[]`, so `auto` works without further models.json changes.

**On boot now:** `💚 studio health ok attempt=1 model=unsloth/gemma-4-E2B-it-GGUF auto_detected=true`.

**Should this be the default?** Open question for you. Pros: zero-friction model switching. Cons: drops the explicit-pin safety net (if Sergio loads a non-tool-capable model in Studio, the daemon boots happily and breaks at first task). I'd suggest: keep `auto` opt-in (must be written explicitly), with a startup `tell()` to terminal noting "auto-detected: <model>" so it's visible.

---

## 5. THE CRITICAL UX BUG — conversation flow is broken end-to-end

### 5.1 What Sergio observed

Live Telegram conversation (paraphrased verbatim):

```
Kanuto: /start
Kanuto: you there
Bot:    📱 Hey! 👋 How can I help you today?
Kanuto: who are you?
Kanuto: hey there bro
Bot:    📱 Hey! What can I help you code today? 😊
Kanuto: do you know what model you are there
Kanuto: hello?
Kanuto: halo
Kanuto: hey again, whats the capital of France
Bot:    📱 The capital of France is Paris.
```

**Every reply is `tell()`-prefixed.** `who are you?`, `hello?`, `halo` got no response. Tasks completed cleanly per audit (no `serial_queue_blocked`, no errors), but the model emitted `tell()` for every single turn.

### 5.2 Why this matters — Sergio's design intent

> *"a normal conversation could be established. But WHILE the model is actually coding, it COULD use tell() in order to send small messages... [it] looks like tell() is the default method of comms (as i understand it) currently; but the original design idea was to have a flow conversation using ANY model with telegram... in order to plan correctly a code up, we need conversation until we solidify the plan"*

This is right and matches the system prompt at `prompts/coding-agent.v1.txt:6` — `tell()` is documented as proactive-mid-task-only. The default conversational path should be `reply` events (no prefix per `formatChannelEvent` `src/channels/telegram.ts:790-791`).

### 5.3 What I think is happening (without the spike data)

Three non-mutually-exclusive theories — Sergio and I rank them in this order of likelihood:

1. **Model behavior on small backend.** Gemma-4-E2B is a 2B-equivalent model; the handoff specified Qwen3.6-27B UD-Q4_K_XL as the load-bearing minimum. A 2B model treats every available tool as something it must call rather than recognizing "no tool needed, just respond." The system prompt's `tell()` description ("for proactive mid-task interrupts") is too subtle for a 2B model to follow. **First action: re-test with Qwen3.6-27B UD-Q4_K_XL or 35B-A3B at a real quant. If chat flows naturally, the bug class is "system-prompt depends on frontier-model instruction-following" → fix is a small-model-aware prompt variant.**

2. **System prompt missing the explicit "default = no tool" rule.** Frontier models infer this; 2B models don't. Concrete proposed addition (drop into `prompts/coding-agent.v2.txt`):
   > *"For ordinary conversational turns (questions, greetings, planning discussion, clarifications) respond directly with text — do NOT call any tool. Only call tell() when you are already executing a long-running task and need to surface a status update without ending the task. If the user asks 'who are you' or 'hello', a plain text reply is the answer."*
3. **pi-mono `customTools` wiring may be forcing tool calls on every turn.** This is exactly what Probe 5 was meant to settle (does `customTools[bash]` override the default; does the plain-text-no-tool path remain available). I have not run the spike yet (Sergio's call — I stopped at STOP 2 per the handoff). If Probe 5 reveals the SDK forces a tool call on every turn, then `tell()`-for-everything is mechanically inevitable on small models and the architecture needs a re-plan.

### 5.4 What I recommend you (dev-box) do

In order:

1. **Reproduce on your Mac with the same model**: load `gemma-4-E2B-it-GGUF` in your Studio, send the same conversation. Confirm/deny that it's a Windows-specific or model-specific bug.
2. **Cut a v2 prompt** with the explicit "default = direct text reply" rule above, plus a few-shot example showing a casual chat exchange resolving without a tool call. Bump `coding-agent.v1.txt` → `coding-agent.v2.txt` per its own header instruction. Update SHA256 pin.
3. **Push Sergio to run the spike** (or run it yourself if you can). Probe 5 result is the gating data point. If `customTools` is the issue, the prompt fix won't save it.
4. **Test against Qwen3.6-27B UD-Q4_K_XL** specifically — the handoff said this is the floor, and Sergio's running below it. Either get him to that quant, or update the README + prompt to acknowledge the actual floor based on what works.
5. **Track this as a blocker** to v1 release. The conversational chat path is the v1 UX — currently it doesn't exist.

---

## 6. STOP-2 still in effect

Per `PRODUCTION-HANDOFF.md` §6 stopping criteria, I have **not** run `npm run spike`. Reasoning:

- Sergio's first goal was getting Telegram talking end-to-end (he understood the spike was Phase -1, but wanted to see something work first as a sanity check).
- The conversational-path bug (§5) is now blocking him from real-world dogfooding.
- Running the spike is your call from here — if you want me to run it on Windows + commit results to `docs/spike-results/`, just say so in the next round.

If you want to fly the spike: `npm run spike` followed by copying `~/.pi-comms/sdk-spike.json` into `docs/spike-results/sdk-spike-2026-05-03.json` and committing.

---

## 7. Two product-vision items Sergio added — already in the plan

While we worked through the above, Sergio raised two product asks. Both added to the v5 backlog in `docs/plans/pi_comms_daemon.plan.md` (and DESIGN.md vision):

- **V5-G — `/consult <provider>` cloud escalation.** User-only trigger. When pi is stuck, user (not pi autonomously) sends `/consult claude` from Telegram. Daemon packages session state, calls cloud API, streams response back. Hard rule per Sergio: *"user MUST be in the loop"* — no agent-triggered cloud calls, no `consult_cloud()` tool. `CLOUD_CONSULT_ENABLED=true` opt-in flag, pluggable provider, preview-then-confirm gate before any data leaves the box.
- **V5-H — `/setup-comms` guided first-run setup.** Interactive wizard via Telegram (or pre-Telegram, a local web wizard) so users dump keys + IDs and the daemon writes `.env` itself. Closes the barrier-to-entry gap; makes key rotation safe.

Both are vision items, not implementation requests. Read the V5-G/V5-H rows in the plan for the full spec.

---

## 8. State of the repo at this commit

```
modified:   docs/DESIGN.md                       (V5-G/H vision additions)
modified:   docs/plans/pi_comms_daemon.plan.md   (V5-G + V5-H rows)
modified:   src/daemon.ts                        (auth fix + auto-model)
new:        docs/PRODUCTION-FINDINGS-2026-05-03.md  (this file)
new:        .env                                 (gitignored — not committed)
```

Daemon is currently runnable on Sergio's box (`npm run daemon` boots clean, Telegram connects, single-turn replies work). The conversational-flow bug (§5) is the only blocker to real use.

---

**TL;DR for you, dev-box:** auth + auto-model fixes are committed and stable. The conversational reply path needs your attention — likely a v2 prompt + a re-test on the heavier model, possibly an SDK-layer adjustment depending on Probe 5. I'll wait for your guidance before running the spike or making further changes.

— Production-box Claude
