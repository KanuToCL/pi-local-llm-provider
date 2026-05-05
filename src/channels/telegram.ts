/**
 * Telegram channel — grammy adapter.
 *
 * Plan refs:
 *   - §"Phase 1 (revised v4.3) — Telegram via grammy" — Telegram is the v1
 *     critical-path channel.
 *   - §"Lift wholesale" — `requireAllowedUser` (gemini-claw auth.ts:11-31),
 *     `chunkOutbound` (gemini-claw messageUtils.ts:1-36), typing indicator
 *     (gemini-claw messageHandler.ts:121-140).
 *   - §"v4 changelog Accessibility — voice-arrival policy" + Pitfall #21:
 *     non-text inbound (voice/image/document) gets synthesized to a textual
 *     placeholder for v1; the audioRef/imageRef path is preserved on the
 *     filesystem-side seam so v2 (whisper.cpp / vision) can pick it up.
 *   - §"Testing Elder silent-vs-polite reject" (line 1342): SILENT-reject
 *     for both DM-only violations AND allowlist violations (don't ack
 *     non-allowlisted senders — gives no signal to scanners).
 *
 * Lifted (and adapted) patterns:
 *   - DM-only + allowlist middleware: `gemini-claw/src/bot/auth.ts`
 *     (`requireAllowedUser`).  Adapted for SILENT rejection.
 *   - Bot lifecycle (`new Bot`, `bot.use`, `bot.on`, `bot.catch`,
 *     `bot.start`/`bot.stop`): `gemini-claw/src/bot/telegramBot.ts`.
 *   - Typing indicator: `gemini-claw/src/bot/messageHandler.ts:121-140`.
 *   - Outbound chunking: lifted via `src/lib/chunk-outbound.ts` (IMPL-2 W1).
 */

