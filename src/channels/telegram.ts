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
import type { AuditEntry } from "../audit/schema.js";
import type { InboundRateLimiter } from "../lib/inbound-rate-limit.js";
import type { OperatorLogger } from "../utils/operator-logger.js";

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
  private readonly bot: Bot;
  private readonly botToken: string;
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
    this.bot = opts.botFactory
      ? opts.botFactory(opts.botToken)
      : new Bot(opts.botToken);
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
      this.operatorLogger?.error("telegram_polling_error", {
        error_class: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
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
    // First middleware: heartbeat-touch on EVERY inbound update.  Per
    // Heartbeat invariant, this fires regardless of whether the update is
    // ultimately admitted (DM-only / allowlist filters happen later).  The
    // poll itself succeeded so the long-poll liveness is real.
    this.bot.use(async (_ctx, next) => {
      try {
        this.onPoll?.();
      } catch {
        /* heartbeat is best-effort; never break the bot loop */
      }
      await next();
    });

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
          sender_id_hash: hashSenderId(senderId),
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
          sender_id_hash: senderId !== undefined ? hashSenderId(senderId) : null,
          extra: { chat_type: chatType ?? "unknown" },
        });
        return; // silent
      }

      if (senderId === undefined || !this.allowedUserIds.has(String(senderId))) {
        await this.audit({
          event: "allowlist_reject",
          task_id: null,
          channel: "telegram",
          sender_id_hash: senderId !== undefined ? hashSenderId(senderId) : null,
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

    // Operator-side log of the inbound — the audit-event vocabulary
    // (src/audit/schema.ts) does not yet include a dedicated `inbound_received`
    // kind; the daemon (IMPL-13/15) emits `task_started` when it picks the
    // message up, which is the canonical audit point.  Operator-logger keeps
    // local visibility either way.
    this.operatorLogger?.debug("telegram_inbound", {
      message_type: originalKind,
      sender_id_hash: hashSenderId(senderId),
    });

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
