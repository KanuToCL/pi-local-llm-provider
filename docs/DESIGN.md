# DESIGN.md — pi-local-llm-provider

> Architecture, vision, and decision tree for using pi-mono with a local LLM backend (Unsloth Studio, Ollama, LM Studio, vLLM).

## Table of Contents

1. [Vision](#1-vision)
2. [Architecture](#2-architecture)
3. [The probe — decision gate](#3-the-probe--decision-gate)
4. [Phase plan](#4-phase-plan)
5. [Pre-conditions](#5-pre-conditions)
6. [Decision tree](#6-decision-tree)
7. [Risks + mitigations](#7-risks--mitigations)
8. [Out of scope](#8-out-of-scope)

---

## 1. Vision

Use **pi-mono** (terminal coding-agent harness — `read`, `write`, `edit`, `bash` tools driven by an LLM) backed by a **local LLM** running on consumer hardware. Today: Unsloth Studio (UD-quant lets Qwen3.6-27B fit 12 GB VRAM) is the priority backend; Ollama (qwen2.5:14b at standard Q4_K_M) is the proven fallback. LM Studio and vLLM are documented for future addition.

**Honest framing:** local Qwen3.6-27B at coding tasks is a **junior pair programmer**, not a Claude Sonnet substitute. Best for grunt work (rename this, scaffold a test, find that import) where speed and privacy matter more than peak quality. Keep Claude in your back pocket for hard refactors.

**Why bother:**
- **Craftsmanship** — own the whole stack
- **Privacy** — code never leaves the box
- **Single-daemon ergonomics** — one local LLM server can drive multiple surfaces (pi for code, custom Gradio UIs for domain work, scripts)
- **Subscription-optional** — not subscription-replacement, but the option to step out for a week without losing your IDE

**Why this might NOT work:** see §3. If the chosen backend doesn't emit OpenAI-shaped `tool_calls[]` for the model in question, pi-mono cannot parse the calls and the whole agent loop collapses silently. The probe settles this empirically before you commit.

---

## 2. Architecture

### 2.1 Process model

```
┌──────────────────────┐    HTTP /v1     ┌──────────────────────┐
│  pi-mono             │ ──────────────→ │  Local LLM server    │
│  (terminal coder)    │ ←────────────── │  (Studio :8888 OR    │
│                      │                 │   Ollama :11434 OR   │
│  builds tool defs,   │                 │   LM Studio :1234 OR │
│  parses tool_calls,  │                 │   vLLM :8000)        │
│  runs read/write/    │                 │                      │
│  edit/bash, loops    │                 │  loaded model        │
└──────────────────────┘                 │  (Qwen3.6-27B-GGUF,  │
                                         │   qwen2.5:14b, etc)  │
                                         └──────────────────────┘
```

### 2.2 The integration is one JSON file

pi-mono supports custom OpenAI-compat providers via `~/.pi/agent/models.json`. A single entry per backend, with a `compat` block declaring known quirks (e.g., `thinkingFormat: "qwen-chat-template"` for Qwen3 models that need `chat_template_kwargs.enable_thinking`).

That's it. No TypeScript extension, no upstream PR, no wrapper. If the probe passes, you're done in 30 seconds.

See [`examples/models.unsloth-studio.json`](../examples/models.unsloth-studio.json) and [`examples/models.ollama.json`](../examples/models.ollama.json) for ready-to-use templates.

### 2.3 Why no extension layer (Tier 1)

Three reasons:

- **Single source of truth.** Anything an extension would do (warm-up affordance, error wrapping, status hint) can live as documentation or a shell alias. Duplicating it in npm-package code creates a maintenance surface for ~30 LOC of marginal convenience.
- **Supply-chain surface.** A published npm package is a compromise vector. For single-user infrastructure, the math doesn't work.
- **pi-mono evolves rapidly.** A Tier 1 package would need to keep up with Mario's release cadence; a Tier 0 config doesn't.

### 2.4 Why no upstream PR (Tier 2)

Premature. The compat machinery already in pi-mono (`packages/ai/src/providers/openai-completions.ts`'s `qwen-chat-template` thinkingFormat) handles the request side. The response side is the local-server's responsibility. Until enough users hit the same documented quirks, a built-in `unsloth` provider would couple pi-mono's release cadence to Studio's — net negative for upstream.

If demand emerges, [`RFC.md`](../RFC.md) is a docs-only PR ready to lift.

---

## 3. The probe — decision gate

This is the only load-bearing decision. **pi-mono parses tool calls only from the structured `choice.delta.tool_calls[]` field.** There is zero code anywhere in pi-mono that scans `delta.content` for `<tool_call>...</tool_call>` text blocks. If your local server emits Qwen3's tool calls as text instead of structured field, pi treats them as chat prose and never invokes the tools.

The `qwen-chat-template` compat at `pi-mono/packages/ai/src/providers/openai-completions.ts:529-533` is **request-side only** — it ensures `chat_template_kwargs.enable_thinking` reaches the server. The response-side mapping is **the local server's responsibility**, and not all servers do it correctly out of the box.

### Pass / fail criteria

```
PASS  = choice.message.tool_calls[0].function.name === "get_weather"
        AND choice.message.content does NOT contain "<tool_call>"
        AND choice.message.tool_calls[0].function.arguments parses as JSON

FAIL  = any of the above false
```

The probe in [`scripts/probe-toolcalls.js`](../scripts/probe-toolcalls.js) implements this. Sends one tool-augmented `/v1/chat/completions` request with a forcing prompt (`"What is the weather in Oakland, CA?"` + `get_weather` tool definition) and asserts the verdict. Exit code 0 = PASS, 1 = FAIL, 2 = configuration/connectivity error.

---

## 4. Phase plan

### Phase 0 — Get the local server running

- Studio: `unsloth studio -H 127.0.0.1 -p 8888`, load Qwen3.6-27B-GGUF in the UI
- Ollama: `ollama serve` (auto), `ollama pull qwen2.5:14b-instruct-q4_K_M`
- LM Studio: launch app, start server tab, load model
- vLLM: `vllm serve <model-id> --enable-auto-tool-choice --tool-call-parser <parser>`

Verify the model is loaded:

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:<port>/v1/models
```

### Phase 1 — Probe

```bash
node scripts/probe-toolcalls.js
```

Capture the exit code + output. **5 minutes.**

### Phase 2 — Branch on result

| Probe result | Action |
|--------------|--------|
| **PASS** | Proceed to Phase 3 |
| **FAIL with `<tool_call>` text leak** | Server lacks structured tool-call mapping. Pivot to a different backend (try Ollama if you came from Studio) OR run llama-server directly with `--jinja --tool-call-parser qwen` |
| **FAIL with no tool call at all** | Reasoning chain may be intercepting. Re-run with the model's `/no_think` marker if applicable. If still fails, model isn't tool-capable through this server config — try a different model or different server |

### Phase 3 — Install the config (probe-pass path)

```bash
cp examples/models.<backend>.json ~/.pi/agent/models.json
chmod 600 ~/.pi/agent/models.json
pi --list-models    # verify the new entry appears
pi --provider <backend-id> --model "<model-id>" "list files in this dir"
```

Expect pi to invoke the `bash` or `ls` tool. If it just prints prose like "I would list the files...", the tool-call parsing isn't working in pi's actual code path even though the probe passed — file an issue here with the offending response.

### Phase 4 — Day-to-day use

Optional polish:
- Add a warm-up shell alias: `alias pi-warm='curl -s -H "Authorization: Bearer $UNSLOTH_API_KEY" http://localhost:8888/v1/chat/completions -d "{\"model\":\"...\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" > /dev/null'` to fire a 1-token request before your first real query, getting the cold-start out of the way
- Set `PI_TELEMETRY=0` in your shell rcfile if you want pi-mono's install telemetry off

### Phase 5 — Conditional escalation

Skip unless explicit demand emerges:
- **Tier 1** (npm package): only if multiple Studio/Ollama users want a `pi install npm:...` shortcut for the config
- **Tier 2** (upstream pi-mono PR): only if Mario solicits, OR multiple users hit the same backend-specific quirks Tier 0 cannot express via `compat` flags. The lift-and-ship draft lives in [`RFC.md`](../RFC.md).

---

## 5. Pre-conditions

Before any probe run:

- [ ] Local LLM server is running on a known port
- [ ] A tool-capable model is loaded (verify via `/v1/models`)
- [ ] API key (if required) is set in env: `UNSLOTH_API_KEY`, or use literal `"ollama"` for Ollama
- [ ] Node 20+ is available (`node --version`)
- [ ] `~/.pi/agent/` directory exists with mode 0o700 (pi-mono creates this on first run)
- [ ] Backup of any existing `~/.pi/agent/models.json` before merging

---

## 6. Decision tree

```
                       [server running + model loaded?]
                        /                            \
                      no                            yes
                       |                             |
                  set up Phase 0                  [run probe]
                                                   /        \
                                                PASS        FAIL
                                                  |          / \
                            [install models.json + chmod 600]
                                                            /   \
                                                  text leak     no tool call
                                                      |             |
                                                [pivot backend]  [retry with
                                                  OR run         /no_think OR
                                                  llama-server   different model]
                                                  --jinja]
```

---

## 7. Risks + mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | Server doesn't emit structured `tool_calls[]` for the chosen model | **CRITICAL** | Probe gate (§3) — pivot to Ollama qwen2.5:14b if FAIL |
| R2 | `~/.pi/agent/models.json` literal env-var leak: when `UNSLOTH_API_KEY` is unset, pi-mono's `resolveConfigValue` returns the literal string `"UNSLOTH_API_KEY"` and ships it as the bearer token | HIGH | Verify env var is set BEFORE launching pi; consider a shell wrapper that exits if unset |
| R3 | `models.json` not chmod 600 — world-readable by default | MEDIUM | `chmod 600 ~/.pi/agent/models.json` after every edit |
| R4 | pi `bash` tool runs unsandboxed — prompt-injection RCE if a poisoned input gets into the model's context | HIGH | Don't run pi with cwd inside a directory containing secrets; consider container or path-restricted shell |
| R5 | pi `/share` exports full session including bash outputs to GitHub gist | HIGH | Don't run `/share` after any session that touched secrets |
| R6 | 30-60s cold-start with no UI feedback on first call after server restart | LOW | Optional warm-up alias (see Phase 4) |
| R7 | Local Qwen3.6 context window 32k vs Claude 200k → pi's autocompaction fires sooner | LOW | Accept local-Qwen for ≤3-file tasks; use Claude for large refactors |
| R8 | Qwen3.6-27B tool-call fidelity ~85% per call → 5-call chain ≈ 44% success | MEDIUM | Set realistic expectations; design tasks as short tool-call sequences when possible |

---

## 8. Out of scope

This repo deliberately does NOT address:

- Replacing Claude Pro for daily work (different question — judge with empirical measurement, not architecture)
- Coupling pi-mono to any specific RAG project (e.g., the author's vibration-pdm acoustics consultant has its own orchestrator and Gradio UI; pi-local-llm-provider stays orthogonal)
- Building a Tier 1 npm package (deferred indefinitely — see §2.3)
- Tier 2 upstream pi-mono PR (premature — see §2.4 and `RFC.md`)
- Fixing pi-mono's two upstream data-layer bugs (literal env-var name leaked as bearer token; `/share` no-redact for tool outputs) — these would be separate PRs
- Sandbox / containerization for pi's `bash` tool (R4 mitigation is operator discipline, not code)

---

*The probe at §3 is the binding gate. Everything else is contingent on its result.*
