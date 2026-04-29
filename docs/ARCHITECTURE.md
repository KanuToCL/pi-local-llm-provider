# Architecture — Local LLM stack for pi-mono and OpenClaw

> **Status:** suggested architecture, grounded in components already installed on this machine. This doc names the four layers, their responsibilities, the contracts between them, and where this repo (`pi-local-llm-provider`) actually contributes.

---

## TL;DR

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 4 — Channel / Orchestration                                    │
│   OpenClaw gateway (ws://127.0.0.1:18789)                            │
│   • Multi-channel ingress (WhatsApp / Telegram / Discord / TUI)      │
│   • Embeds pi-mono via createAgentSession() — NOT a subprocess       │
│   • Auth-profile rotation, sandbox isolation, per-agent state        │
└──────────────────────────────────────────────────────────────────────┘
                                 │  imports SDK
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3 — Agent runtime                                              │
│   pi-mono / @mariozechner/pi-coding-agent (v0.70.x)                  │
│   • Agent loop: stream → tool calls → tool results → stream          │
│   • Reads ~/.pi/agent/models.json for provider definitions           │
│   • Sends OpenAI-shaped /v1/chat/completions (tools, streaming)      │
└──────────────────────────────────────────────────────────────────────┘
                                 │  HTTP /v1 (OpenAI-compat)
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 2 — Provider config / probe (THIS REPO)                        │
│   pi-local-llm-provider                                              │
│   • examples/models.<backend>.json — declarative provider entry      │
│   • scripts/probe-toolcalls.js — gates: are tool_calls[] structured? │
│   • scripts/studio-variant.js + extensions/studio-variant.ts         │
│     — surface the GGUF quantization invisible to pi                  │
└──────────────────────────────────────────────────────────────────────┘
                                 │  references baseUrl
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Local inference backend                                    │
│   Unsloth Studio (http://localhost:8888)                             │
│   • Loads one GGUF variant at a time (Q3_K_M, UD-Q4_K_XL, …)         │
│   • Exposes /v1/chat/completions + /api/inference/status             │
│   • Variant choice is invisible to /v1 — read /api/inference/status  │
└──────────────────────────────────────────────────────────────────────┘
```

The four layers are independent processes/packages. Each upper layer **imports or routes to** the layer beneath it; failures localize cleanly.

---

## 1. What each layer owns (and what it does NOT)

### Layer 1 — Inference backend (Unsloth Studio)

**Owns:**
- GGUF model weights, tokenizer, KV cache
- One *active* variant at any moment (`gguf_variant` in `/api/inference/status`)
- Chat-template rendering (Qwen3 tool-call grammar, `<think>` tags)
- llama.cpp / GGUF runtime + CUDA scheduling

**Does NOT own:**
- Tool routing / multi-turn agent loops
- Conversation persistence
- Variant selection from the `/v1` API surface — variant is chosen in Studio's UI, full stop

**Failure modes:**
- Wrong variant loaded → tool-call args silently dropped (Q2/Q3)
- Chat template rejects malformed prior assistant turn → `400` with no body
- VRAM OOM during generation → connection closed mid-stream

### Layer 2 — Provider config (this repo)

**Owns:**
- The `models.json` schema bridge between pi-mono and any local backend
- Pre-flight verification (`probe-toolcalls.js`) that the backend emits structured `tool_calls[]`, not text-leaked `<tool_call>` blobs
- Visibility tooling for layer-1 state pi can't see (variant inspection)
- Documentation of empirically discovered quirks per backend

**Does NOT own:**
- The agent loop, the LLM, the channels
- Model selection at runtime (`--model` is pi's job)

**Why this layer exists at all:** pi-mono advertises "BYO model"; in practice each local backend has different chat-template behavior, different auth shapes, different quirks (Studio drops `chat_template_kwargs`; Ollama needed v0.3+ for OpenAI tool-calls). Without this layer, every consumer (pi, OpenClaw, anything else) re-discovers the same gotchas. With it, the contract is: *probe passes ⇒ drop the JSON in ⇒ ship.*

### Layer 3 — Agent runtime (pi-mono)

**Owns:**
- Agent loop: prompt → stream → tool execution → re-prompt
- Built-in tools (`read`, `write`, `edit`, `bash`, `glob`, `grep`)
- Provider plumbing: streaming, tool-call accumulation, cost calc, thinking-format dialects
- Session storage at `~/.pi/agent/sessions/`
- Extension API: `pi.registerCommand`, `pi.registerTool`, `pi.registerProvider`

**Does NOT own:**
- The model itself (delegated to Layer 1)
- Per-channel system prompts / multi-channel routing (that's Layer 4)
- Auth-profile rotation across multiple keys (Layer 4)

**Failure modes specific to Layer 3:**
- Model emits invalid tool-call args → pi rejects locally with validation error → bad assistant turn enters history → next request 400s on Layer 1 chat-template re-rendering
- Long-running tool call generation → no UI feedback (pi shows `⠋ Working...`); often cured by switching from `edit` (multi-arg JSON) to `write` (single content string)

### Layer 4 — Orchestration (OpenClaw)

**Owns:**
- WebSocket Gateway (`:18789` prod, `:19001` dev) — single ingress for all channels
- Channel adapters: WhatsApp, Telegram, Discord, Slack, BlueBubbles, browser, TUI
- **Embedded** pi sessions via `createAgentSession()` (imports the SDK, doesn't shell out)
- Agent isolation: per-agent workspace dirs at `~/.openclaw/agents/<agentId>/`
- Multi-profile auth with cooldown + failover (`auth-profiles.ts`)
- Sandbox: container-isolated tool execution
- Session tree, branching, compaction safeguard, cache-TTL context pruning
- Custom tool injection (channel-specific actions, browser/canvas/cron tools)

**Does NOT own:**
- The agent loop primitives (delegated to pi via SDK)
- The model definitions (still reads from a `models.json`-shaped config; OpenClaw generates one via `models-config.ts`)

**Why embed instead of subprocess?** Direct callbacks (`onBlockReply`, `onPartialReply`, `onToolResult`) let OpenClaw stream tokens out to a Telegram chat in real time, manage abort signals coherently, and inject channel-specific tools — none of which compose cleanly through stdin/stdout of `pi --print`.

---

## 2. Data flow (one user turn, end-to-end)

```
┌─User message arrives on channel (e.g. WhatsApp DM)
│
▼
[OpenClaw gateway]                                  Layer 4
│ • Map channel ID → agent ID → session file
│ • Resolve auth profile (rotate if cooled-down)
│ • Resolve model: provider="unsloth-studio", model="unsloth/Qwen3.6-27B-GGUF"
│ • Build system prompt (channel-aware, sandbox-aware, skill-aware)
│ • runEmbeddedPiAgent({ prompt, provider, model, onBlockReply, ... })
│
▼
[pi createAgentSession]                             Layer 3
│ • Load ~/.openclaw/agents/<id>/models.json (or fall back to ~/.pi/...)
│ • Find provider "unsloth-studio" → baseUrl http://localhost:8888/v1
│ • Resolve apiKey from env var name → bearer token
│ • Stream POST /v1/chat/completions with tools[]
│
▼
[Unsloth Studio /v1]                                Layer 1
│ • Lookup loaded model: unsloth/Qwen3.6-27B-GGUF
│ • Apply Qwen3 chat template (with chat_template_kwargs.enable_thinking)
│ • llama.cpp generates against currently-loaded variant (e.g. UD-Q4_K_XL)
│ • Emit OpenAI-shaped streaming chunks: choice.delta.content / .tool_calls[]
│
▼
[pi tool execution]                                 Layer 3
│ • Accumulate tool_calls[].function.arguments JSON
│ • Validate against tool schema (e.g. edit requires {path, edits[]})
│ • Execute tool (often an OpenClaw-injected custom tool, not built-in)
│ • Push tool_result back into context, repeat from "Stream POST" until done
│
▼
[OpenClaw onBlockReply]                             Layer 4
│ • Strip <think>/<thinking>, extract <final> if enforced
│ • Parse [[media:url]], [[voice]], [[reply:id]] directives
│ • Block-chunk text for channel size limits
│ • Send via channel adapter back to user
```

Three places this flow can break, layered:

| Layer | Symptom | Diagnose with |
|-------|---------|---------------|
| 1 | Wrong variant loaded → bad tool-call args, then 400 cascade | `node scripts/studio-variant.js` or `/studio-variant` |
| 2 | Models.json schema rejected | `pi --list-models` shows warnings; this repo's docs/Schema notes |
| 3 | Tool args invalid → poisoned history → 400 | Cancel session, re-prompt with `--tools` allowlist excluding fragile tools |
| 4 | Auth profile cooled down, no fallback | `openclaw doctor`; check `~/.openclaw/openclaw.json` profiles |

---

## 3. Disk layout (where state actually lives)

| Path | Owner | Contents |
|------|-------|----------|
| `C:\Users\KanuTo\.unsloth\studio\` | Layer 1 | Studio runtime, default model configs |
| `C:\Users\KanuTo\.cache\huggingface\hub\models--unsloth--*` | Layer 1 | GGUF weights (multiple variants per repo) |
| `C:\Users\KanuTo\AppData\Roaming\npm\node_modules\@mariozechner\pi-coding-agent\` | Layer 3 | pi-mono CLI + SDK + docs |
| `~/.pi/agent/models.json` | Layer 2 → Layer 3 | Provider config consumed by pi |
| `~/.pi/agent/extensions/*.ts` | Layer 3 | User-installed pi extensions (e.g. `studio-variant.ts`) |
| `~/.pi/agent/sessions/` | Layer 3 | pi CLI session JSONL files |
| `C:\Users\KanuTo\AppData\Roaming\npm\node_modules\openclaw\` | Layer 4 | OpenClaw CLI + plugin SDK |
| `~/.openclaw/openclaw.json` | Layer 4 | Gateway/channel/agent config |
| `~/.openclaw/agents/<agentId>/sessions/` | Layer 4 | OpenClaw embedded-agent session JSONL |
| **This repo** (`D:\...\pi-local-llm-provider`) | Layer 2 | Examples + probe + helper scripts + docs |

---

## 4. Recommended architecture for this machine

You currently have all four layers installed:
- Studio running at `:8888` with two cached variants (Q3_K_M, UD-Q4_K_XL) — **load UD-Q4_K_XL** for agent work.
- pi-mono `0.70.6` working end-to-end (verified).
- This repo's `models.json` installed at `~/.pi/agent/models.json`.
- OpenClaw `2026.4.26` installed but no agent onboarded yet (`~/.openclaw/agents/` doesn't exist).

### Recommended path

**Phase A — pi CLI alone (where you are now):**
```
[user] → pi --provider unsloth-studio → [Studio :8888] → response
```
Use this for local coding work. Already done.

**Phase B — OpenClaw embedded, single channel (suggested next):**
```
[Telegram DM] → OpenClaw gateway → pi-embedded session → [Studio :8888] → response
```

To get there:

```bash
# 1. Onboard an OpenClaw agent (creates ~/.openclaw/agents/<id>/)
openclaw onboard

# 2. Tell that agent's model registry about Studio.
# Easiest path: copy/symlink the same models.json this repo ships:
cp ~/.pi/agent/models.json ~/.openclaw/agents/<agentId>/models.json

# 3. Configure a channel (start with Telegram or the local TUI)
openclaw configure
# or: openclaw chat   # local TUI, no channel needed

# 4. Set the agent's default model
openclaw config set defaults.provider unsloth-studio
openclaw config set defaults.model "unsloth/Qwen3.6-27B-GGUF"

# 5. Smoke test
openclaw chat   # opens a TUI talking to the embedded pi session
```

OpenClaw's `models-config.ts` will read your provider entry; the embedded `createAgentSession()` will load the same `~/.pi/agent/extensions/studio-variant.ts`-style extensions if you point `additionalExtensionPaths` at them.

**Phase C — multi-channel (later):**
Add WhatsApp/Discord channels via `openclaw channels login`. Same Studio backend, same pi loop, same provider entry — channel adapters are pure ingress.

---

## 5. Invariants worth preserving

These are the contracts that let the layers stay decoupled. Break them and the failure modes get tangled:

1. **Layer 1 exposes only what the OpenAI `/v1` shape allows.** Variant selection, GPU stats, batch tuning — anything backend-specific stays at Layer 1. Layer 2 surfaces it through *separate* tooling (probes, helpers, slash commands), never by overloading the OpenAI request.

2. **Layer 2 is declarative + verifiable.** A new backend = one example JSON + one probe pass. No code changes in Layer 3 or Layer 4. If you find yourself patching pi-mono internals to support a backend, Layer 2 has failed.

3. **Layer 3 doesn't know about channels.** pi sees a prompt and a tool list. It does not know whether the response is going to stdout or WhatsApp. Layer 4 adapts.

4. **Layer 4 owns identity.** Auth profiles, multi-user routing, sandbox enforcement, rate-limit failover — all Layer 4. Layer 3 just gets handed a `model` and an `apiKey`.

5. **`~/.pi/agent/models.json` is the single source of truth for provider definitions.** Both pi CLI and OpenClaw read it (or a copy of it). Don't fork the schema; if a field is missing, upstream it.

---

## 6. Failure-mode reference (cross-layer)

| Symptom | Likely layer | Quick check |
|---------|--------------|-------------|
| `Unknown provider "X"` in pi output | 2 | `cat ~/.pi/agent/models.json` — `type` should be `api`, `apiKey` is env-var-name |
| `Invalid or expired API key` from Studio | 1 | `echo $UNSLOTH_API_KEY` is set + correct |
| Model leaks `<tool_call>` text into content | 1 + chat template | Re-run `node scripts/probe-toolcalls.js` |
| Tool call arrives missing required args | 1 (variant) | `node scripts/studio-variant.js` — Q2/Q3 loaded? swap to Q4+ |
| `400` after a previous tool error | 3 → 1 | History poisoned by malformed turn; `--no-session` + restart |
| OpenClaw can't find the model | 4 | Agent's `models.json` not pointed at this repo's config |
| Auth profile keeps cooling down | 4 | `openclaw config get profiles` — add a fallback profile |

---

## 7. Open questions / future work

1. **Should this repo ship an OpenClaw plugin?** Today it's a config repo. An OpenClaw plugin that registers `unsloth-studio` as a first-class provider with auto-variant-detection would be a Tier-1 contribution. Probably not worth it until variant switching is needed across multiple agents.
2. **Multi-instance Studio.** If you want true variant routing per pi-model entry, run two Studios on `:8888` and `:8889` with different variants pre-loaded; declare two providers in `models.json`. Not needed yet; document the pattern in README.
3. **Probe coverage.** Current probe verifies single-arg tool calls. Multi-arg schema fidelity (the `edit({path, edits:[...]})` failure mode) needs a separate probe — not yet written.
4. **OpenClaw + Studio sandbox interaction.** OpenClaw's sandbox runs tools in containers. Studio runs on the host. If sandbox mode is enabled, the embedded pi session still talks to host `localhost:8888` — confirm container egress rules allow that.

---

## See also

- [`README.md`](../README.md) — install + switching/checking models + GGUF variants
- [`RFC.md`](../RFC.md) — upstream pi-mono PR draft
- [`docs/DESIGN.md`](DESIGN.md) — Tier-0 architecture and decision tree
- OpenClaw's bundled doc: `<openclaw>/docs/pi.md` (locally at `C:\Users\KanuTo\AppData\Roaming\npm\node_modules\openclaw\docs\pi.md`)
- pi-mono custom-provider docs: `<pi-coding-agent>/docs/{models,custom-provider,extensions}.md`
