/**
 * IPC server: Unix domain socket / Windows named pipe wrapping `net.createServer`.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Daemon ↔ CLI IPC contract" (line 251): newline-delimited JSON;
 *     verbs in `protocol.ts`. Socket file at `~/.pi-comms/daemon.sock`,
 *     named pipe at `\\.\pipe\pi-comms` on Windows.
 *   - §"v4 changelog" Architect IPC backpressure (line 1308): per-attached-
 *     client bounded buffer (default 1000); when full, drop oldest and emit
 *     `attached_client_buffer_overflow` audit row. The `lag_ms` field on
 *     EventResp lets clients self-monitor.
 *   - §"v4 changelog" Adversarial IPC same-UID privesc (line 1293) +
 *     Pitfall #24: per-connection auth token validated on `attach` and
 *     `shutdown`. Mismatch → ErrorResp + close.
 *   - §"v4.2" + Pitfall #30 (line 1270): the daemon mediates pointer
 *     writes via the `pointer-write` IPC verb so the writer queue is the
 *     single serialization point.
 *
 * Concerns not handled here (intentionally):
 *   - The IPC server implements the canonical `Sink` interface from
 *     `src/channels/base.ts` (owned by IMPL-12, sibling in this wave) so
 *     the daemon (W4) can include the IPC server in its fan-out list
 *     alongside WhatsApp / Telegram sinks.
 *   - The audit log writer is supplied by the caller; this module never
 *     opens its own log file. Same for the operator logger.
 */

import { createServer, type Server, type Socket } from "node:net";
import { promises as fs } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { AuditLog } from "../audit/log.js";
import { OperatorLogger } from "../utils/operator-logger.js";
import type { ChannelEvent, Sink } from "../channels/base.js";

import {
  ClientReq,
  type ServerResp,
} from "./protocol.js";

// Re-export the canonical `Sink` + `ChannelEvent` shapes so callers
// (daemon glue, integration tests) can import directly from this module
// without an extra hop into channels/base.
export type { ChannelEvent, Sink } from "../channels/base.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One attached IPC client (one connected `pi-comms` CLI). The daemon's
 * fan-out logic interacts with these objects directly, e.g. to push a
 * single per-client event or to drain after a `pause`.
 */
export interface AttachedClient {
  /** Stable id assigned by the server (random 8-char hex). */
  readonly id: string;
  /** Filter selected at attach time. */
  readonly stream: "all" | "tell-only";
  /** Optional name supplied by the client (operator-logging only). */
  readonly clientName?: string;
  /**
   * Push one canonical channel event to this client. Returns when the
   * line was either written to the socket OR enqueued in the per-client
   * buffer. Throws if the client has been removed (socket closed).
   */
  sendEvent(event: ChannelEvent): Promise<void>;
  /** Soft-pause: events accumulate in the per-client buffer. */
  pause(): void;
  /** Resume + drain the buffer to the wire. */
  resume(): void;
  /** True if `pause()` has been called more recently than `resume()`. */
  isPaused(): boolean;
}

/**
 * Handlers the daemon supplies for client-initiated requests. The IPC
 * server itself is intentionally policy-free — it parses, authenticates,
 * and routes; everything else is the daemon's call.
 */
export interface IpcServerHandlers {
  /**
   * Called when an attached client sends `{verb:'send', text}`.
   * The `attachedClient` reference is supplied so the daemon (or W2 task
   * routing) can decide where the reply goes.
   */
  onSend(text: string, attachedClient: AttachedClient): Promise<void>;
  /** Called for `{verb:'status'}`. */
  onStatus(): Promise<{ summary: string; taskState: unknown }>;
  /** Called for `{verb:'history', limit}`. Should return ≤ `limit` opaque entries. */
  onHistory(limit: number): Promise<unknown[]>;
  /** Called for `{verb:'shutdown'}` AFTER token validation succeeds. */
  onShutdown(): Promise<void>;
  /**
   * Called for `{verb:'pointer-write', body}`. Implementation should
   * route to the daemon-mediated writer (truncating at the 2000-grapheme
   * cap if needed) and return the outcome.
   */
  onPointerWrite(body: string): Promise<{ written: boolean; truncated: boolean }>;
}

