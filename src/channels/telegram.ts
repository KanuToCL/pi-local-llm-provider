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
import type {
  ChannelEvent,
  InboundMessage,
  InboundProcessor,
  Sink,
} from "./base.js";
import type { AuditLog } from "../audit/log.js";
import type { AuditEntry } from "../audit/schema.js";
import type { OperatorLogger } from "../utils/operator-logger.js";

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
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 3900;
const DEFAULT_TYPING_INTERVAL_MS = 4000;

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
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly inboundProcessor: InboundProcessor;
  private readonly chunkSize: number;
  private readonly typingIntervalMs: number;
  private readonly auditLog?: AuditLog;
  private readonly operatorLogger?: OperatorLogger;
  private readonly onPoll: (() => void) | undefined;

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
    this.allowedUserIds = opts.allowedUserIds;
    this.inboundProcessor = opts.inboundProcessor;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.typingIntervalMs = opts.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;
    this.auditLog = opts.auditLog;
    this.operatorLogger = opts.operatorLogger;
    this.onPoll = opts.onPoll;

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
      this.handleInbound(ctx, "text", ctx.message.text);
    });

    this.bot.on("message:voice", (ctx) => {
      const synthetic =
        "[user sent a voice — non-text inbound is deferred; please type]";
      this.handleInbound(ctx, "voice", synthetic);
    });

    this.bot.on("message:photo", (ctx) => {
      const synthetic =
        "[user sent an image — non-text inbound is deferred; please type]";
      this.handleInbound(ctx, "image", synthetic);
    });

    this.bot.on("message:document", (ctx) => {
      const synthetic =
        "[user sent a document — non-text inbound is deferred; please type]";
      this.handleInbound(ctx, "document", synthetic);
    });
  }

  private handleInbound(
    ctx: Context,
    originalKind: "text" | "voice" | "image" | "document",
    bodyText: string,
  ): void {
    const senderId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (senderId === undefined || chatId === undefined) return;

    // Track the originating chat for outbound replies + typing.
    this.activeChatId = chatId;

    const senderName =
      ctx.from?.username ?? ctx.from?.first_name ?? undefined;

    const msg: InboundMessage = {
      type: originalKind === "document" ? "image" : originalKind, // documents collapse to "image" in the v1 inbound enum
      channel: "telegram",
      sender: { id: String(senderId), name: senderName },
      payload: { text: bodyText },
      ts: Date.now(),
    };

    // Operator-side log of the inbound — the audit-event vocabulary
    // (src/audit/schema.ts) does not yet include a dedicated `inbound_received`
    // kind; the daemon (IMPL-13/15) emits `task_started` when it picks the
    // message up, which is the canonical audit point.  Operator-logger keeps
    // local visibility either way.
    this.operatorLogger?.debug("telegram_inbound", {
      message_type: originalKind,
      sender_id_hash: hashSenderId(senderId),
    });

    // Fire-and-forget — the bot must keep polling.  Errors in the
    // processor surface as audit entries inside the daemon, NOT here.
    void this.inboundProcessor.processInbound(msg).catch((error) => {
      this.operatorLogger?.error("telegram_inbound_processor_error", {
        error_class: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
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
