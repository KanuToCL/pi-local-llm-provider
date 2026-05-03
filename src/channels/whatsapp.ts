/**
 * WhatsApp channel — Baileys (`@whiskeysockets/baileys@^7`) adapter.
 *
 * Plan refs:
 *   - §"v4.3 Phase 5 — WhatsApp must support both identity models" (lines
 *     1586-1611): Phase 5 ships with TWO configurations selectable at runtime.
 *       Model A — self-chat with owner's number (Baileys pairs WITH owner;
 *         allowlist matches owner JID; messages land in WhatsApp's "Self" thread).
 *       Model B — second number for pi (recommended).  Baileys pairs with
 *         botJid; allowlist matches ownerJid; outbound goes to ownerJid.
 *   - §"v4.3 Phase 5 honesty disclosures" (lines 1620-1624): Model A risks
 *     pi sharing your WhatsApp identity; Model B incurs ban risk on the bot
 *     account; both require a re-pair flow when Baileys creds invalidate.
 *   - §"Pitfall #1" (line 753): Baileys auth state goes stale → daemon
 *     surfaces `whatsapp_reauth_needed` and stops auto-reconnecting until
 *     Sergio runs `scripts/pair-whatsapp.ts` again.
 *   - §"v4 changelog Promoted V5-C" (lines 1541, 1628): branch reconnect on
 *     disconnect REASON CODE.  `loggedOut` → degraded immediate (manual
 *     re-pair); `restartRequired` → 1 retry then degraded; `connectionLost`/
 *     `connectionClosed`/`timedOut` → exponential backoff `60s → 120s → 240s
 *     → 480s → 960s → cap 30min` with ±20% jitter; after 10 consecutive
 *     failures the channel enters `whatsapp_degraded` terminal state.
 *   - §"v4 changelog Accessibility — voice-arrival policy" + Pitfall #21
 *     (line 1261): non-text inbound (voice / image / document) gets
 *     synthesized into a textual placeholder for v1; the audioRef/imageRef
 *     seam is preserved for v2 vision/whisper integration.
 *   - §"Testing Elder silent-vs-polite reject" (line 1342): SILENT-reject
 *     for both DM-only violations AND allowlist violations (do not ack
 *     non-allowlisted senders — gives no signal to scanners).
 *   - §"Testing Elder Baileys mock layer" (line 1340): mock at the `sock.ev`
 *     event-emitter substitution layer; tests construct an in-memory
 *     EventEmitter and feed synthetic `messages.upsert` /
 *     `connection.update` events.
 *
 * Type opacity:
 *   Baileys is in `optionalDependencies`.  Like `src/lib/sdk-shim.ts`, we
 *   dynamic-import behind `loadBaileys()` and surface a stable
 *   `BaileysNotInstalledError` so the daemon (IMPL-16) can short-circuit
 *   with a clear diagnostic on machines where the optional dep is absent
 *   (typical: macOS dev machines without WhatsApp deployment intent).
 *   We do NOT statically import any types from `@whiskeysockets/baileys`;
 *   all Baileys-shaped values are typed as `unknown` and narrowed at the
 *   boundary.  This keeps `tsc --noEmit` clean even when the Baileys
 *   ambient types resolve to `any` (no install) or to their real shape
 *   (full install).  Tests rely on this opacity — they don't need to
 *   import Baileys at all; they construct a synthetic `sock`-shaped object.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";

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
 * Thrown when `@whiskeysockets/baileys` cannot be imported (typical:
 * missing optional dependency on a dev machine).  Stable `.name` so the
 * daemon can `catch`-by-name across module boundaries.
 */
export class BaileysNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaileysNotInstalledError";
  }
}

// ---------------------------------------------------------------------------
// Identity model + options
// ---------------------------------------------------------------------------

/**
 * Per plan §"v4.3 Phase 5 — WhatsApp must support both identity models":
 *   - 'self-chat'      — Baileys pairs with the owner's number; the owner
 *                        messages himself in WhatsApp's "Self" thread; pi
 *                        sees those as inbound and replies into the same
 *                        thread.  Allowlist = ownerJid.
 *   - 'second-number'  — Baileys pairs with a SEPARATE bot number; the
 *                        owner DMs the bot from his primary account; pi
 *                        replies as the bot.  Allowlist = ownerJid.
 */
export type WhatsappIdentityModel = "self-chat" | "second-number";