export interface IpcServerOpts {
  /**
   * Filesystem path or named-pipe path for the listening socket.
   * Unix: `~/.pi-comms/daemon.sock`; Windows: `\\.\pipe\pi-comms`.
   */
  socketPath: string;
  /** Per-installation auth token (loaded via `readToken`). Constant-time compared. */
  authToken: string;
  /** Daemon-supplied handlers for client requests. */
  handlers: IpcServerHandlers;
  /** Optional audit log writer for connect/disconnect + buffer-overflow events. */
  auditLog?: AuditLog;
  /** Optional operator logger for human-friendly ops lines. */
  operatorLogger?: OperatorLogger;
  /**
   * Per-attached-client bounded buffer cap. When exceeded, oldest events
   * are dropped and an `attached_client_buffer_overflow` audit row is
   * written (Architect Round-1 rec). Default 1000.
   */
  maxBufferedEventsPerSink?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const NEWLINE = 0x0a;
const DEFAULT_BUFFER_CAP = 1000;
const MAX_LINE_BYTES = 256 * 1024; // 256 KB hard cap per JSON line

/**
 * Event kinds the `'tell-only'` filter passes through.  The WhatsApp /
 * Telegram-style sinks should never see infrastructural noise like
 * daemon-internal `system_notice` lines, auto-promote pings, or
 * go_background notices — only the user-facing turns and agent-driven
 * interrupts.
 *
 * AUDIT-C lower-priority: `task_completed` is a real user-facing event
 * (the framework's "done" signal) and must pass the filter, otherwise
 * tell-only attached clients miss the task-end notification.
 *
 * BUG-2026-05-03 fix (Integration Elder Round-1 B1): `reply` is the
 * dedicated ChannelEvent for the framework's auto-completion text
 * (after the mapper switched away from `tell+done`).  It MUST pass the
 * filter or terminal users in tell-only mode see no agent replies.
 */
const TELL_ONLY_EVENT_TYPES = new Set<ChannelEvent["type"]>([
  "tell",
  "reply", // BUG-2026-05-03 fix: framework-completion is now `reply`, not
  // `tell+done`.  tell-only IPC clients MUST receive it or terminal
  // users see no agent replies.  See Integration Elder Round-1 B1.
  "confirm_request",
  "task_completed",
]);

/**
 * One attached client's mutable state, plus the implementation of the
 * `AttachedClient` interface.
 */
class ConnectionState implements AttachedClient {
  readonly id: string;
  private streamMode: "all" | "tell-only" = "all";
  private attached = false;
  private readonly buffer: ChannelEvent[] = [];
  private paused = false;
  private removed = false;
  /**
   * AUDIT-C #12: drain-vs-send race guard.  When `resume()` starts to
   * drain the buffer, new sendEvent() calls must NOT race directly to
   * the wire — that would interleave the drain with fresh events,
   * breaking FIFO ordering the buffer was meant to preserve.  While
   * `draining` is true, sendEvent enqueues into the buffer instead of
   * writing the wire; the drain loop catches up.
   */
  private draining = false;

  constructor(
    readonly socket: Socket,
    private readonly bufferCap: number,
    private readonly onOverflow: (dropped: number) => void
  ) {
    this.id = randomBytes(4).toString("hex");
  }

  // --- AttachedClient surface --------------------------------------------

  get stream(): "all" | "tell-only" {
    return this.streamMode;
  }

  get clientName(): string | undefined {
    return this.declaredName;
  }

  async sendEvent(event: ChannelEvent): Promise<void> {
    if (this.removed) {
      throw new Error(`attached client ${this.id} has been removed`);
    }
    if (!this.attached) {
      // Pre-attach: drop silently. Connect-only state should not receive
      // events; only an attached client is part of the fan-out set.
      return;
    }
    // AUDIT-C #12: while paused OR mid-drain, enqueue rather than racing
    // the drain loop directly to the wire.  This preserves FIFO ordering
    // even if a fresh event lands between resume() and the last buffered
    // entry being flushed.
    if (this.paused || this.draining) {
      this.buffer.push(event);
      this.enforceBufferCap();
      return;
    }
    await this.writeLine(serializeEvent(event));
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.drainBuffered();
  }

  isPaused(): boolean {
    return this.paused;
  }

  // --- Internal: filter / mark / drain ----------------------------------

  /**
   * Apply the `stream` filter selected at attach time. Returns true if
   * the event should be delivered to this client.
   *
   * For `'tell-only'` we accept `tell`, `reply`, `confirm_request`, and
   * `task_completed` — the user-facing turns and agent-driven interrupts.
   * Auto-promote notices, go_background notices, and system notices are
   * suppressed (the WhatsApp / Telegram sinks will apply the same rule
   * downstream).
   *
   * BUG-2026-05-03 fix (Integration Elder Round-1 B1): `reply` was added
   * to the pass-through set when the mapper switched from `tell+done` to
   * the dedicated `reply` ChannelEvent type for framework auto-completion.
   * Without this entry, tell-only attached clients (the terminal CLI in
   * its default mode) would silently miss every conversational reply.
   */
  acceptsEvent(event: ChannelEvent): boolean {
    if (this.streamMode === "all") return true;
    return TELL_ONLY_EVENT_TYPES.has(event.type);
  }

