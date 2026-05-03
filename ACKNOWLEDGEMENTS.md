# Acknowledgements

This repo stands on three pieces of prior art: pi-mono (the agent runtime), gemini-claw (the operator-shell pattern), and Baileys + grammy (the channel transports). The pi-comms daemon shipped in v0.2 lifts ~10 named patterns from gemini-claw almost verbatim — this file names every one with a file:line citation so credit is unambiguous and so a reader can audit the provenance themselves.

---

## pi-mono — agent runtime (Layer 3)

[**pi-mono**](https://github.com/badlogic/pi-mono) by Mario Zechner ([@badlogic](https://github.com/badlogic)) — the BYO-LLM coding agent that this repo wraps. Without `createAgentSession()`, `defineTool()`, the streaming-with-callback architecture, and the OpenAI-compat custom-provider plumbing, the entire pi-comms daemon would not exist. pi-mono is the Layer-3 substrate; everything in `src/` here is glue around it.

License: MIT. Pinned via the `@mariozechner/pi-coding-agent` optional dependency in `package.json`.

---

## gemini-claw — Telegram operator-shell prior art

[**gemini-claw**](https://github.com/sergiopena/gemini-claw) by Sergio Sachar ([siddsachar](https://www.npmjs.com/~siddsachar) per the package.json author field of the cloned source at `/Users/psergionicholas/Desktop/Cosas/personal/gemini-claw/package.json:6`) — a Telegram-native Gemini CLI personal AI operator with private allowlisted chats (~4000 LOC, 3 runtime deps: grammy + zod + dotenv). Same problem domain as pi-comms: turn a Telegram bot into a private operator interface for a coding agent. Sergio Pena read every load-bearing source file before drafting v3 of the pi-comms plan; that deep-dive is captured in §"Prior art — gemini-claw deep-dive (read 2026-05-02)" of `~/.llms/plans/pi_comms_daemon.plan.md`.

License: MIT (verified via direct repo inspection). MIT-license-compatibility note: this repo also ships under MIT (see [`LICENSE`](./LICENSE)); lifted patterns retain compatibility under the original MIT terms.

### The 10 lifted patterns (file:line citations)

Each row below names a load-bearing pattern in pi-comms, the gemini-claw source it was adapted from, and where it now lives in this repo. Every claim is auditable by reading both sources side-by-side.

| Pattern | Source in gemini-claw | Adaptation in pi-comms |
|---|---|---|
| **Zod env config** | `src/config.ts:6-38` (envSchema) + `:128-168` (loadConfig) — single source of truth, fails loud on misconfig with concrete error messages, type inference flows everywhere | Adapted to `PI_COMMS_*` env vars; added WhatsApp number allowlist, status-pointer path, daemon socket path; dropped Gemini-specific knobs. See `src/config/` (IMPL-1 commit `21c258c`) |
| **DM-only + allowlist middleware** | `src/bot/auth.ts:11-31` (requireAllowedUser) — 31 lines, DM-check-then-sender-allowlist order, polite rejection messages, **allowlisted users still rejected in groups/supergroups** | Mirrored exactly for grammy; equivalent written for Baileys (chat-jid filter for DMs, sender-jid for allowlist). Same DM-first posture; group support is v3+. See `src/channels/telegram.ts` + `src/channels/whatsapp.ts` (IMPL-12 + IMPL-17, commits `957ee82` + `85b1acf`) |
| **Per-key serial queue** | `src/assistant/chatQueue.ts:1-28` (whole file) — cleanest single-key-mutex pattern, `previous.catch(()=>undefined).then(()=>current)` idiom, 28 LOC | We need a *global* queue (single GPU = one inference at a time); collapsed to single-key version with key='global'. See `src/lib/queue.ts` (IMPL-2 commit `7777a0a`) |
| **Atomic JSON store** | `src/storage/JsonSessionStore.ts:1-105` — tempfile+rename atomic write, write-queue serialization, corrupt-file quarantine to `.corrupt-<ts>` | Used for status-pointer storage AND session-meta. The corrupt-quarantine pattern addresses Pitfall #9 directly. See `src/storage/atomic-store.ts` (IMPL-4 commit `d7659d2`) |
| **Outbound chunking** | `src/bot/messageUtils.ts:1-36` (chunkTelegramMessage) — splits at newlines first (>0.6 of max), then spaces, then hard-cut, 36 LOC | Used for both Telegram (4096 max) and WhatsApp (~65k but Baileys recommends smaller); renamed `chunkOutbound(text, channelMax)`. See `src/lib/chunk.ts` (IMPL-2 commit `7777a0a`) |
| **OperatorLogger** | `src/utils/operatorLogger.ts:1-191` — three styles (pretty/plain/json), three levels (silent/info/debug), `includeContent: false` by default for privacy, icon registry, preview-with-truncation, `noopOperatorLogger` for testing | LIFTED NEARLY VERBATIM. Adapted icon set to pi-comms event names (added: `tell_emit`, `confirm_request`, `confirm_resolved`, `classifier_block`, `daemon_boot`, `pointer_loaded`). Default `includeContent=false` preserved. See `src/observability/operator-logger.ts` (IMPL-3 commit `f312ceb`) |
| **AssistantTaskManager pattern** | `src/assistant/taskManager.ts:1-424` — worker pool with per-chat caps, AbortController-based cancellation, lifecycle (`task_queued`→`running`→`succeeded`/`failed`/`cancelled`), task history with limit, `onEvent`/`onComplete` callbacks | LIFTED THE PATTERN with `maxWorkers=1` for v1 (single GPU). Per-chat cap (`maxChatQueuedTasks=10`) prevents queue-bomb from compromised account; AbortController flow drives `/cancel`. Trimmed subagent-tracking. See `src/session/task-state.ts` (IMPL-7 commit `d40a096`) |
| **Slash command set** | `src/bot/commands.ts:31-170` (registerCommands) — `/start /help /reset /status /tools /plan /task /tasks /task_status /cancel /workers /subagents` | LIFTED THE LIST. Adapted: dropped `/tools /plan /subagents` (Gemini-CLI-specific) + `/task /tasks /task_status /workers` (Option-C UX makes them unnecessary); added `/confirm <id> yes/no` (destructive-cmd flow), `/pointer` (show status pointer body), `/who` (which surface). See `src/channels/commands.ts` (IMPL-14 commit `f92c0b5`) |
| **Typing indicator + tool progress reporter** | `src/bot/messageHandler.ts:70-140` (createToolProgressReporter, startTypingIndicator) — Telegram typing action every 4s, tool progress dedup'd at 1.5s with `lastProgressKey` | Typing indicator on every channel that supports it; throttle/dedup primitive transferred directly to `tell()` cooldown logic (gemini-claw's 1.5s for tool events; pi-comms `tell()` at 30s for identical-text dedup). See `src/channels/telegram.ts` (IMPL-12 commit `957ee82`) |
| **`bot.catch` error handler** | `src/bot/telegramBot.ts:52-67` — distinguishes `GrammyError` vs `HttpError` vs unknown, doesn't crash on Telegram-side errors | Mirrored for grammy; equivalent for Baileys catches `Boom` errors and reconnects on auth/connection failures. See `src/channels/telegram.ts` + `src/channels/whatsapp.ts` |
| **Command argument extraction** | `src/bot/commands.ts:304-311` (extractCommandArgument) — handles Telegram's `/cmd@botname arg` form when bot is in a group, one regex | Lifted verbatim. Defensive against future group support even though pi-comms is DM-only. See `src/channels/commands.ts` |
| **AsyncIterable event stream** | `src/assistant/types.ts:14-40` + consumer at `src/assistant/assistantService.ts:80` — unified abstraction over multiple agent backends; event types: `content_delta`, `content_final`, `tool_start`, `tool_end`, `stats` | Used this exact shape, mapped to pi-mono's `onBlockReply`/`onPartialReply`/`onToolResult` callbacks. Added pi-comms-specific events: `tell_emit`, `confirm_request`, `confirm_resolved`. See `src/session/session-manager.ts` (IMPL-15 commit `0b9d9ba`) |

### What we deliberately did NOT lift

For honesty: the pi-comms plan §"Reject (gemini-claw choices that don't fit our use case)" lists six gemini-claw decisions we explicitly rejected — subprocess invocation (we use library-embed for first-class tools), per-chat isolated sessions (single-user single-GPU), YOLO-always pass-through (we built classifier-gated `confirm()`), worker pool with N>1 (single GPU), no status pointer (we add one), and mutable system prompt (ours is SHA-pinned). Read that section of the plan if you want the full rejection rationale.

---

## Baileys — WhatsApp transport

[**Baileys**](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys@^7`) — the reverse-engineered WhatsApp Web client that powers the pi-comms WhatsApp channel. Baileys exists in the gray zone of WhatsApp's ToS; Sergio's risk acceptance and the account-ban honesty disclosure live in [`docs/INSTALL-WHATSAPP.md`](./docs/INSTALL-WHATSAPP.md) §"Threat-model honesty (READ FIRST)".

License: MIT. Pinned to `7.0.0-rc.9` in `package.json` optionalDependencies.

---

## grammy — Telegram bot framework

[**grammy**](https://github.com/grammyjs/grammy) — the Telegram bot framework used in pi-comms (`grammy@^1.42`). Same framework gemini-claw uses (`grammy@^1.36`); the API surface we touch (`bot.command`, `bot.on('message:text')`, `bot.catch`, typing actions via `ctx.replyWithChatAction`) is stable across both versions. The `@grammyjs/runner` add-on is intentionally NOT used — single-user single-bot doesn't need parallelism.

License: MIT. Pinned in `package.json`.

---

## Author / maintainer

Sergio Pena ([sergiopena.audio](https://sergiopena.audio) · [@KanuToCL](https://github.com/KanuToCL)) — single-maintainer. Issues and probe verdicts welcome at the [GitHub repo](https://github.com/KanuToCL/pi-local-llm-provider).