export interface WhatsappChannelOpts {
  /** Which identity model the operator picked (see WhatsappIdentityModel). */
  identityModel: WhatsappIdentityModel;
  /**
   * The owner's WhatsApp JID — always Sergio's number; always in allowlist.
   * In Model A, this is ALSO the JID Baileys is paired with.
   */
  ownerJid: string;
  /**
   * Model B only — the JID of the dedicated bot account (whichever number
   * Baileys is paired with).  Unused in Model A.  Provided so we can sanity
   * check at boot that we're paired with the right account, and so future
   * code can route differently if needed.
   */
  botJid?: string;
  /**
   * Directory holding Baileys multi-file auth state.  Default
   * `~/.pi-comms/wa-auth/`.  Created at mode 0700; warns if non-Unix
   * filesystem semantics prevent the chmod.
   */
  authStateDir: string;
  /** Daemon-side glue that processes a normalized InboundMessage. */
  inboundProcessor: InboundProcessor;
  /**
   * Outbound chunk size.  WhatsApp accepts ~65k characters per message but
   * Baileys recommends staying conservative; default 4096 leaves headroom
   * for prefix glyphs and matches the Telegram default ergonomics.
   */
  chunkSize?: number;
  /** Audit-log writer (optional in tests; required in production daemon). */
  auditLog?: AuditLog;
  /** Operator-side console logger (optional). */
  operatorLogger?: OperatorLogger;
  /**
   * Optional injection point for a pre-constructed Baileys-shaped socket
   * (used by tests to avoid hitting the real WhatsApp Web servers).  When
   * omitted, we dynamic-import @whiskeysockets/baileys and call
   * makeWASocket().
   */
  socketFactory?: WhatsappSocketFactory;
  /**
   * Optional clock injection for backoff-schedule tests.  Defaults to
   * `setTimeout`/`Date.now`.  Tests pass fake timers (vi.useFakeTimers).
   */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Optional jitter override for tests — when provided, replaces the
   * ±20% multiplier with a deterministic value so backoff intervals are
   * exact.  Default: `() => 1 + (Math.random() * 0.4 - 0.2)` (i.e.
   * uniformly distributed on [0.8, 1.2]).
   */
  jitterFn?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults + reason-code branching schedule (V5-C)
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 4096;

/**
 * Per V5-C and §"Phase 4.5 backoff schedule" (line 1156): exponential
 * sequence in seconds.  After the 5th failure we cap at 30 minutes
 * (1800s) and stay there until either we succeed or hit the 10-failure
 * terminal-degraded threshold.
 */
const BACKOFF_SCHEDULE_SECONDS: readonly number[] = [60, 120, 240, 480, 960, 1800];

/**
 * Per V5-C: ±20% jitter applied to every backoff interval.  Returns a
 * multiplier uniformly distributed on [0.8, 1.2].
 */
function defaultJitter(): number {
  return 1 + (Math.random() * 0.4 - 0.2);
}

const MAX_CONSECUTIVE_FAILURES = 10;

// ---------------------------------------------------------------------------
// Reason-code branching enum (mirrors Baileys DisconnectReason values)
// ---------------------------------------------------------------------------

/**
 * Subset of Baileys' `DisconnectReason` enum we branch on (see
 * `node_modules/@whiskeysockets/baileys/lib/Types/index.js:13-25`).  We
 * keep our own const-numeric mirror so the type doesn't depend on the
 * optional Baileys import — the daemon can compile and tests can run
 * even when Baileys is absent.
 *
 * Values are HTTP status codes Baileys overloads to mean WhatsApp-Web
 * disconnect reasons.
 */
export const WhatsappDisconnectReason = {
  loggedOut: 401,
  restartRequired: 515,
  connectionLost: 408,
  connectionClosed: 428,
  timedOut: 408, // alias for connectionLost in Baileys' enum
  badSession: 500,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
  connectionReplaced: 440,
} as const;

// ---------------------------------------------------------------------------
// Loader for the optional Baileys dependency
// ---------------------------------------------------------------------------

/**
 * Minimal slice of the Baileys export surface we rely on.  Defined as
 * `unknown`-returning so a missing-types resolution doesn't drag `any`
 * through our public API.
 */
export interface BaileysLoaded {
  makeWASocket: (opts: Record<string, unknown>) => WhatsappSocket;
  useMultiFileAuthState: (folder: string) => Promise<{
    state: unknown;
    saveCreds: () => Promise<void>;
  }>;
  /** May be undefined on older builds; we no-op if absent. */
  makeCacheableSignalKeyStore?:
    | ((store: unknown, logger?: unknown, cache?: unknown) => unknown)
    | undefined;
}

/**
 * The minimal `sock` shape we exercise.  Tests construct a synthetic
 * implementation; production uses whatever `makeWASocket()` returns.
 */
export interface WhatsappSocket {
  ev: {
    on(event: string, listener: (arg: unknown) => void): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  end?: (error?: Error) => void;
  logout?: () => Promise<void>;
}

/**
 * Test-injectable factory for a Baileys socket.  When omitted we
 * dynamic-import Baileys and call makeWASocket(authStateDir).
 */
export type WhatsappSocketFactory = (params: {
  authStateDir: string;
  /**
   * The auth state we get back from `useMultiFileAuthState`.  Tests pass
   * `undefined`; production passes the real auth state.
   */
  authState?: unknown;
  saveCreds?: () => Promise<void>;
}) => Promise<WhatsappSocket>;

/**
 * Dynamic-import Baileys and surface a stable error class on absence.
 * Mirrors the pattern in `src/lib/sdk-shim.ts:loadSdk`.
 */
export async function loadBaileys(): Promise<BaileysLoaded> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("@whiskeysockets/baileys")) as Record<string, unknown>;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new BaileysNotInstalledError(
      `@whiskeysockets/baileys is not installed (${cause}). ` +
        "Install via `npm install @whiskeysockets/baileys@7.0.0-rc.9` if " +
        "you intend to use the WhatsApp channel; otherwise omit it from " +
        "PI_COMMS_CHANNELS in your .env.",
    );
  }

  // Baileys exports `makeWASocket` as a default export and as a named
  // re-export.  Prefer the default; fall back to named.
  const candidate = (mod.default ?? mod.makeWASocket) as unknown;
  if (typeof candidate !== "function") {
    throw new BaileysNotInstalledError(
      "@whiskeysockets/baileys loaded but `makeWASocket` is not a function. " +
        "SDK shape may have changed; pin to 7.0.0-rc.9 per package.json.",
    );
  }

  const useMultiFileAuthState = mod.useMultiFileAuthState as unknown;
  if (typeof useMultiFileAuthState !== "function") {
    throw new BaileysNotInstalledError(
      "@whiskeysockets/baileys loaded but `useMultiFileAuthState` is not a function.",
    );
  }

  return {
    makeWASocket: candidate as BaileysLoaded["makeWASocket"],
    useMultiFileAuthState:
      useMultiFileAuthState as BaileysLoaded["useMultiFileAuthState"],
    makeCacheableSignalKeyStore: mod.makeCacheableSignalKeyStore as
      | BaileysLoaded["makeCacheableSignalKeyStore"]
      | undefined,
  };
}