  setAttached(stream: "all" | "tell-only", clientName?: string): void {
    this.attached = true;
    this.streamMode = stream;
    this.declaredName = clientName;
  }

  isAttached(): boolean {
    return this.attached;
  }

  markRemoved(): void {
    this.removed = true;
  }

  /** Write one already-serialized line + newline to the socket. */
  writeLine(line: string): Promise<void> {
    if (this.removed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.socket.write(`${line}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private declaredName?: string;

  private enforceBufferCap(): void {
    if (this.buffer.length <= this.bufferCap) return;
    const overflow = this.buffer.length - this.bufferCap;
    // Drop oldest first (FIFO).
    this.buffer.splice(0, overflow);
    this.onOverflow(overflow);
  }

  private async drainBuffered(): Promise<void> {
    // AUDIT-C #12: mark draining so concurrent sendEvent() calls enqueue
    // instead of racing past us.  The drain loop continues until either
    // the buffer is empty (caught up) or pause() flips paused back on
    // (caller wants to hold events again).
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.paused && this.buffer.length > 0) {
        const next = this.buffer.shift();
        if (!next) break;
        await this.writeLine(serializeEvent(next));
      }
    } finally {
      this.draining = false;
    }
  }
}

/**
 * Serialize one canonical `ChannelEvent` into the wire format consumed
 * by `IpcClient`. The `payload` field on the wire holds every property
 * of the event other than `type` and `ts`, keeping a compact 1:1 with
 * the discriminated union without leaking the internal field names that
 * are already on `EventResp`.
 */
function serializeEvent(event: ChannelEvent): string {
  const ts = event.ts;
  const lag_ms = Math.max(0, Date.now() - ts);
  const { type, ts: _ts, ...payload } = event as ChannelEvent & {
    [k: string]: unknown;
  };
  void _ts;
  const resp: ServerResp = { verb: "event", type, payload, ts, lag_ms };
  return JSON.stringify(resp);
}

/**
 * Implements `Sink` so the daemon can include the IPC server in its
 * fan-out list alongside WhatsApp / Telegram sinks.
 */
export class IpcServer implements Sink {
  private server: Server | null = null;
  private readonly opts: Required<
    Pick<IpcServerOpts, "maxBufferedEventsPerSink">
  > &
    IpcServerOpts;
  private readonly connections = new Map<string, ConnectionState>();

  constructor(opts: IpcServerOpts) {
    this.opts = {
      maxBufferedEventsPerSink: opts.maxBufferedEventsPerSink ?? DEFAULT_BUFFER_CAP,
      ...opts,
    };
  }

  /**
   * Audit log fire-and-forget. The daemon must not crash if the audit
   * file is unavailable (disk full, permissions denied, test workdir
   * removed mid-flight) — but we DO want to surface the failure to the
   * operator log. Do NOT swap this for `void`/`.catch(() => {})` — silent
   * audit drops were called out by the Data Guardian as a load-bearing
   * concern.
   */
  private auditAppend(entry: Parameters<AuditLog["append"]>[0]): void {
    const log = this.opts.auditLog;
    if (!log) return;
    log.append(entry).catch((err) => {
      this.opts.operatorLogger?.error("audit_append_failed", {
        event: entry.event,
        error: (err as Error).message,
      });
    });
  }

  /**
   * Bind the server. On Unix sockets, also chmod 600 the socket file
   * AFTER `listen` so a same-UID actor cannot get a head-start on a
   * world-readable file. (Pitfall #24's first line of defense.)
   *
   * If a stale socket file exists (previous daemon crash), it is unlinked
   * before bind. On Windows named pipes, no file exists to chmod or unlink.
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("IpcServer already started");
    }

    const isPipe = this.opts.socketPath.startsWith("\\\\");
    if (!isPipe) {
      await this.tryUnlinkStaleSocket();
    }

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    if (!isPipe) {
      try {
        await fs.chmod(this.opts.socketPath, 0o600);
      } catch (err) {
        // On macOS/Linux this should always succeed; if it fails, log and
        // continue — we do not want to prevent boot for a chmod hiccup.
        this.opts.operatorLogger?.error("ipc_chmod_failed", {
          path: this.opts.socketPath,
          error: (err as Error).message,
        });
      }
    }

    this.auditAppend({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
      extra: { ipc_socket: this.opts.socketPath },
    });
  }

  /** Stop accepting new connections, close all clients, unlink socket file. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    for (const conn of this.connections.values()) {
      conn.markRemoved();
      conn.socket.destroy();
    }
    this.connections.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (!this.opts.socketPath.startsWith("\\\\")) {
      try {
        await fs.unlink(this.opts.socketPath);
      } catch {
        /* already gone — fine */
      }
    }
  }

  /** Snapshot of currently-attached clients (for `/status`, ops). */
  listAttached(): readonly AttachedClient[] {
    return Array.from(this.connections.values()).filter((c) =>
      c.isAttached()
    );
  }

  /**
   * Sink interface: fan an event out to every attached client whose
   * `stream` filter accepts it.
   */
  async send(event: ChannelEvent): Promise<void> {
    const targets = Array.from(this.connections.values()).filter(
      (c) => c.isAttached() && c.acceptsEvent(event)
    );
    await Promise.all(
      targets.map((c) =>
        c.sendEvent(event).catch((err) => {
          this.opts.operatorLogger?.error("ipc_send_failed", {
            client: c.id,
            type: event.type,
            error: (err as Error).message,
          });
        })
      )
    );
  }

  // --- Connection lifecycle ----------------------------------------------

  private handleConnection(socket: Socket): void {
    const conn = new ConnectionState(socket, this.opts.maxBufferedEventsPerSink, (dropped) =>
      this.recordBufferOverflow(conn, dropped)
    );
    this.connections.set(conn.id, conn);

    let buf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Process all complete lines.
      while (true) {
        const idx = buf.indexOf(NEWLINE);
        if (idx === -1) {
          if (buf.length > MAX_LINE_BYTES) {
            this.replyError(conn, "input line exceeds size cap");
            this.removeConnection(conn, "oversize-line");
            return;
          }
          break;
        }
        const line = buf.subarray(0, idx).toString("utf8");
        buf = buf.subarray(idx + 1);
        void this.handleLine(conn, line);
      }
    });

    socket.on("close", () => this.removeConnection(conn, "client-close"));
    socket.on("error", (err) => {
      this.opts.operatorLogger?.error("ipc_socket_error", {
        client: conn.id,
        error: err.message,
      });
      this.removeConnection(conn, "socket-error");
    });
  }

  private async handleLine(conn: ConnectionState, line: string): Promise<void> {
    if (line.length === 0) return;

    let parsed: ClientReq;
    try {
      const json = JSON.parse(line);
      parsed = ClientReq.parse(json);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "malformed request";
      // Truncate to keep the wire response small + avoid echoing payloads.
      this.replyError(conn, message.slice(0, 200));
      return;
    }

    try {
      switch (parsed.verb) {
        case "attach":
          await this.handleAttach(conn, parsed.authToken, parsed.stream, parsed.clientName);
          return;
        case "send":
          if (!conn.isAttached()) {
            this.replyError(conn, "not attached", "send");
            return;
          }
          await this.opts.handlers.onSend(parsed.text, conn);
          await this.replyAck(conn, "send");
          return;
        case "status": {
          const snap = await this.opts.handlers.onStatus();
          const resp: ServerResp = {
            verb: "status",
            summary: snap.summary,
            taskState: snap.taskState,
          };
          await conn.writeLine(JSON.stringify(resp));
          return;
        }
        case "history": {
          const entries = await this.opts.handlers.onHistory(parsed.limit);
          const resp: ServerResp = { verb: "history", entries };
          await conn.writeLine(JSON.stringify(resp));
          return;
        }
        case "detach":
          this.removeConnection(conn, "detach");
          return;
        case "shutdown":
          if (!constantTimeEquals(parsed.authToken, this.opts.authToken)) {
            this.replyError(conn, "auth token mismatch", "shutdown");
            this.removeConnection(conn, "bad-shutdown-token");
            return;
          }
          await this.replyAck(conn, "shutdown");
          await this.opts.handlers.onShutdown();
          return;
        case "pause":
          conn.pause();
          await this.replyAck(conn, "pause");
          return;
        case "resume":
          conn.resume();
          await this.replyAck(conn, "resume");
          return;
        case "pointer-write": {
          const result = await this.opts.handlers.onPointerWrite(parsed.body);
          const resp: ServerResp = {
            verb: "pointer-write",
            written: result.written,
            truncated: result.truncated,
          };
          await conn.writeLine(JSON.stringify(resp));
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "handler failed";
      this.replyError(conn, message.slice(0, 200), parsed.verb);
    }
  }

  private async handleAttach(
    conn: ConnectionState,
    authToken: string,
    stream: "all" | "tell-only",
    clientName: string | undefined
  ): Promise<void> {
    if (!constantTimeEquals(authToken, this.opts.authToken)) {
      this.replyError(conn, "auth token mismatch", "attach");
      // Audit reject before tearing down so the operator sees same-UID
      // probe attempts even when they fail fast.
      this.auditAppend({
        event: "allowlist_reject",
        task_id: null,
        channel: "terminal",
        sender_id_hash: null,
        extra: { reason: "ipc_auth_mismatch", client_id: conn.id },
      });
      this.opts.operatorLogger?.error("ipc_auth_failure", {
        client: conn.id,
        clientName: clientName ?? "anonymous",
      });
      this.removeConnection(conn, "bad-auth");
      return;
    }
    conn.setAttached(stream, clientName);
    await this.replyAck(conn, "attach");
    // AUDIT-A vocabulary fix: use a dedicated `ipc_attach` event rather
    // than reusing `daemon_boot`.  Same forensic content; cleaner enum.
    this.auditAppend({
      event: "ipc_attach",
      task_id: null,
      channel: "terminal",
      sender_id_hash: null,
      extra: {
        client_id: conn.id,
        stream,
        client_name: clientName ?? "",
      },
    });
    this.opts.operatorLogger?.info("ipc_attach", {
      client: conn.id,
      stream,
      name: clientName ?? "anonymous",
    });
  }

  private removeConnection(conn: ConnectionState, reason: string): void {
    if (!this.connections.has(conn.id)) return;
    this.connections.delete(conn.id);
    conn.markRemoved();
    try {
      conn.socket.end();
    } catch {
      /* already closed */
    }
    // AUDIT-A vocabulary fix: use a dedicated `ipc_detach` event rather
    // than reusing `daemon_shutdown` (which describes a daemon-wide
    // teardown, not one client's socket close).
    this.auditAppend({
      event: "ipc_detach",
      task_id: null,
      channel: "terminal",
      sender_id_hash: null,
      extra: { client_id: conn.id, reason },
    });
    this.opts.operatorLogger?.info("ipc_detach", { client: conn.id, reason });
  }

  // --- Replies ----------------------------------------------------------

  private async replyAck(conn: ConnectionState, of: string): Promise<void> {
    const resp: ServerResp = { verb: "ack", of };
    await conn.writeLine(JSON.stringify(resp));
  }

  private replyError(conn: ConnectionState, message: string, of?: string): void {
    const resp: ServerResp = { verb: "error", of, message };
    void conn.writeLine(JSON.stringify(resp)).catch(() => {
      /* socket may already be closed; nothing to do */
    });
  }

  private recordBufferOverflow(conn: ConnectionState, dropped: number): void {
    this.auditAppend({
      event: "serial_queue_blocked",
      task_id: null,
      channel: "terminal",
      sender_id_hash: null,
      extra: {
        kind: "attached_client_buffer_overflow",
        client_id: conn.id,
        dropped_events: dropped,
        cap: this.opts.maxBufferedEventsPerSink,
      },
    });
    this.opts.operatorLogger?.error("attached_client_buffer_overflow", {
      client: conn.id,
      dropped,
      cap: this.opts.maxBufferedEventsPerSink,
    });
  }

  // --- Filesystem --------------------------------------------------------

  private async tryUnlinkStaleSocket(): Promise<void> {
    try {
      await fs.unlink(this.opts.socketPath);
    } catch (err) {
      // ENOENT is the normal case (no stale file). Anything else might
      // mean someone else holds the path; surface the error so we don't
      // silently fail to bind.
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw err;
      }
    }
  }
}

/**
 * Constant-time string equality. Falls back to a constant-time comparison
 * over zero-padded buffers when the lengths differ, so that a length
 * mismatch is not detectable by timing alone (defense in depth — zod has
 * already enforced `min(8)` on the supplied token).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Compare against equal-length buffers to prevent timing-based length
  // disclosure. timingSafeEqual throws on length mismatch otherwise.
  const len = Math.max(ba.length, bb.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  const equal = timingSafeEqual(pa, pb);
  return equal && ba.length === bb.length;
}