import { Bot, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";

import { chunkOutbound } from "../lib/chunk-outbound.js";
import {
  InboundMediaStore,
  type InboundMediaSavedRef,
} from "../lib/inbound-media.js";
import type {
  ChannelEvent,
  InboundMessage,
  InboundProcessor,
  Sink,
} from "./base.js";
import type { AuditLog } from "../audit/log.js";
import type { AuditEntry, RestartReason } from "../audit/schema.js";
import type { InboundRateLimiter } from "../lib/inbound-rate-limit.js";
import type { OperatorLogger } from "../utils/operator-logger.js";
import { monotonicMs } from "../lib/clock.js";
import { installPollAttemptTransformer } from "./poll-attempt-transformer.js";

/**
 * Pluggable downloader used to fetch a Telegram file given its API URL.
 * Defaults to `globalThis.fetch` (Node 20+).  Tests inject a stub so they
 * never hit api.telegram.org / external HTTP.
 */
export type TelegramFileDownloader = (url: string) => Promise<Buffer>;

async function defaultDownload(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`telegram_file_download_http_${res.status}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `start()` if the Telegram API rejects the bot token.  This is a
 * fatal config error; the daemon should surface it to the operator and stop.
 */
export class TelegramAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TelegramAuthError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TelegramChannelOpts {
  /** Bot token from BotFather. */
  botToken: string;
  /**
   * Allowlist of Telegram user-ids (as strings — Telegram user-ids are
   * numeric but we accept string form for env-var ergonomics).  Empty set
   * = nobody allowed; this is intentional to fail-closed if config is
   * misread.
   */
  allowedUserIds: ReadonlySet<string>;
  /** Daemon-side glue that processes a normalized InboundMessage. */
  inboundProcessor: InboundProcessor;
  /**
   * Outbound chunk size.  Telegram caps at 4096 chars; we default to 3900
   * to leave headroom for prefix glyphs ("📱 ", "❓ Confirm needed (…): ", etc.).
   */
  chunkSize?: number;
  /**
   * Typing-indicator emit interval in ms.  Telegram clears typing after ~5s
   * of silence; 4000 ms keeps the dots flowing without slamming the API.
   */
  typingIntervalMs?: number;
  /** Audit-log writer (optional in tests; required in production daemon). */
  auditLog?: AuditLog;
  /** Operator-side console logger (optional). */
  operatorLogger?: OperatorLogger;
  /**
   * Optional injection point for a pre-constructed Bot (used by tests to
   * avoid hitting api.telegram.org).  When omitted, we construct a fresh
   * `new Bot(opts.botToken)`.
   */
  botFactory?: (token: string) => Bot;
  /**
   * Optional callback invoked from the bot's first middleware on every
   * inbound update — used by the daemon's Heartbeat to record a
   * `telegram-poll` liveness touch.  Fires even when the inbound update is
   * about to be silent-rejected (DM-only / allowlist), because the poll
   * itself succeeded.
   */
  onPoll?: () => void;
  /**
   * Optional per-sender / per-channel inbound rate limiter (FIX-B-3 Wave 8).
   * When provided, each inbound message is checked AGAINST the limiter
   * BEFORE the DM-only / allowlist gates so a flooding sender cannot exhaust
   * downstream queue budget. Silent reject + audit on rate-limit; the bot
   * still polls (heartbeat is touched first). Omit in tests that don't
   * exercise rate-limit semantics.
   */
  inboundRateLimiter?: InboundRateLimiter;
  /**
   * Persistence backend for non-text inbound media (voice notes, photos,
   * documents).  When provided, the channel downloads the underlying file
   * via `bot.api.getFile` + HTTP fetch, saves it via the store, and
   * populates the appropriate `payload.audioRef` / `imageRef` /
   * `documentRef` field on the InboundMessage so v2 STT / vision can pick
   * it up (per BLESS Accessibility — closes the v4 changelog audioRef seam).
   * When omitted (typical: tests with no media coverage), the channel falls
   * back to placeholder-only behavior — the synthesized text still goes
   * through but no ref is populated.
   */
  inboundMediaStore?: InboundMediaStore;
  /**
   * Test-injectable HTTP downloader for Telegram file URLs.  Defaults to
   * the global `fetch` (Node 20+).  Tests stub this to return a synthetic
   * Buffer so they never reach api.telegram.org.
   */
  fileDownloader?: TelegramFileDownloader;
  /**
   * Optional salted sender-id hasher (per Security BLESS-W1, v0.2.2).
   * When provided, the channel uses this for the `sender_id_hash` field on
   * audit rows + operator logs instead of the local non-salted
   * `hashSenderId`. Production daemon wiring (IMPL-V2-C territory) hands
   * down a closure that calls `AuditLog.senderIdHash(id, installSalt)`.
   * When omitted (typical: tests + back-compat), the channel falls back to
   * the local weak hash.  Either way the load-bearing privacy invariant
   * ("raw jid never written to disk") is satisfied — only a hash is ever
   * written.  TODO(v0.3): remove the fallback once the daemon always wires
   * the salted hasher.
   */
  senderIdHash?: (id: string) => string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 3900;
const DEFAULT_TYPING_INTERVAL_MS = 4000;
const TELEGRAM_FILE_API_BASE = "https://api.telegram.org/file/bot";

// ---------------------------------------------------------------------------
// TelegramChannel
// ---------------------------------------------------------------------------

/**
 * One Telegram bot, one allowlist, one inbound processor.
 *
 * Inbound flow:
 *   bot.on("message:text" | "message:voice" | "message:photo" |
 *          "message:document")
 *     → middleware: silent-reject if non-private chat OR sender not
 *                   in allowlist (audit recorded either way)
 *     → for text: build InboundMessage{type:'text'} and fire-and-forget
 *                 inboundProcessor.processInbound(msg)
 *     → for voice/image/document: synthesize textual placeholder
 *                 ("[user sent a voice — non-text inbound is deferred;
 *                 please type]"), still build InboundMessage{type:'text',
 *                 channel:'telegram'} so the agent surface is uniform.
 *                 Audit records the original messageType.
 *
 * Outbound flow:
 *   tools/framework call sink.send(ChannelEvent)
 *     → map event → user-facing text via formatChannelEvent()
 *     → chunkOutbound(text, chunkSize)
 *     → for each chunk: bot.api.sendMessage(activeChatId, chunk)
 *
 * Lifecycle:
 *   start():  performs api.getMe() probe (throws TelegramAuthError on bad
 *             token), emits `telegram_connect` audit, and kicks off the
 *             grammy long-poll via bot.start() in the background.  Resolves
 *             ONCE the probe succeeds — does NOT wait for bot.start() to
 *             return (that resolves only after stop()).
 *   stop():   bot.stop(), clear typing timer, emit `telegram_disconnect`.
 */
export class TelegramChannel implements Sink {
  // NOT readonly — `restart()` (Plan v3 §1.2c) reassigns this with a freshly
  // constructed Bot to recover from outbound TCP wedges (Adversarial B2).
  private bot: Bot;
  private readonly botToken: string;
  private readonly botFactory: (token: string) => Bot;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly inboundProcessor: InboundProcessor;
  private readonly chunkSize: number;
  private readonly typingIntervalMs: number;
  private readonly auditLog?: AuditLog;
  private readonly operatorLogger?: OperatorLogger;
  private readonly onPoll: (() => void) | undefined;
  private readonly inboundMediaStore: InboundMediaStore | undefined;
  private readonly fileDownloader: TelegramFileDownloader;
  private readonly inboundRateLimiter: InboundRateLimiter | undefined;
  /**
   * Sender-id hasher used for `sender_id_hash` audit fields. Per Security
   * BLESS-W1 (v0.2.2): operator-injected via `senderIdHash` opt to use the
   * salted `AuditLog.senderIdHash`; when absent we fall back to the local
   * weak `hashSenderId`. TODO(v0.3): remove fallback once daemon always
   * wires the salted hasher.
   */
  private readonly senderIdHash: (id: string | number) => string;
  /**
   * Tracks in-flight async media-download/save handlers spawned from the
   * (synchronous) grammy `bot.on(...)` callback.  Tests await `flushPending()`
   * to deterministically observe processInbound calls without tick-counting.
   * Production callers don't observe this — the pending set is best-effort
   * cleanup and self-empties as handlers settle.
   */
  private readonly pendingHandlers: Set<Promise<unknown>> = new Set();

  /**
   * The chat id the most-recent inbound message came from.  Outbound
   * `send()` calls target this chat.  `null` if no inbound has arrived
   * yet — `send()` becomes a no-op in that state (no one to deliver to).
   */
  private activeChatId: number | null = null;

  /**
   * Typing-indicator state.  `markTaskStart()` sets up a setInterval that
   * pings sendChatAction("typing") every typingIntervalMs.  `markTaskEnd()`
   * clears it.  `send()` does NOT clear typing — the caller decides when
   * the task is done (a multi-chunk reply is still "the same task").
   */
  private typingChatId: number | null = null;
  private typingTimer: NodeJS.Timeout | null = null;

  private connected = false;
  private startPromise: Promise<void> | null = null;

  constructor(opts: TelegramChannelOpts) {
    // Save factory so restart() (Plan v3 §1.2c) can reconstruct the Bot via
    // the same path the constructor used. Default factory matches v0.2.2
    // semantics (`new Bot(token)`) so absent-factory callers don't change.
    this.botFactory = opts.botFactory ?? ((token: string) => new Bot(token));
    this.bot = this.botFactory(opts.botToken);
    this.botToken = opts.botToken;
    this.allowedUserIds = opts.allowedUserIds;
    this.inboundProcessor = opts.inboundProcessor;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.typingIntervalMs = opts.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;
    this.auditLog = opts.auditLog;
    this.operatorLogger = opts.operatorLogger;
    this.onPoll = opts.onPoll;
    this.inboundMediaStore = opts.inboundMediaStore;
    this.fileDownloader = opts.fileDownloader ?? defaultDownload;
    this.inboundRateLimiter = opts.inboundRateLimiter;
    // Per Security BLESS-W1 (v0.2.2): prefer caller-supplied salted hasher;
    // fall back to the local weak hash so existing tests and minimal-config
    // callers continue to work.
    this.senderIdHash = opts.senderIdHash
      ? (id) => opts.senderIdHash!(String(id))
      : (id) => hashSenderId(id);

    // Plan v3 §1.2b — wire heartbeat through the API transformer so it
    // fires on every successful `getUpdates` (incl. empty long-poll
    // returns), not just on update receipt. Replaces the v0.2.2
    // first-middleware that touched onPoll.
    installPollAttemptTransformer(this.bot, () => {
      try {
        this.onPoll?.();
      } catch {
        /* heartbeat best-effort; never break the bot loop */
      }
    });

    this.installMiddleware();
    this.installHandlers();
    this.installErrorHandler();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    // Probe auth.  Throws TelegramAuthError if the token is bad.
    try {
      await this.bot.api.getMe();
    } catch (error) {
      const description =
        error instanceof Error ? error.message : String(error);
      const authError = new TelegramAuthError(
        `Telegram getMe failed (bad token?): ${description}`,
        error,
      );
      // Best-effort audit; do not let an audit-log failure mask the auth one.
      void this.audit({
        event: "telegram_disconnect",
        task_id: null,
        channel: "telegram",
        sender_id_hash: null,
        error_class: authError.name,
      }).catch(() => undefined);
      throw authError;
    }

    this.connected = true;
    await this.audit({
      event: "telegram_connect",
      task_id: null,
      channel: "telegram",
      sender_id_hash: null,
    });

    // Start the long-poll loop in the background.  bot.start() resolves
    // only when bot.stop() is called — we MUST NOT await it here, or
    // start() would never return.  Errors during polling are routed
    // through bot.catch (installed in installErrorHandler).
    this.startPromise = this.bot.start().catch((error) => {
      // Long-poll failures are non-fatal at this layer; log + audit and
      // let the daemon decide whether to restart.
      // Plan v3 §1.2d (Security B1): grammY error messages may carry the
      // bot token (e.g., embedded in the api.telegram.org URL). Redact
      // before stamping into operator logs.
      this.operatorLogger?.error("telegram_polling_error", {
        error_class: error instanceof Error ? error.name : "unknown",
        message: redactBotToken(
          this.botToken,
          error instanceof Error ? error.message : String(error),
        ),
      });
      void this.audit({
        event: "telegram_disconnect",
        task_id: null,
        channel: "telegram",
        sender_id_hash: null,
        error_class: error instanceof Error ? error.name : "unknown",
      }).catch(() => undefined);
      this.connected = false;
    });
  }

  async stop(): Promise<void> {
    this.markTaskEnd();
    if (this.bot.isRunning()) {
      await this.bot.stop();
    }
    this.connected = false;
    if (this.startPromise) {
      // Drain any pending long-poll error; never throws because catch above.
      await this.startPromise.catch(() => undefined);
      this.startPromise = null;
    }
    await this.audit({
      event: "telegram_disconnect",
      task_id: null,
      channel: "telegram",
      sender_id_hash: null,
    });
  }

  /**
   * Tear down the current Bot and reconstruct a fresh one (Plan v3 §1.2c —
   * Adversarial B2).
   *
   * Why full reconstruction (not just `bot.stop()` + `bot.start()`):
   *
   *   The H1/H2 production hangs (MIB-2026-05-05-1751) presented as wedged
   *   long-poll loops where the entire `Bot.api` outbound transport had
   *   stopped delivering. A simple stop+start re-uses the same underlying
   *   node-fetch agent + TCP connection-keepalive table — if the kernel-side
   *   handle is wedged, those persist across `start()`. By going through
   *   `botFactory(token)` again we get fresh `Bot`, fresh `bot.api`, fresh
   *   transformer chain, fresh fetch agent. New TCP connections from
   *   scratch.
   *
   * Audit semantics:
   *
   *   - `telegram_restart` is emitted BEFORE `bot.stop()` so a partial
   *     failure (e.g., reconstruction throw) still leaves a forensic row.
   *     The watchdog correlates `telegram_restart` against the lack of a
   *     subsequent `telegram_restart_completed` operator log to detect
   *     restart-attempt failures across daemon boots.
   *   - `telegram_restart_failed` is emitted in the catch block with the
   *     error class + redacted message + monotonic latency_ms.
   *
   * Latency math uses `monotonicMs()` (Adversarial CONCERN-2): a host
   * suspend mid-restart MUST NOT surface a phantom multi-hour latency
   * — the OS pauses hrtime alongside the process so resume-after-suspend
   * is naturally bounded.
   *
   * Throws if reconstruction fails. The watchdog catches and surfaces this
   * as a consecutive-failure for the restart cooldown / panic ladder.
   */
  async restart(reason: RestartReason): Promise<void> {
    // Audit BEFORE the operation so a partial-failure leaves the row.
    await this.audit({
      event: "telegram_restart",
      task_id: null,
      channel: "telegram",
      sender_id_hash: null,
      extra: { reason },
    });
    // OperatorLogger has no `warn` method (info/debug/error only — see
    // src/utils/operator-logger.ts:43); restart-initiated is operator-
    // visible and not an error so it goes to info.
    this.operatorLogger?.info("telegram_restart_initiated", { reason });

    const startMs = monotonicMs();
    try {
      // Stop the in-flight poller. AbortSignal threading is grammY-internal
      // (see node_modules/grammy/out/bot.js:290-297, 424). Returns within
      // ~pollTimeoutSec worst case; typically <100ms for healthy stops.
      // Hung-poll case waits for the long-poll's TCP-level timeout — which
      // is exactly the case the watchdog sized its restart-deadline against.
      if (this.bot.isRunning()) await this.bot.stop();

      // FULL Bot reconstruction (Adversarial B2). New TCP connections,
      // fresh node-fetch agent, fresh handle table on Windows. Addresses
      // the H1/H2 root-cause scenarios where the entire Bot.api transport
      // is wedged.
      this.bot = this.botFactory(this.botToken);
      installPollAttemptTransformer(this.bot, () => {
        try {
          this.onPoll?.();
        } catch {
          /* heartbeat best-effort */
        }
      });
      this.installErrorHandler();
      this.installMiddleware();
      this.installHandlers();
      // Re-probe — same as initial connect(). Confirms the fresh Bot
      // actually reaches Telegram before we declare ourselves alive.
      await this.bot.api.getMe();
      // Immediately enter the loop. bot.start() resolves only on stop(),
      // so we MUST NOT await it.
      void this.bot.start().catch((error) => {
        this.operatorLogger?.error("telegram_polling_error", {
          error_class: error instanceof Error ? error.name : "unknown",
          message: redactBotToken(
            this.botToken,
            error instanceof Error ? error.message : String(error),
          ),
        });
      });
      this.connected = true;
      const latencyMs = monotonicMs() - startMs;
      this.operatorLogger?.info("telegram_restart_completed", {
        reason,
        latency_ms: latencyMs,
      });
    } catch (e) {
      const latencyMs = monotonicMs() - startMs;
      const errorClass = e instanceof Error ? e.name : "unknown";
      // Plan v3 §1.2d (Security B1): redact the failure message before it
      // hits the operator log — grammY errors can carry the bot token in
      // embedded api.telegram.org URLs.
      const message = redactBotToken(
        this.botToken,
        e instanceof Error ? e.message : String(e),
      );
      this.operatorLogger?.error("telegram_restart_failed", {
        reason,
        latency_ms: latencyMs,
        error_class: errorClass,
        message,
      });
      await this.audit({
        event: "telegram_restart_failed",
        task_id: null,
        channel: "telegram",
        sender_id_hash: null,
        error_class: errorClass,
        extra: { reason, latency_ms: latencyMs },
      });
      this.connected = false;
      throw e; // surface to watchdog for consecutive-failure tracking
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Sink — outbound
  // -------------------------------------------------------------------------

  async send(event: ChannelEvent): Promise<void> {
    if (this.activeChatId === null) {
      // No inbound has arrived yet — no chat id to address.  Drop silently;
      // tools must tolerate this per Sink semantics ("best-effort, sinks
      // resolve even if the transport is unavailable").
      return;
    }
    const text = formatChannelEvent(event);
    if (!text) return;

    const chunks = chunkOutbound(text, this.chunkSize);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(this.activeChatId, chunk);
      } catch (error) {
        // Best-effort: log + continue.  Caller isn't expected to retry.
        this.operatorLogger?.error("telegram_send_error", {
          error_class: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Typing indicator (lifted from gemini-claw messageHandler.ts:121-140)
  // -------------------------------------------------------------------------

  /**
   * Mark a task as in-flight for the given chat.  Starts the typing
   * indicator immediately and refreshes it every `typingIntervalMs`.
   *
   * The daemon glue (IMPL-15) calls this when an inbound message kicks off
   * a task; how the daemon knows which channel/chat to mark is a wiring
   * concern handled by IMPL-13 (IPC) or IMPL-15 (session glue).
   */
  markTaskStart(chatId: number): void {
    // Idempotent: if a previous task didn't call markTaskEnd, clear it
    // first so we don't leak timers.
    this.markTaskEnd();

    this.typingChatId = chatId;
    void this.bot.api.sendChatAction(chatId, "typing").catch(() => undefined);
    this.typingTimer = setInterval(() => {
      if (this.typingChatId === null) return;
      void this.bot.api
        .sendChatAction(this.typingChatId, "typing")
        .catch(() => undefined);
    }, this.typingIntervalMs);
  }

  markTaskEnd(): void {
    if (this.typingTimer !== null) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    this.typingChatId = null;
  }

  // -------------------------------------------------------------------------
  // Internal — middleware
  // -------------------------------------------------------------------------

  /**
   * DM-only + allowlist gate.  SILENT-reject for both — see plan
   * §"Testing Elder silent-vs-polite reject" (v4 changelog).  Audit-log
   * always records the rejection reason.
   */
  private installMiddleware(): void {
    // NOTE (Plan v3 §1.2b): the v0.2.2 first-middleware that fired
    // `onPoll?.()` on every inbound update is REMOVED in v0.3 — heartbeat
    // is now wired through the grammY API transformer
    // (`installPollAttemptTransformer`, called from the constructor and
    // from `restart()`). The transformer fires on every successful
    // `getUpdates` poll attempt regardless of update count, fixing the
    // F2 false-positive ("healthy-but-quiet bot indistinguishable from
    // wedged bot") that bit production on 2026-05-04
    // (MIB-2026-05-05-1751).

    // Per-sender / per-channel rate-limit gate (FIX-B-3 Wave 8).  Runs
    // BEFORE DM-only / allowlist so a flooding sender cannot exhaust
    // downstream queue budget regardless of allowlist status.  Silent
    // reject + audit; the bot continues polling.
    this.bot.use(async (ctx, next) => {
      if (!this.inboundRateLimiter) {
        await next();
        return;
      }
      const senderId = ctx.from?.id;
      // No senderId = malformed update; let the next middleware deal with it.
      // (DM-only / allowlist gate already handles "no sender" as a reject.)
      if (senderId === undefined) {
        await next();
        return;
      }
      const verdict = this.inboundRateLimiter.allow(
        "telegram",
        String(senderId),
      );
      if (!verdict.ok) {
        await this.audit({
          event: "inbound_rate_limited",
          task_id: null,
          channel: "telegram",
          sender_id_hash: this.senderIdHash(senderId),
          extra: { reason: verdict.reason },
        });
        return; // silent
      }
      await next();
    });

    this.bot.use(async (ctx, next) => {
      const chatType = ctx.chat?.type;
      const senderId = ctx.from?.id;

      if (chatType !== "private") {
        await this.audit({
          event: "dm_only_reject",
          task_id: null,
          channel: "telegram",
          sender_id_hash: senderId !== undefined ? this.senderIdHash(senderId) : null,
          extra: { chat_type: chatType ?? "unknown" },
        });
        return; // silent
      }

      if (senderId === undefined || !this.allowedUserIds.has(String(senderId))) {
        await this.audit({
          event: "allowlist_reject",
          task_id: null,
          channel: "telegram",
          sender_id_hash: senderId !== undefined ? this.senderIdHash(senderId) : null,
        });
        return; // silent
      }

      await next();
    });
  }

  // -------------------------------------------------------------------------
  // Internal — message handlers
  // -------------------------------------------------------------------------

  private installHandlers(): void {
    this.bot.on("message:text", (ctx) => {
      this.handleInbound(ctx, "text", ctx.message.text, null);
    });

    this.bot.on("message:voice", (ctx) => {
      const synthetic =
        "[user sent a voice — non-text inbound is deferred; please type]";
      const voice = ctx.message.voice;
      const spec: TelegramMediaSpec = {
        kind: "audio",
        fileId: voice.file_id,
        ext: "ogg",
        ...(voice.mime_type !== undefined ? { mimeType: voice.mime_type } : {}),
      };
      this.handleInbound(ctx, "voice", synthetic, spec);
    });

    this.bot.on("message:photo", (ctx) => {
      const synthetic =
        "[user sent an image — non-text inbound is deferred; please type]";
      // Telegram returns multiple PhotoSize entries (thumbnails + full).
      // Pick the largest by file_size (fallback: last entry, which is the
      // highest-resolution variant per Telegram's documented ordering).
      const photos = ctx.message.photo;
      const largest = pickLargestPhoto(photos);
      const spec: TelegramMediaSpec = {
        kind: "image",
        fileId: largest.file_id,
        ext: "jpg",
        mimeType: "image/jpeg",
      };
      this.handleInbound(ctx, "image", synthetic, spec);
    });

    this.bot.on("message:document", (ctx) => {
      const synthetic =
        "[user sent a document — non-text inbound is deferred; please type]";
      const doc = ctx.message.document;
      const spec: TelegramMediaSpec = {
        kind: "document",
        fileId: doc.file_id,
        ext: doc.file_name ?? "bin",
        ...(doc.mime_type !== undefined ? { mimeType: doc.mime_type } : {}),
      };
      this.handleInbound(ctx, "document", synthetic, spec);
    });
  }

  /**
   * Build the InboundMessage and dispatch.  When `media` is non-null AND
   * an `inboundMediaStore` is configured, the buffer is downloaded from
   * Telegram, persisted, and the resulting absolute path is stamped into
   * `payload.audioRef` / `imageRef` / `documentRef` so v2 STT/vision can
   * read it (per BLESS Accessibility — closes the audioRef seam).  When
   * no store is configured (typical: minimal-config tests), we fall
   * through with placeholder-only behavior (back-compat).
   *
   * Even when media-save fails (HTTP error, disk full, store throws), we
   * STILL deliver the placeholder text — the user's intent ("a voice
   * arrived") must reach the agent regardless of whether v2 can read it.
   */
  private handleInbound(
    ctx: Context,
    originalKind: "text" | "voice" | "image" | "document",
    bodyText: string,
    media: TelegramMediaSpec | null,
  ): void {
    const senderId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    if (senderId === undefined || chatId === undefined) return;

    // Track the originating chat for outbound replies + typing.
    this.activeChatId = chatId;

    const senderName =
      ctx.from?.username ?? ctx.from?.first_name ?? undefined;

    // Per v0.2.2 PRODUCTION-FINDINGS-2026-05-03 §6.4 + Integration BLESS:
    // promoted from debug to info so dropped messages have a forensic trail
    // ("did the channel see this?"). Per Security BLESS-B1, this line and
    // the parallel audit row MUST contain ONLY message_type + sender_id_hash
    // — NO content fields (no text, no preview, no inbound_msg_hash).
    const senderHash = this.senderIdHash(senderId);
    this.operatorLogger?.info("telegram_inbound", {
      message_type: originalKind,
      sender_id_hash: senderHash,
    });
    void this.audit({
      event: "telegram_inbound",
      task_id: null,
      channel: "telegram",
      sender_id_hash: senderHash,
      extra: { message_type: originalKind },
    }).catch(() => undefined);

    if (
      media !== null &&
      this.inboundMediaStore !== undefined &&
      messageId !== undefined
    ) {
      // Download + save async, then dispatch.  Tracked so tests can await
      // via flushPending().
      const handler = this.dispatchInboundWithMedia(
        media,
        String(messageId),
        originalKind,
        bodyText,
        senderId,
        senderName,
      );
      this.track(handler);
      return;
    }

    // Fast path: text or unconfigured-store fallback — placeholder-only.
    const msg: InboundMessage = {
      type: originalKind === "document" ? "image" : originalKind, // documents collapse to "image" in the v1 inbound enum
      channel: "telegram",
      sender: { id: String(senderId), name: senderName },
      payload: { text: bodyText },
      ts: Date.now(),
    };
    void this.inboundProcessor.processInbound(msg).catch((error) => {
      this.operatorLogger?.error("telegram_inbound_processor_error", {
        error_class: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Async tail of `handleInbound` for the media path: getFile → download
   * via HTTP → save to InboundMediaStore → populate the right ref field
   * → fire processInbound.  All failures are non-fatal at the agent layer
   * (we still deliver the placeholder text); they surface to the operator
   * logger for diagnostics.
   */
  private async dispatchInboundWithMedia(
    media: TelegramMediaSpec,
    msgId: string,
    originalKind: "text" | "voice" | "image" | "document",
    bodyText: string,
    senderId: number,
    senderName: string | undefined,
  ): Promise<void> {
    const store = this.inboundMediaStore;
    const payload: InboundMessage["payload"] = { text: bodyText };
    if (store !== undefined) {
      try {
        const file = await this.bot.api.getFile(media.fileId);
        const filePath = file.file_path;
        if (typeof filePath === "string" && filePath.length > 0) {
          const url = `${TELEGRAM_FILE_API_BASE}${this.botToken}/${filePath}`;
          const buffer = await this.fileDownloader(url);
          const ref = await this.saveByKind(store, media, msgId, buffer);
          applyRefToPayload(payload, ref);
        } else {
          this.operatorLogger?.error("telegram_media_save_error", {
            reason: "missing_file_path",
            message_type: originalKind,
          });
        }
      } catch (error) {
        // Best-effort: log and proceed with placeholder-only.  The v1
        // contract is "agent always gets some text"; refs are upgrades.
        this.operatorLogger?.error("telegram_media_save_error", {
          error_class: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
          message_type: originalKind,
        });
      }
    }

    const msg: InboundMessage = {
      type: originalKind === "document" ? "image" : originalKind,
      channel: "telegram",
      sender: { id: String(senderId), name: senderName },
      payload,
      ts: Date.now(),
    };
    try {
      await this.inboundProcessor.processInbound(msg);
    } catch (error) {
      this.operatorLogger?.error("telegram_inbound_processor_error", {
        error_class: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private saveByKind(
    store: InboundMediaStore,
    media: TelegramMediaSpec,
    msgId: string,
    buffer: Buffer,
  ): Promise<InboundMediaSavedRef> {
    const opts = {
      msgId,
      ext: media.ext,
      buffer,
      ...(media.mimeType !== undefined ? { mimeType: media.mimeType } : {}),
    };
    if (media.kind === "audio") return store.saveAudio(opts);
    if (media.kind === "image") return store.saveImage(opts);
    return store.saveDocument(opts);
  }

  /**
   * Test seam: await every in-flight async media-download/save handler.
   * Mirrors `WhatsappChannel.flushPending` — production callers don't need
   * this because they don't observe the in-flight promises, but tests
   * need a deterministic point at which all `processInbound` calls have
   * settled before asserting on their results.
   */
  async flushPending(): Promise<void> {
    while (this.pendingHandlers.size > 0) {
      const snapshot = Array.from(this.pendingHandlers);
      await Promise.allSettled(snapshot);
    }
  }

  private track(p: Promise<unknown>): void {
    this.pendingHandlers.add(p);
    void p.finally(() => {
      this.pendingHandlers.delete(p);
    });
  }

  // -------------------------------------------------------------------------
  // Internal — error handler (bot.catch)
  // -------------------------------------------------------------------------

  /**
   * Lifted from gemini-claw `telegramBot.ts:52-67`: distinguish
   * GrammyError (Telegram API said no), HttpError (network), and unknown.
   * Non-fatal — log + continue.  Polling restart is daemon's call.
   */
  private installErrorHandler(): void {
    this.bot.catch((err) => {
      const inner = err.error;
      const updateId = err.ctx.update.update_id;

      if (inner instanceof GrammyError) {
        this.operatorLogger?.error("telegram_grammy_error", {
          update_id: updateId,
          description: inner.description,
        });
        return;
      }
      if (inner instanceof HttpError) {
        this.operatorLogger?.error("telegram_http_error", {
          update_id: updateId,
          message: inner.message,
        });
        return;
      }
      this.operatorLogger?.error("telegram_unknown_error", {
        update_id: updateId,
        message: inner instanceof Error ? inner.message : String(inner),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internal — audit-log helper
  // -------------------------------------------------------------------------

  private async audit(
    entry: Omit<AuditEntry, "ts" | "daemon_uptime_s">,
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.append(entry);
    } catch (error) {
      // Audit failures must never crash the channel.  Surface to operator.
      this.operatorLogger?.error("telegram_audit_append_error", {
        error_class: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal — ChannelEvent → user-facing text
// ---------------------------------------------------------------------------

/**
 * Map a ChannelEvent to the text we send through Telegram.
 *
 * Each event type carries a distinct prefix glyph so the user can scan a
 * busy DM and tell at a glance "is this a status ping vs. a confirm prompt
 * vs. the actual answer?".  The `reply` event has NO prefix because that
 * IS the conversation turn.
 */
export function formatChannelEvent(event: ChannelEvent): string {
  switch (event.type) {
    case "tell":
      return `📱 ${event.text}`;
    case "confirm_request":
      return [
        `❓ Confirm needed (${event.shortId}): ${event.question}`,
        `Why: ${event.rationale}`,
        `Risk: ${event.risk}`,
        ``,
        `Reply: /confirm ${event.shortId} yes  OR  /confirm ${event.shortId} no`,
      ].join("\n");
    case "auto_promote_notice":
      return `pi: still on it (~${event.taskAgeSeconds}s in) — /cancel to abort`;
    case "go_background_notice":
      return `pi: this is bigger than I thought — going async, will ping when done. (was: "${event.userMessagePreview}")`;
    case "reply":
      return event.text;
    case "task_completed":
      return `pi: ✅ done. ${event.finalMessage}`;
    case "system_notice": {
      const prefix =
        event.level === "error"
          ? "‼️"
          : event.level === "warn"
            ? "⚠️"
            : "ℹ️";
      return `${prefix} ${event.text}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal — sender-id hashing for audit
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal — bot-token redactor (INLINE TEMPORARY for v0.3 Wave 1.1)
// ---------------------------------------------------------------------------

/**
 * Strip any occurrence of the literal bot token AND the canonical
 * `<digits>:<token>` shape from a string. Defense-in-depth so grammY
 * error messages — which can carry the token embedded in
 * api.telegram.org URLs — don't end up in operator logs (Security B1).
 *
 * Two redaction passes:
 *   1. Literal substring of the install's bot token (catches the raw form).
 *   2. The Telegram-bot-token shape (`<id>:<secret>`) anywhere in the
 *      string (catches URL-embedded forms regardless of which install
 *      the token belongs to — defense if a copy/paste mishap puts another
 *      bot's token through this code path).
 *
 * TODO(IMPL-W1-G8): replace inline with `src/lib/redact.ts` import once
 * the wave-sibling implementation lands. The signatures are intentionally
 * different right now (this one takes the install's token as a leading
 * arg for the literal-substring pass) so the integration commit can do
 * a focused review of the consolidated helper.
 */
function redactBotToken(installToken: string, message: string): string {
  if (!message) return "";
  let out = message;
  // Pass 1: the install's literal token. Cheap split/join (no regex
  // escaping concerns).
  if (installToken && installToken.length >= 16) {
    out = out.split(installToken).join("[REDACTED]");
  }
  // Pass 2: any Telegram-bot-token-shaped substring.
  out = out.replace(
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    "[REDACTED]",
  );
  return out;
}

/**
 * Quick non-salted hash for inline use during request handling.  The
 * daemon's full audit pipeline (AuditLog.senderIdHash) uses a salted
 * SHA-256 with the install-salt.  We don't have access to the salt here
 * and the load-bearing privacy concern (raw jid never written to disk)
 * is satisfied either way.  When the daemon glue (IMPL-15) wires
 * everything together, it can hand the salted-hash function down through
 * `TelegramChannelOpts` and we'll prefer it.
 */
function hashSenderId(id: number | string): string {
  // Deterministic, non-reversible enough for v1 audit grouping.  We
  // intentionally keep this short (12 chars) to match the envelope hash.
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `tg-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// Internal — media-spec descriptor + payload-ref helper
// ---------------------------------------------------------------------------

/**
 * Per-message media descriptor passed from `installHandlers` down into
 * `handleInbound`.  Captures everything `dispatchInboundWithMedia` needs
 * to download + persist the file:
 *   - `kind`     decides which `InboundMediaStore.save*` method to call
 *   - `fileId`   feeds `bot.api.getFile` to get the api.telegram.org path
 *   - `ext`      becomes the on-disk suffix (`.ogg`, `.jpg`, ...).  The
 *                store sanitizes this so callers can pass raw filenames.
 *   - `mimeType` informational; threaded into the saved-ref for v2 hints
 */
interface TelegramMediaSpec {
  kind: "audio" | "image" | "document";
  fileId: string;
  ext: string;
  mimeType?: string;
}

/**
 * Stamp the saved-ref's path into the appropriate `payload.*Ref` field.
 * Centralized so both `handleInbound` and any future fan-out path (album
 * groupings, multi-attachment messages) share one source of truth for
 * the field-name convention defined in `src/channels/base.ts`.
 */
function applyRefToPayload(
  payload: InboundMessage["payload"],
  ref: InboundMediaSavedRef,
): void {
  if (ref.mediaType === "audio") {
    payload.audioRef = ref.path;
    return;
  }
  if (ref.mediaType === "image") {
    payload.imageRef = ref.path;
    return;
  }
  if (ref.mediaType === "document") {
    payload.documentRef = ref.path;
    return;
  }
  // ref.mediaType === 'video'
  payload.videoRef = ref.path;
}

/**
 * Telegram returns multiple `PhotoSize` entries per inbound photo (a
 * thumbnail tier + the full-resolution variant).  Pick the highest-res
 * one — preferring `file_size` when present, falling back to the last
 * entry which Telegram orders by ascending size per their docs.
 */
function pickLargestPhoto<
  T extends { file_id: string; file_size?: number | undefined },
>(photos: readonly T[]): T {
  if (photos.length === 0) {
    // Defensive: grammy's typing guarantees at least one entry, but we
    // assert here so a future API change can't silently propagate an
    // out-of-bounds read.
    throw new Error("telegram_photo_array_empty");
  }
  let best = photos[0]!;
  let bestSize = best.file_size ?? 0;
  for (let i = 1; i < photos.length; i++) {
    const candidate = photos[i]!;
    const size = candidate.file_size ?? 0;
    if (size >= bestSize) {
      best = candidate;
      bestSize = size;
    }
  }
  return best;
}