// ---------------------------------------------------------------------------
// WhatsappChannel
// ---------------------------------------------------------------------------

/**
 * One Baileys-backed WhatsApp connection, one identity model, one allowlist,
 * one inbound processor.
 *
 * Inbound flow:
 *   sock.ev.on('messages.upsert', { messages, type })
 *     → for each msg: if remoteJid ends with '@g.us' → silent reject + audit
 *                     if sender is not the allowed JID → silent reject + audit
 *                     extract content (text / voice / image / document)
 *                     synthesize textual placeholder for non-text per Pitfall #21
 *                     build InboundMessage and call processInbound (fire-and-forget)
 *
 * Outbound flow:
 *   send(event)
 *     → format via formatChannelEvent (mirrors TelegramChannel)
 *     → chunkOutbound by chunkSize
 *     → sock.sendMessage(targetJid, { text: chunk })
 *
 *   In Model A, targetJid == ownerJid (which is also our paired account, so
 *   the message lands in WhatsApp's "Self" thread).  In Model B, targetJid
 *   == ownerJid (the owner's primary number).  In BOTH models the dispatch
 *   is identical; the difference is which account Baileys is paired with.
 *
 * Lifecycle:
 *   start():
 *     1. Ensure authStateDir exists at mode 0700.
 *     2. Resolve socketFactory (test-injected) or dynamic-import Baileys
 *        and call useMultiFileAuthState + makeWASocket.
 *     3. Wire `connection.update` and `messages.upsert` listeners.
 *     4. Resolve immediately — connection establishment is async via the
 *        listener.  `connection.update { connection: 'open' }` flips
 *        `connected = true` and emits `whatsapp_connect` audit.
 *
 *   stop():
 *     Cancel any pending reconnect timer, call `sock.end?.()` if available,
 *     emit `whatsapp_disconnect` audit, mark connected = false.
 *
 * Reason-code-aware reconnect (V5-C):
 *   On `connection: 'close'` we read `lastDisconnect.error.output.statusCode`
 *   (see Baileys docs; `Boom` errors carry a `.output.statusCode`).  Branch:
 *     - loggedOut          → no auto-reconnect; emit `whatsapp_reauth_needed`
 *                            audit; transition to terminal-degraded state.
 *     - restartRequired    → 1 retry attempt, then if that also fails treat
 *                            as connectionLost.
 *     - connectionLost / connectionClosed / timedOut / badSession /
 *       unavailableService / multideviceMismatch / forbidden / undefined →
 *       schedule next backoff per BACKOFF_SCHEDULE_SECONDS with ±20% jitter.
 *     - >= MAX_CONSECUTIVE_FAILURES (10) → terminal degraded state.
 */
