# pi-local-llm-provider

> Use [pi-mono](https://github.com/badlogic/pi-mono) (Mario Zechner's terminal coding agent) backed by a **local LLM** instead of paying for cloud subscriptions. Today supports [Unsloth Studio](https://unsloth.ai/), [Ollama](https://ollama.com/), [LM Studio](https://lmstudio.ai/), and [vLLM](https://vllm.ai/) — anything that speaks the OpenAI `/v1/chat/completions` shape.

Status: **probe-gated**. The integration ships as a single `~/.pi/agent/models.json` config entry per backend (Tier 0). The 30-LOC probe in [`scripts/probe-toolcalls.js`](./scripts/probe-toolcalls.js) decides whether a given backend is viable for pi-mono's tool-calling agent before you commit. See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full architecture + decision tree, and [`RFC.md`](./RFC.md) for the upstream pi-mono PR draft.

## Why this exists

pi-mono advertises "BYO model." That works trivially for cloud APIs, but local LLM servers have undocumented quirks (Studio silently drops `chat_template_kwargs`; Ollama needed v0.3+ for OpenAI-shaped tool calls; LM Studio's chat-template handling for Qwen3 is version-dependent). This repo collects the empirical findings — what config works, what breaks, what to test before committing.

## Three-step install

### 1. Pre-requisites

- pi-mono installed (`npm install -g @mariozechner/pi-coding-agent`)
- A local LLM server running (Studio / Ollama / LM Studio / vLLM)
- A tool-capable model loaded (Qwen3.6-27B for Studio, qwen2.5:14b for Ollama, etc.)
- Node 20+ for the probe

### 2. Probe the backend

```bash
git clone https://github.com/KanuToCL/pi-local-llm-provider.git
cd pi-local-llm-provider

# Probe Unsloth Studio (default)
UNSLOTH_API_KEY=sk-unsloth-... node scripts/probe-toolcalls.js

# Or probe Ollama
PROBE_ENDPOINT=http://localhost:11434/v1 \
  PROBE_MODEL=qwen2.5:14b \
  PROBE_API_KEY=ollama \
  node scripts/probe-toolcalls.js
```

Exit code `0` = the backend emits structured `tool_calls[]` and pi can use it. Exit code `1` = the model leaks tool calls as text or doesn't call them at all — see the probe output for which failure mode and what to do.

### 3. Install the config (probe-pass path)

Copy the matching example into `~/.pi/agent/models.json`, then `chmod 600` it:

```bash
cp examples/models.unsloth-studio.json ~/.pi/agent/models.json
chmod 600 ~/.pi/agent/models.json
pi --provider unsloth-studio --model "unsloth/Qwen3.6-27B-GGUF" "list files in this dir"
```

If `~/.pi/agent/models.json` already exists, merge by hand — pi-mono accepts multiple providers in one file.

## Switching and checking models

pi-mono reloads `~/.pi/agent/models.json` every time you open the picker, so no restart is needed after editing.

```bash
# List every model pi knows about (built-in + your custom providers)
pi --list-models

# Fuzzy search the list
pi --list-models qwen

# One-shot run against a specific provider/model
pi --provider unsloth-studio --model "unsloth/Qwen3.6-27B-GGUF" -p "say hi"

# Provider-prefixed shorthand (no --provider needed)
pi --model "unsloth-studio/unsloth/Qwen3.6-27B-GGUF" -p "say hi"
```

Inside an interactive `pi` session:
- `/model` — open the model picker (TUI)
- `Ctrl+P` — cycle through models from `--models <patterns>` (e.g. `pi --models "unsloth-studio/*,anthropic/claude-sonnet-4*"`)
- `/login <provider>` — OAuth/API-key login for cloud providers

To add another local model (e.g. a second GGUF you've loaded into Studio), just append another entry to the `models[]` array in `~/.pi/agent/models.json` and reopen `/model`.

## GGUF variants (Unsloth Studio)

A single Studio model id like `unsloth/Qwen3.6-27B-GGUF` is actually a *family* of GGUF quantizations (`Q3_K_M`, `Q4_K_M`, `UD-Q4_K_XL`, `Q5_K_M`, `Q8_0`, …). Studio exposes only the **base id** through its OpenAI-compat `/v1` layer — pi-mono can't see or pick a variant. Whichever variant Studio has loaded *is* what pi will hit.

**Why it matters for agent work:** quantization directly affects tool-call schema fidelity. Q2/Q3 frequently omit required arguments on multi-arg tools (e.g. pi's `edit({path, edits: [...]})` shows up as `edit({path})` and pi rejects the call locally with a validation error, which then poisons the next turn). Use **Q4_K_M or UD-Q4_K_XL minimum** for coding-agent loops.

### Check which variant is loaded

```bash
node scripts/studio-variant.js
# active_model:  unsloth/Qwen3.6-27B-GGUF
# gguf_variant:  UD-Q4_K_XL    ← this is what actually answers your requests
# loaded:        ["unsloth/Qwen3.6-27B-GGUF"]
```

The script reads Studio's `GET /api/inference/status` and warns if a Q2/Q3 variant is loaded.

### Switch variants

The OpenAI `/v1` endpoint **silently ignores** any variant suffix in the model id (`unsloth/Qwen3.6-27B-GGUF:Q4_K_M`, `:UD-Q4_K_XL`, etc. all route to whatever's loaded). To change variants:

1. Open Studio's web UI at `http://localhost:8888`
2. Use the model picker to load the variant you want (e.g. `UD-Q4_K_XL`)
3. Re-run `node scripts/studio-variant.js` to confirm
4. pi keeps using the same `--model "unsloth/Qwen3.6-27B-GGUF"` — no config change needed

If you swap variants constantly, run two Studio instances on different ports and add two providers in `models.json` (`unsloth-studio-q4` on `:8888`, `unsloth-studio-q8` on `:8889`).

## Schema notes (pi-mono ≥ 0.70)

The `models.json` schema pi-mono actually reads (per `<pi-coding-agent>/docs/models.md`):

| Field | Notes |
|-------|-------|
| `api` | **Not** `type`. Values: `openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`. |
| `apiKey` | Env var **name** (`"UNSLOTH_API_KEY"`), shell command (`"!op read ..."`), or literal value. No `$` prefix. |
| `authHeader: true` | Required for `Bearer <key>` auth on OpenAI-compat endpoints. |
| `input` | `["text"]` or `["text","image"]`. Required. |
| `cost` | Required (use all zeros for local) or pi reports fake dollars per turn. |
| `tools` | Not a field — tool-calling capability is decided by the backend at runtime. The probe is what verifies it. |

## Supported backends

| Backend | Tested model | Status | Example config |
|---------|--------------|--------|----------------|
| Unsloth Studio | `unsloth/Qwen3.6-27B-GGUF` | probe-gated | [`examples/models.unsloth-studio.json`](./examples/models.unsloth-studio.json) |
| Ollama | `qwen2.5:14b-instruct-q4_K_M` | mature | [`examples/models.ollama.json`](./examples/models.ollama.json) |
| LM Studio | TBD | future | TBD |
| vLLM | TBD | future | TBD |

## Why the probe

pi-mono parses tool calls **only** from the OpenAI-structured `choice.delta.tool_calls[]` field. If your local server emits Qwen3's `<tool_call>...</tool_call>` text inside `delta.content` instead, pi treats it as chat prose and never invokes the tool — the entire coding-agent value collapses silently.

The probe sends one tool-augmented request and asserts `tool_calls[]` is populated **and** `content` does not contain a `<tool_call>` literal. 30 lines of Node, no dependencies. Run it before adopting any new backend.

## Status, scope, what this is NOT

- **Tier 0 only** today: a `models.json` config + the probe + the docs. No npm package, no upstream pi-mono PR.
- **Single-user-of-public-record** (the author). Use at your own risk; please open issues if you hit a backend quirk this repo doesn't document.
- **Not a Claude replacement.** Local Qwen3.6-27B is a junior pair programmer for grunt work, not a Claude Sonnet substitute. See [`docs/DESIGN.md`](./docs/DESIGN.md) §1 for honest framing.
- **Not coupled to any specific RAG project.** This is pure infrastructure — pi sends OpenAI-compat HTTP requests, your local server answers.

## License

MIT — see [`LICENSE`](./LICENSE).

## Author

Sergio Pena ([sergiopena.audio](https://sergiopena.audio) · [@KanuToCL](https://github.com/KanuToCL))
