# pi-local-llm-provider

> Configs + probe + helpers for running [pi-mono](https://github.com/badlogic/pi-mono) (Mario Zechner's terminal coding agent) on a **local LLM** — AND a long-running daemon (`pi-comms`) that makes the same agent reachable from Telegram + WhatsApp DMs. Two separable tracks; pick what you need.

**Status:** alpha (`v0.2.0-alpha.1`). Single-user-of-public-record (the author). Telegram channel tested end-to-end; WhatsApp channel ships in v0.2 but has not yet been validated on Windows. Probe-and-config track (Tier 0) is stable and verified on RTX 5070 (12 GB) with `unsloth/Qwen3.6-27B-GGUF` (UD-Q4_K_XL) → Unsloth Studio → pi-mono 0.70.6.

---

## What's in this repo (v0.2)

This repo bundles **two separable tracks**. You can use either one without the other.

### Track 1 — probe-and-config (the original Tier 0)

Three artifacts:
- A 30-LOC zero-dependency probe ([`scripts/probe-toolcalls.js`](./scripts/probe-toolcalls.js)) that decides whether a given local backend can drive pi-mono's tool-calling agent loop. Exit 0 = ship it. Exit 1 = read the failure mode and pick a different backend or quantization.
- A `models.json` example per backend ([`examples/`](./examples/)) for Unsloth Studio, Ollama, LM Studio, and vLLM.
- A safer launcher ([`scripts/pi-launch.sh`](./scripts/pi-launch.sh) and [`.ps1`](./scripts/pi-launch.ps1)) that runs [`scripts/check-env.js`](./scripts/check-env.js) before pi-mono starts, so an unset `apiKey` env var fails closed instead of leaking the literal env-var name into your daemon's access log (R2 in [`SECURITY.md`](./SECURITY.md)).

That's the entire Track-1 surface. No npm package, no daemon, no channel adapters.

### Track 2 — pi-comms daemon (new in v0.2)

A long-lived TypeScript daemon that:
- Embeds pi-mono via `createAgentSession()` (NOT a subprocess — first-class tool registration matters).
- Listens on a local Unix socket (or named pipe on Windows) for terminal CLI requests.
- Bridges incoming Telegram + WhatsApp DMs into the same shared pi session.
- Adds `tell()` / `confirm()` / `go_background()` tools so pi can proactively message you, ask for destructive-command approval, and self-promote long-running work to background.
- Sandboxes the `bash` tool by default (`bwrap` on Linux, `sandbox-exec` on macOS, refuses to start on Windows unless `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true` is explicitly set).
- Writes a status pointer + audit log so you can grep what pi was doing 3 hours ago from any device.
- Per-OS autostart: LaunchAgent (macOS), systemd-user (Linux), Scheduled Task (Windows).

The daemon's plan, threat model, and design are in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (four-layer model), [`docs/INSTALL.md`](./docs/INSTALL.md) (per-OS autostart), [`docs/INSTALL-WHATSAPP.md`](./docs/INSTALL-WHATSAPP.md) (Baileys pairing + identity model), and [`SECURITY.md`](./SECURITY.md) (R15-R30 daemon-specific risks).

---

## Status

| Surface | Status | Notes |
|---|---|---|
| Probe + config (Track 1) | **stable** | Verified on RTX 5070 (12 GB) + Unsloth Studio + pi-mono 0.70.6 |
| pi-comms daemon — terminal CLI | **alpha** | Works locally; not yet exercised by anyone but the author |
| pi-comms — Telegram channel | **alpha (tested)** | One real bot live with the author's Telegram ID; round-trip confirmed |
| pi-comms — WhatsApp channel | **alpha (untested on Windows)** | Phase 5 shipped (Baileys 7.0.0-rc.9); macOS pair flow exercised; Windows pair flow not yet verified |
| pi-comms — sandbox-by-default | **alpha** | Linux/macOS via bwrap/sandbox-exec; Windows refuses to start unless explicit override |
| Multi-user / group chats | **NOT supported** | DM-only allowlist; group messages silently dropped (audit-logged) |
| Voice messages | **NOT supported** in v1 | Placeholder text routed; whisper.cpp path is v2 |
| Production deployment | **NOT a goal** | Single-user single-machine; do not put this on a server you share |

Read the "What this is NOT" section below before adopting anything in this repo.

---

## Architecture (one paragraph)

Four layers: a local inference backend (Layer 1 — Studio / Ollama / LM Studio / vLLM) speaks OpenAI `/v1/chat/completions` to pi-mono (Layer 3 — the agent runtime), bridged by a `models.json` provider config (Layer 2 — what this repo's Track 1 ships). The pi-comms daemon (Layer 4 — what Track 2 adds) embeds pi-mono via SDK and adds channel adapters (Telegram, WhatsApp), an IPC server for terminal access, sandbox enforcement, and a status pointer. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full diagram, data flow, failure-mode reference, and disk-layout map.

---

## Three-step install

### 1. Pre-requisites (both tracks)

- pi-mono installed (`npm install -g @mariozechner/pi-coding-agent`)
- A local LLM server running (Studio / Ollama / LM Studio / vLLM)
- A tool-capable model loaded (Qwen3.6-27B for Studio, qwen2.5:14b for Ollama, etc.)
- Node 20+

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

```bash
cp examples/models.unsloth-studio.json ~/.pi/agent/models.json
chmod 600 ~/.pi/agent/models.json
pi --provider unsloth-studio --model "unsloth/Qwen3.6-27B-GGUF" "list files in this dir"
```

If `~/.pi/agent/models.json` already exists, merge by hand — pi-mono accepts multiple providers in one file.

### Recommended: launch via `pi-launch.sh`

Use the wrapper at [`scripts/pi-launch.sh`](./scripts/pi-launch.sh) (or [`scripts/pi-launch.ps1`](./scripts/pi-launch.ps1)) instead of calling `pi` directly. It runs [`scripts/check-env.js`](./scripts/check-env.js) first to confirm every env-var-named `apiKey` resolves to a non-empty value. Without that gate, an unset env var can cause pi-mono to ship the literal env-var name as the bearer token (R2 in [`SECURITY.md`](./SECURITY.md)).

```bash
ln -s "$(pwd)/scripts/pi-launch.sh" /usr/local/bin/pi-launch
pi-launch --provider unsloth-studio --model "unsloth/Qwen3.6-27B-GGUF" "list files"
```

Track 1 is complete at this point. Skip to "Probe results" below if you don't want the daemon.

---

## pi-comms quickstart (Track 2)

Only do this if you want pi reachable from Telegram or WhatsApp.

### Set env vars

Copy `.env.example` to `.env` and fill in the channel secrets you want active. Minimum for Telegram-only:

```bash
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_ALLOWED_USER_IDS=<your numeric Telegram ID; comma-separated for multiple>
UNSLOTH_API_KEY=<same key your pi CLI uses>
PI_COMMS_DEFAULT_MODEL=unsloth-studio/unsloth/Qwen3.6-27B-GGUF
PI_COMMS_SANDBOX=on
```

For WhatsApp also set `WHATSAPP_IDENTITY_MODEL` (`second-number` recommended), `WHATSAPP_OWNER_JID`, and `WHATSAPP_BOT_JID` — see [`docs/INSTALL-WHATSAPP.md`](./docs/INSTALL-WHATSAPP.md) for the threat-model and pair-flow details (read the "Threat-model honesty (READ FIRST)" section first).

### npm scripts

| Script | What it does |
|---|---|
| `npm run daemon` | Run the daemon in the foreground (`tsx src/daemon.ts`) — useful for development and debugging |
| `npm run cli` | Run the thin client CLI (`tsx bin/pi-comms.ts`) — sends a request to a running daemon over its IPC socket |
| `npm run probe` | Re-run the Track-1 probe (alias for `node scripts/probe-toolcalls.js`) |
| `npm run studio-variant` | Show which GGUF variant Studio currently has loaded |
| `npm run spike` | Run the Phase -1 SDK verification spike (six probes against pi-mono SDK assumptions) |
| `npm run typecheck` | TypeScript check, no emit |
| `npm test` | Vitest unit + integration tests |

### Attach pi-comms to your shell

After the daemon is running, in any terminal:

```bash
npm run cli -- "list files in this dir"
# or, if you want pi-comms on PATH:
ln -s "$(pwd)/bin/pi-comms.ts" /usr/local/bin/pi-comms
pi-comms attach     # opens an interactive session against the running daemon
pi-comms status     # show the status pointer (what pi is doing right now)
pi-comms shutdown   # graceful drain
```

### Production-style install (per-OS autostart)

When you want the daemon to survive logout / reboot, install the per-OS autostart layer per [`docs/INSTALL.md`](./docs/INSTALL.md):

```bash
# macOS
scripts/install-launchd.sh

# Linux (requires `sudo loginctl enable-linger $USER` first — installer asserts)
scripts/install-systemd.sh

# Windows
pwsh scripts\install-windows-task.ps1
```

Verify with `pi-comms doctor`.

---

## What this is NOT

Honesty matters more than slogans. Read this section before adopting anything here:

- **NOT for production.** Single-user single-machine alpha. No multi-tenancy, no auth-profile rotation across multiple Telegram bots, no horizontal scaling. Do not put this on a server other people use.
- **NOT a Claude/ChatGPT replacement.** Local Qwen3.6-27B is a junior pair programmer for grunt work. Tool-call fidelity hovers around 85%/call; multi-call chains degrade. Use Q4_K_M minimum or higher (see GGUF variants section below).
- **NOT multi-user.** DM-only allowlist enforced. Group messages silently dropped (audit-logged as `dm_only_reject`). Multi-user routing belongs in OpenClaw, not here.
- **NOT voice-yet.** WhatsApp voice messages get a placeholder text. Image/document inbound similarly stubbed. Whisper.cpp + Opus + ffmpeg path is v2.
- **NOT for groups.** Same as multi-user — groups are out of scope. The DM filter is intentional, not an oversight.
- **NOT a sandbox guarantee on Windows.** Windows v1 has NO AppContainer support; the daemon refuses to start unless you set `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true` to consciously accept the lack of OS-level isolation. Linux uses `bwrap`; macOS ≤25 uses `sandbox-exec`; macOS 26+ requires Apple's developer entitlement (check [`docs/INSTALL.md`](./docs/INSTALL.md) for status).
- **NOT a WhatsApp Business or supported integration.** The WhatsApp channel uses [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered WhatsApp Web client. Account-ban risk is non-zero; use the recommended `second-number` identity model (see [`docs/INSTALL-WHATSAPP.md`](./docs/INSTALL-WHATSAPP.md)).
- **NOT coupled to any specific RAG project.** This is pure infrastructure — pi sends OpenAI-compat HTTP requests, your local server answers, optional channels bring messages in.
- **NOT prompt-injection-proof.** A local-LLM coding agent with a `bash` tool is a prompt-injection RCE primitive. The classifier in `src/session/classifier.ts` is a tripwire, not a security control. Read [`SECURITY.md`](./SECURITY.md) §"Operator discipline" before pointing pi at anything you didn't author.
- **NOT going to publish to npm any time soon.** `private: true` is set in `package.json`. Public GitHub repo, but no `npm publish` until v1 stabilizes.

---

## GGUF variants (Unsloth Studio)

A single Studio model id like `unsloth/Qwen3.6-27B-GGUF` is actually a *family* of GGUF quantizations (`Q3_K_M`, `Q4_K_M`, `UD-Q4_K_XL`, `Q5_K_M`, `Q8_0`, …). Studio exposes only the **base id** through its OpenAI-compat `/v1` layer — pi-mono can't see or pick a variant. Whichever variant Studio has loaded *is* what pi will hit.

**Why it matters:** quantization affects tool-call schema fidelity. Q2/Q3 frequently omit required arguments on multi-arg tools (e.g. pi's `edit({path, edits: [...]})` shows up as `edit({path})` and pi rejects locally with a validation error, which then poisons the next turn). Use **Q4_K_M or UD-Q4_K_XL minimum** for coding-agent loops.

Check the loaded variant:

```bash
node scripts/studio-variant.js
# active_model:  unsloth/Qwen3.6-27B-GGUF
# gguf_variant:  UD-Q4_K_XL    ← this is what actually answers your requests
```

Or inside pi: `cp extensions/studio-variant.ts ~/.pi/agent/extensions/` then `/studio-variant`.

To change variants: open Studio's web UI at `http://localhost:8888`, use the model picker to load the variant you want, re-run `node scripts/studio-variant.js` to confirm. The OpenAI `/v1` endpoint silently ignores any `:variant` suffix in the model id.

---

## Schema notes (pi-mono ≥ 0.70)

The `models.json` schema pi-mono actually reads (per `<pi-coding-agent>/docs/models.md`):

| Field | Notes |
|---|---|
| `api` | **Not** `type`. Values: `openai-completions`, `anthropic-messages`, `google-generative-ai`, `openai-responses`. |
| `apiKey` | Env var **name** (`"UNSLOTH_API_KEY"`), shell command (`"!op read ..."`), or literal value. No `$` prefix. |
| `authHeader: true` | Required for `Bearer <key>` auth on OpenAI-compat endpoints. |
| `input` | `["text"]` or `["text","image"]`. Required. |
| `cost` | Required (use all zeros for local) or pi reports fake dollars per turn. |
| `tools` | Not a field — tool-calling capability is decided by the backend at runtime. The probe is what verifies it. |

---

## Probe results

| Backend | Model | Quant / variant | Hardware | OS | pi-mono | Date | Verdict | Contributor | Example config |
|---|---|---|---|---|---|---|---|---|---|
| Unsloth Studio | `unsloth/Qwen3.6-27B-GGUF` | UD-Q4_K_XL | RTX 5070 (12 GB) | Windows 11 | 0.70.6 | 2026-04-29 | **PASS** | [@KanuToCL](https://github.com/KanuToCL) | [`examples/models.unsloth-studio.json`](./examples/models.unsloth-studio.json) |
| Ollama | `qwen2.5:14b-instruct-q4_K_M` | Q4_K_M | — | — | — | — | known-good (mature, no formal probe verdict on file) | — | [`examples/models.ollama.json`](./examples/models.ollama.json) |
| LM Studio | TBD | TBD | — | — | — | — | untested skeleton | — | [`examples/models.lm-studio.json`](./examples/models.lm-studio.json) |
| vLLM | TBD | TBD | — | — | — | — | untested skeleton | — | [`examples/models.vllm.json`](./examples/models.vllm.json) |

| Verdict | Meaning |
|---|---|
| **PASS** | `node scripts/probe-toolcalls.js` exits 0 — backend emits structured `tool_calls[]` and pi-mono can drive it |
| known-good | Backend works in practice; no probe verdict on file with hardware attribution |
| untested skeleton | A `models.json` example exists but no PASS verdict has been submitted — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) |

Submit a row for your hardware/model via the verdict template in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Why the probe

pi-mono parses tool calls **only** from the OpenAI-structured `choice.delta.tool_calls[]` field. If your local server emits Qwen3's `<tool_call>...</tool_call>` text inside `delta.content` instead, pi treats it as chat prose and never invokes the tool — the entire coding-agent value collapses silently. The probe sends one tool-augmented request and asserts `tool_calls[]` is populated **and** `content` does not contain a `<tool_call>` literal. 30 lines of Node, no dependencies. Run it before adopting any new backend.

---

## Acknowledgements

The pi-comms daemon lifts ~10 named patterns from [`gemini-claw`](https://github.com/sergiopena/gemini-claw) almost verbatim, plus depends on pi-mono, Baileys, and grammy. See [`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md) for file:line citations on every lifted pattern.

---

## Security

Read [`SECURITY.md`](./SECURITY.md) before running anything in this repo. Track-1 risks (R1-R14) cover the probe + config + pi CLI surface; Track-2 risks (R15-R30) cover the daemon, sandbox, IPC, and channel surfaces. tl;dr for first-time users: launch via `pi-launch.sh`, set `PI_COMMS_SANDBOX=on`, don't `/share` sessions that touched secrets, don't run pi from a directory containing secrets, and read [`docs/INSTALL-WHATSAPP.md`](./docs/INSTALL-WHATSAPP.md) §"Threat-model honesty" before pairing WhatsApp.

Report a vulnerability via [GitHub security advisory](https://github.com/KanuToCL/pi-local-llm-provider/security/advisories/new). Lower-sensitivity findings via a regular issue with the `security` label.

---

## Contributing

Probe verdicts for new hardware/model combinations are the highest-leverage contribution. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the verdict template, code style (zero runtime deps in scripts/, ESM-only Node, shellcheck-clean bash), and what's out of scope.

---

## License

MIT — see [`LICENSE`](./LICENSE).

---

## Sample output

An end-to-end artifact produced by this stack (Qwen3.6-27B UD-Q4_K_XL, locally) is in [`examples/blog-artifacts/`](./examples/blog-artifacts/) — a self-contained 506-line stylish HTML page about caterpillar life cycles, generated by the model with no cloud calls. Useful as a reference for what the local agent loop can produce on a single consumer GPU.

---

## Author

Sergio Pena ([sergiopena.audio](https://sergiopena.audio) · [@KanuToCL](https://github.com/KanuToCL))