export class WhatsappChannel implements Sink {
  private readonly identityModel: WhatsappIdentityModel;
  private readonly ownerJid: string;
  private readonly botJid: string | undefined;
  private readonly authStateDir: string;
  private readonly inboundProcessor: InboundProcessor;
  private readonly chunkSize: number;
  private readonly auditLog: AuditLog | undefined;
  private readonly operatorLogger: OperatorLogger | undefined;
  private readonly socketFactory: WhatsappSocketFactory | undefined;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly jitterFn: () => number;

  private sock: WhatsappSocket | null = null;
  private connected = false;
  /**
   * Number of consecutive backoff-eligible failures (loggedOut and
   * intentional `stop()` do NOT increment this).  Hits MAX → terminal
   * degraded state.
   */
  private failureCount = 0;
  private degraded = false;
  /**
   * Number of `restartRequired` retries already attempted in the current
   * failure streak.  We allow exactly one before treating the next
   * failure as a generic connectionLost.
   */
  private restartRetries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set to true between `stop()` and any subsequent `start()` so the
   * connection.update handler doesn't kick off a reconnect after an
   * intentional shutdown.
   */
  private intentionalStop = false;
  /**
   * Tracks in-flight handler promises spawned from `sock.ev` callbacks
   * (which fire-and-forget).  Tests use `flushPending()` to await them
   * deterministically without relying on tick-counting.
   */
  private readonly pendingHandlers: Set<Promise<unknown>> = new Set();

  constructor(opts: WhatsappChannelOpts) {
    this.identityModel = opts.identityModel;
    this.ownerJid = opts.ownerJid;
    this.botJid = opts.botJid;
    this.authStateDir = opts.authStateDir;
    this.inboundProcessor = opts.inboundProcessor;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.auditLog = opts.auditLog;
    this.operatorLogger = opts.operatorLogger;
    this.socketFactory = opts.socketFactory;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.jitterFn = opts.jitterFn ?? defaultJitter;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.intentionalStop = false;

    if (this.degraded) {
      // Once a terminal-degraded state is reached the operator MUST run
      // `scripts/pair-whatsapp.ts` again; calling start() in this state
      // is a no-op until the channel is reconstructed.
      this.operatorLogger?.error("whatsapp_start_skipped_degraded", {
        identity_model: this.identityModel,
      });
      return;
    }

    await this.ensureAuthDir();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.cancelReconnectTimer();
    if (this.sock) {
      try {
        this.sock.end?.(undefined);
      } catch {
        // best-effort
      }
    }
    if (this.connected) {
      this.connected = false;
      await this.audit({
        event: "whatsapp_disconnect",
        task_id: null,
        channel: "whatsapp",
        sender_id_hash: null,
      });
    }
    this.sock = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * True once the channel has hit the 10-consecutive-failure terminal
   * degraded state (operator must re-run `scripts/pair-whatsapp.ts`).
   * Exposed for `/status` slash command + dead-man-switch surfacing.
   */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Await every in-flight `sock.ev` handler promise.  Test-only seam: the
   * production `connection.update` / `messages.upsert` listeners are
   * fire-and-forget by design (the Baileys event-emitter callback signature
   * is sync), but tests need a deterministic point at which all audit
   * appends + state transitions have settled.  Production callers don't
   * need this — they don't observe the in-flight promises.
   */
  async flushPending(): Promise<void> {
    while (this.pendingHandlers.size > 0) {
      const snapshot = Array.from(this.pendingHandlers);
      await Promise.allSettled(snapshot);
    }
  }

  // -------------------------------------------------------------------------
  // Sink — outbound
  // -------------------------------------------------------------------------

  async send(event: ChannelEvent): Promise<void> {
    if (!this.connected || !this.sock) {
      // Per Sink semantics: best-effort, resolve silently when transport
      // is unavailable.  The caller (tools fan-out) must tolerate this.
      return;
    }

    const text = formatChannelEvent(event);
    if (!text) return;

    const targetJid = this.outboundJid();
    const chunks = chunkOutbound(text, this.chunkSize);
    for (const chunk of chunks) {
      try {
        await this.sock.sendMessage(targetJid, { text: chunk });
      } catch (error) {
        this.operatorLogger?.error("whatsapp_send_error", {
          error_class: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal — auth-dir setup
  // -------------------------------------------------------------------------

  private async ensureAuthDir(): Promise<void> {
    await mkdir(this.authStateDir, { recursive: true });
    try {
      await chmod(this.authStateDir, 0o700);
    } catch (error) {
      // Windows / FAT / non-Unix filesystems can fail chmod.  Warn but
      // continue — the daemon's threat model on Windows already requires
      // operator-controlled %APPDATA% perms.
      this.operatorLogger?.error("whatsapp_authdir_chmod_warn", {
        path: this.authStateDir,
        error_class: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal — connect (resolve socket, wire listeners)
  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    let sock: WhatsappSocket;
    if (this.socketFactory) {
      sock = await this.socketFactory({ authStateDir: this.authStateDir });
    } else {
      sock = await this.connectViaBaileys();
    }
    this.sock = sock;
    this.installListeners(sock);
  }

  private async connectViaBaileys(): Promise<WhatsappSocket> {
    const baileys = await loadBaileys();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(
      this.authStateDir,
    );

    // Wire makeCacheableSignalKeyStore if it's available; some older
    // 7.x builds don't expose it.  Pure perf optimization, safe to skip.
    let auth: unknown = state;
    const stateRecord = state as Record<string, unknown> | null;
    if (
      baileys.makeCacheableSignalKeyStore &&
      stateRecord &&
      typeof stateRecord === "object" &&
      "keys" in stateRecord
    ) {
      try {
        const cachedKeys = baileys.makeCacheableSignalKeyStore(
          stateRecord.keys,
        );
        auth = { ...stateRecord, keys: cachedKeys };
      } catch {
        // fallback to uncached state
      }
    }

    const sock = baileys.makeWASocket({
      auth,
      // We render our own QR via scripts/pair-whatsapp.ts; avoid Baileys'
      // built-in printer so we don't double-print and so the daemon's
      // operator log stays clean during normal operation.
      printQRInTerminal: false,
      browser: ["pi-comms", "Desktop", "0.2.0"],
    });

    // Persist creds whenever Baileys updates them (token refresh,
    // re-pair, etc.).  Per Pitfall #1: stale auth is the #1 reason the
    // daemon goes silent; auto-saving keeps the on-disk state current.
    sock.ev.on("creds.update", () => {
      void saveCreds().catch((error: unknown) => {
        this.operatorLogger?.error("whatsapp_save_creds_error", {
          error_class: error instanceof Error ? error.name : "unknown",
        });
      });
    });

    return sock;
  }

  private installListeners(sock: WhatsappSocket): void {
    sock.ev.on("connection.update", (update) => {
      this.track(
        this.onConnectionUpdate(update).catch((error) => {
          this.operatorLogger?.error("whatsapp_connection_update_error", {
            error_class: error instanceof Error ? error.name : "unknown",
          });
        }),
      );
    });

    sock.ev.on("messages.upsert", (event) => {
      this.track(
        this.onMessagesUpsert(event).catch((error) => {
          this.operatorLogger?.error("whatsapp_messages_upsert_error", {
            error_class: error instanceof Error ? error.name : "unknown",
          });
        }),
      );
    });
  }

  /**
   * Register a fire-and-forget handler promise so `flushPending()` (test
   * seam) can await it.  No-op behavior for production callers — the
   * promise self-removes from the set on settle.
   */
  private track(p: Promise<unknown>): void {
    this.pendingHandlers.add(p);
    void p.finally(() => {
      this.pendingHandlers.delete(p);
    });
  }

  // -------------------------------------------------------------------------
  // Internal — connection.update handler (V5-C reason-code branching)
  // -------------------------------------------------------------------------

  private async onConnectionUpdate(update: unknown): Promise<void> {
    if (!update || typeof update !== "object") return;
    const u = update as { connection?: string; lastDisconnect?: unknown };

    if (u.connection === "open") {
      this.connected = true;
      // Successful connection resets the failure streak so a future
      // outage starts the backoff schedule from the beginning.
      this.failureCount = 0;
      this.restartRetries = 0;
      await this.audit({
        event: "whatsapp_connect",
        task_id: null,
        channel: "whatsapp",
        sender_id_hash: null,
        extra: { identity_model: this.identityModel },
      });
      this.operatorLogger?.info("whatsapp_connect", {
        identity_model: this.identityModel,
      });
      return;
    }

    if (u.connection === "close") {
      this.connected = false;
      const reason = extractDisconnectReason(u.lastDisconnect);
      await this.handleDisconnect(reason);
      return;
    }

    // 'connecting' and other transient states: nothing to do.
  }

  private async handleDisconnect(reasonCode: number | undefined): Promise<void> {
    if (this.intentionalStop) {
      // Caller asked us to stop; don't emit reconnect machinery.
      return;
    }

    if (reasonCode === WhatsappDisconnectReason.loggedOut) {
      // Per Pitfall #1 + V5-C: do NOT auto-reconnect.  Operator must
      // re-pair via scripts/pair-whatsapp.ts.  We surface the audit
      // event the dead-man switch + /status command read.
      await this.audit({
        event: "whatsapp_reauth_needed",
        task_id: null,
        channel: "whatsapp",
        sender_id_hash: null,
        extra: {
          identity_model: this.identityModel,
          reason: "logged_out",
        },
      });
      this.operatorLogger?.error("whatsapp_reauth_needed", {
        identity_model: this.identityModel,
      });
      this.degraded = true;
      return;
    }

    if (reasonCode === WhatsappDisconnectReason.restartRequired) {
      // Per V5-C: 1 retry then degraded.  Don't increment failureCount
      // for the first restart-required since restartRequired is an
      // expected lifecycle event (Baileys requesting a reconnect).
      if (this.restartRetries === 0) {
        this.restartRetries += 1;
        this.operatorLogger?.info("whatsapp_restart_required_retry", {
          attempt: 1,
        });
        // Reconnect immediately (no backoff for the first retry).
        this.scheduleReconnect(0);
        return;
      }
      // restartRequired fired again right after our retry — fall
      // through into the generic backoff path.
    }

    // Generic backoff path (connectionLost / connectionClosed / badSession /
    // unavailable / unknown / restart-after-retry).
    this.failureCount += 1;
    if (this.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      await this.audit({
        event: "whatsapp_disconnect",
        task_id: null,
        channel: "whatsapp",
        sender_id_hash: null,
        extra: {
          identity_model: this.identityModel,
          reason: "terminal_degraded",
          failure_count: this.failureCount,
          last_reason_code: reasonCode ?? -1,
        },
      });
      this.operatorLogger?.error("whatsapp_terminal_degraded", {
        failure_count: this.failureCount,
        last_reason_code: reasonCode ?? -1,
      });
      this.degraded = true;
      return;
    }

    const baseSeconds = this.nextBackoffBaseSeconds();
    const jittered = baseSeconds * this.jitterFn();
    const delayMs = Math.max(0, Math.round(jittered * 1000));

    await this.audit({
      event: "whatsapp_disconnect",
      task_id: null,
      channel: "whatsapp",
      sender_id_hash: null,
      extra: {
        identity_model: this.identityModel,
        reason: "transient",
        failure_count: this.failureCount,
        last_reason_code: reasonCode ?? -1,
        retry_in_ms: delayMs,
      },
    });
    this.operatorLogger?.info("whatsapp_disconnect_backoff", {
      failure_count: this.failureCount,
      retry_in_ms: delayMs,
    });

    this.scheduleReconnect(delayMs);
  }

  private nextBackoffBaseSeconds(): number {
    const idx = Math.min(this.failureCount - 1, BACKOFF_SCHEDULE_SECONDS.length - 1);
    return BACKOFF_SCHEDULE_SECONDS[idx]!;
  }

  private scheduleReconnect(delayMs: number): void {
    this.cancelReconnectTimer();
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.operatorLogger?.error("whatsapp_reconnect_error", {
          error_class: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
        // Treat reconnect failures the same as a generic close — escalate
        // through the failure-count machinery.
        void this.handleDisconnect(undefined).catch(() => undefined);
      });
    }, delayMs);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal — messages.upsert handler
  // -------------------------------------------------------------------------

  private async onMessagesUpsert(event: unknown): Promise<void> {
    if (!event || typeof event !== "object") return;
    const e = event as { messages?: unknown; type?: string };
    if (!Array.isArray(e.messages)) return;

    for (const raw of e.messages) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;

      // Ignore messages we ourselves sent.  Baileys delivers these too;
      // without this guard our own outbound `tell()` would loop back as
      // inbound and re-trigger the agent.
      const key = msg.key as { fromMe?: boolean; remoteJid?: string; participant?: string } | undefined;
      if (!key || typeof key !== "object") continue;
      if (key.fromMe === true && this.identityModel !== "self-chat") {
        // In Model B, fromMe means Baileys (the bot) sent it.  Skip.
        continue;
      }

      const remoteJid = key.remoteJid;
      if (typeof remoteJid !== "string" || remoteJid.length === 0) continue;

      // DM-only filter: WhatsApp groups have JIDs ending in `@g.us`.
      if (remoteJid.endsWith("@g.us")) {
        await this.audit({
          event: "dm_only_reject",
          task_id: null,
          channel: "whatsapp",
          sender_id_hash: hashJid(remoteJid),
          extra: { reason: "group_chat" },
        });
        continue;
      }

      // The "sender" in WhatsApp's model:
      //   - In a 1:1 DM, the sender is `remoteJid` (or `key.participant`
      //     in some message variants; we prefer participant when present).
      //   - In Model A self-chat, the sender == ownerJid AND fromMe is
      //     true (you ARE both sides of the conversation).
      const senderJid =
        (key.participant && key.participant.length > 0
          ? key.participant
          : remoteJid) ?? remoteJid;

      if (!this.isAllowedSender(senderJid, key.fromMe === true)) {
        await this.audit({
          event: "allowlist_reject",
          task_id: null,
          channel: "whatsapp",
          sender_id_hash: hashJid(senderJid),
          extra: { identity_model: this.identityModel },
        });
        continue;
      }

      const inbound = this.normalizeInbound(msg, senderJid);
      if (!inbound) continue;

      this.operatorLogger?.debug("whatsapp_inbound", {
        message_type: inbound.type,
        sender_id_hash: hashJid(senderJid),
      });

      // Fire-and-forget.  Errors surface via the daemon's audit pipeline,
      // not here.
      void this.inboundProcessor.processInbound(inbound).catch((error) => {
        this.operatorLogger?.error("whatsapp_inbound_processor_error", {
          error_class: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal — allowlist semantics per identity model
  // -------------------------------------------------------------------------

  /**
   * Per plan §"v4.3 Phase 5 — both models":
   *   - Model A (self-chat): Baileys is paired with ownerJid.  Sergio
   *     messages himself in WhatsApp's "Self" thread.  Inbound messages
   *     have remoteJid == ownerJid AND fromMe == true.  We accept those.
   *   - Model B (second-number): Baileys is paired with botJid.  Sergio
   *     messages the bot from his primary account (ownerJid).  Inbound
   *     messages have remoteJid == ownerJid AND fromMe == false.
   */
  private isAllowedSender(senderJid: string, fromMe: boolean): boolean {
    if (this.identityModel === "self-chat") {
      return senderJid === this.ownerJid && fromMe === true;
    }
    // second-number
    return senderJid === this.ownerJid && fromMe === false;
  }

  // -------------------------------------------------------------------------
  // Internal — outbound JID per identity model
  // -------------------------------------------------------------------------

  /**
   * Where we send replies.  In BOTH models the destination is ownerJid:
   *   - Model A: ownerJid is also our paired account, so the message
   *     lands in WhatsApp's "Self" thread (a special chat where you can
   *     send messages to yourself).
   *   - Model B: ownerJid is the user's primary number; we (paired as
   *     botJid) send a normal DM to them.
   */
  private outboundJid(): string {
    return this.ownerJid;
  }

  // -------------------------------------------------------------------------
  // Internal — message normalization
  // -------------------------------------------------------------------------

  /**
   * Normalize a Baileys WAMessage into our InboundMessage shape.
   *
   * Per Pitfall #21 (line 1261): voice / image / document / video collapse
   * to a synthesized text placeholder for v1.  The audioRef/imageRef
   * filesystem seam is reserved for v2 (whisper.cpp / vision); v1 channels
   * do NOT download media — that would explode the security surface.
   */
  private normalizeInbound(
    msg: Record<string, unknown>,
    senderJid: string,
  ): InboundMessage | null {
    const message = msg.message as Record<string, unknown> | null | undefined;
    if (!message || typeof message !== "object") return null;

    // Plain text message (the 99% case).  WhatsApp wraps it as either
    // `conversation` (simple text) or `extendedTextMessage` (text with
    // a quote / link preview / mention).
    if (typeof message.conversation === "string") {
      return this.buildInbound(senderJid, "text", message.conversation);
    }
    const extended = message.extendedTextMessage as
      | { text?: string }
      | undefined;
    if (extended && typeof extended.text === "string") {
      return this.buildInbound(senderJid, "text", extended.text);
    }

    // Voice note (PTT).  Baileys exposes `audioMessage.ptt = true` for
    // voice notes; non-PTT audioMessage is regular audio attachment.
    const audioMessage = message.audioMessage as
      | { ptt?: boolean }
      | undefined;
    if (audioMessage) {
      const synthetic =
        "[user sent a voice — voice support is deferred to v2; please type]";
      return this.buildInbound(senderJid, "voice", synthetic);
    }

    if (message.imageMessage) {
      const synthetic =
        "[user sent an image — image support is deferred to v2; please type]";
      return this.buildInbound(senderJid, "image", synthetic);
    }

    if (message.documentMessage) {
      const synthetic =
        "[user sent a document — document support is deferred to v2; please type]";
      // Documents collapse to "image" in the v1 InboundMessage type
      // enum (only text / voice / image are defined — see
      // src/channels/base.ts:60).
      return this.buildInbound(senderJid, "image", synthetic);
    }

    if (message.videoMessage || message.stickerMessage) {
      const kind = message.videoMessage ? "video" : "sticker";
      const synthetic = `[user sent a ${kind} — non-text inbound is deferred; please type]`;
      return this.buildInbound(senderJid, "image", synthetic);
    }

    // Unknown WhatsApp message kind (poll, contact, location, ...).  Drop
    // silently — the operator log captures it via the upper-handler debug.
    return null;
  }

  private buildInbound(
    senderJid: string,
    type: InboundMessage["type"],
    text: string,
  ): InboundMessage {
    return {
      type,
      channel: "whatsapp",
      sender: { id: senderJid },
      payload: { text },
      ts: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Internal — audit-log helper (mirrors TelegramChannel)
  // -------------------------------------------------------------------------

  private async audit(
    entry: Omit<AuditEntry, "ts" | "daemon_uptime_s">,
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.append(entry);
    } catch (error) {
      this.operatorLogger?.error("whatsapp_audit_append_error", {
        error_class: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — disconnect-reason extraction
// ---------------------------------------------------------------------------

/**
 * Pull `output.statusCode` off a Baileys `Boom` error tucked inside
 * `lastDisconnect`.  Returns `undefined` if any field is missing —
 * generic backoff applies.
 */
function extractDisconnectReason(
  lastDisconnect: unknown,
): number | undefined {
  if (!lastDisconnect || typeof lastDisconnect !== "object") return undefined;
  const d = lastDisconnect as { error?: unknown };
  const error = d.error;
  if (!error || typeof error !== "object") return undefined;
  // Boom errors put statusCode at error.output.statusCode.  Some plain
  // Errors set `statusCode` directly (older Baileys versions) — accept both.
  const e = error as { output?: { statusCode?: number }; statusCode?: number };
  return e.output?.statusCode ?? e.statusCode;
}

// ---------------------------------------------------------------------------
// formatChannelEvent — mirrors TelegramChannel's prefix conventions
// ---------------------------------------------------------------------------

/**
 * Map a ChannelEvent to user-facing WhatsApp text.  Identical prefix
 * vocabulary to TelegramChannel so an operator switching between the two
 * channels sees a consistent UI.
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
// JID hashing for audit (mirrors TelegramChannel hashSenderId)
// ---------------------------------------------------------------------------

/**
 * Quick non-salted hash for inline use during message handling.  See
 * `src/channels/telegram.ts:hashSenderId` for the rationale — the
 * production daemon (IMPL-15/16) wires the salted hash via dependency
 * injection.  v1 audit grouping is satisfied either way; the load-bearing
 * privacy invariant ("raw jid never written to disk") is satisfied
 * because nothing here writes raw jids — only the truncated hash.
 */
function hashJid(jid: string): string {
  let h = 0;
  for (let i = 0; i < jid.length; i++) {
    h = (h * 31 + jid.charCodeAt(i)) | 0;
  }
  return `wa-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * `pair-whatsapp.ts` writes a tiny JSON record so the daemon can sanity
 * check that the auth state matches the configured identity model.  This
 * helper exposes the canonical filename so both the script and the
 * channel agree on it.
 */
export const PAIR_RECORD_FILENAME = "pi-comms-pair.json";

/**
 * Atomic-ish writer for the pair record (same shape as written by
 * `scripts/pair-whatsapp.ts` on successful pairing).  Exposed so future
 * daemon code (IMPL-16) can assert "the directory we configured matches
 * the JID we paired" at startup.
 */
export async function writePairRecord(
  authStateDir: string,
  record: { paired: true; jid: string; ts: number },
): Promise<void> {
  await mkdir(authStateDir, { recursive: true });
  const target = `${authStateDir}/${PAIR_RECORD_FILENAME}`;
  await writeFile(target, JSON.stringify(record, null, 2), { encoding: "utf8" });
  try {
    await chmod(target, 0o600);
  } catch {
    // non-Unix; ignore
  }
}
