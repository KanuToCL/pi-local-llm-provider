/**
 * IPC client SDK.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Daemon ↔ CLI IPC contract" (line 251): newline-delimited JSON;
 *     verb set in `protocol.ts`. The thin `bin/pi-comms.ts` (W4) drives
 *     this SDK; it is also useful for integration tests.
 *
 * Usage shape (W4 will wire this into the CLI):
 *
 *   const client = new IpcClient({
 *     socketPath: '~/.pi-comms/daemon.sock',
 *     authToken: await readToken('~/.pi-comms/ipc-token'),
 *     onEvent: (type, payload, ts, lag_ms) => formatAndPrint(...),
 *   });
 *   await client.attach('all', 'pi-comms-cli');
 *   await client.send('say hi');
 *   ...
 *   await client.detach();
 *
 * Concurrency model:
 *   - One in-flight request at a time. Calls to e.g. `status()` await an
 *     ack/payload before resolving. This matches the synchronous nature
 *     of the CLI surface — the CLI never pipelines.
 *   - `onEvent` callbacks fire OUT OF BAND with respect to request/reply,
 *     so the daemon can stream events while a request is in flight.
 */

import { connect, type Socket } from "node:net";

import { ServerResp } from "./protocol.js";

const NEWLINE = 0x0a;
const REQUEST_TIMEOUT_MS = 30_000;

export interface IpcClientOpts {
  /** Path to the Unix socket / Windows named pipe. */
  socketPath: string;
  /** Per-installation auth token (loaded via `readToken`). */
  authToken: string;
  /** Streamed event callback. Called for every server-side `event` line. */
  onEvent?: (type: string, payload: unknown, ts: number, lag_ms: number) => void;
  /** Optional error callback (parse failure, transport failure). */
  onError?: (message: string) => void;
}

interface PendingRequest {
  /** Verbs we expect as a successful reply. `ack` is also accepted. */
  expect: ServerResp["verb"][];
  resolve: (value: ServerResp) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcClient {
  private socket: Socket | null = null;
  private pending: PendingRequest | null = null;
  private buffer = Buffer.alloc(0);
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: IpcClientOpts) {}

  // --- High-level verbs --------------------------------------------------

  /**
   * Open the socket if needed and send `attach`. Resolves on `ack`. Throws
   * on `error` (e.g. token mismatch). The socket is closed by the daemon
   * on bad-auth, after which `onError` will fire and subsequent calls
   * will reject with "socket closed".
   */
  async attach(stream: "all" | "tell-only", clientName?: string): Promise<void> {
    await this.ensureConnected();
    await this.request(
      {
        verb: "attach",
        stream,
        authToken: this.opts.authToken,
        ...(clientName ? { clientName } : {}),
      },
      ["ack"]
    );
  }

  async detach(): Promise<void> {
    if (!this.socket) return;
    try {
      // The daemon closes our socket on detach; we don't expect a reply.
      await this.send_({ verb: "detach" });
    } catch {
      /* may be closing concurrently */
    }
    this.close();
  }

  async send(text: string): Promise<void> {
    await this.request({ verb: "send", text }, ["ack"]);
  }

  async status(): Promise<{ summary: string; taskState: unknown }> {
    const reply = await this.request({ verb: "status" }, ["status"]);
    if (reply.verb !== "status") throw new Error("expected status reply");
    return { summary: reply.summary, taskState: reply.taskState };
  }

  async history(limit: number): Promise<unknown[]> {
    const reply = await this.request({ verb: "history", limit }, ["history"]);
    if (reply.verb !== "history") throw new Error("expected history reply");
    return reply.entries;
  }

  async shutdown(): Promise<void> {
    await this.request(
      { verb: "shutdown", authToken: this.opts.authToken },
      ["ack"]
    );
    this.close();
  }

  async pause(): Promise<void> {
    await this.request({ verb: "pause" }, ["ack"]);
  }

  async resume(): Promise<void> {
    await this.request({ verb: "resume" }, ["ack"]);
  }

  async pointerWrite(body: string): Promise<{ written: boolean; truncated: boolean }> {
    const reply = await this.request({ verb: "pointer-write", body }, ["pointer-write"]);
    if (reply.verb !== "pointer-write") throw new Error("expected pointer-write reply");
    return { written: reply.written, truncated: reply.truncated };
  }

  /** Tear down the underlying socket. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("client closed"));
      this.pending = null;
    }
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }

  // --- Internal ---------------------------------------------------------

  private ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = connect(this.opts.socketPath, () => {
        socket.removeListener("error", onConnectError);
        this.socket = socket;
        this.bindSocket(socket);
        resolve();
      });
      const onConnectError = (err: Error) => {
        this.connectPromise = null;
        reject(err);
      };
      socket.once("error", onConnectError);
    });

    return this.connectPromise;
  }

  private bindSocket(socket: Socket): void {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const idx = this.buffer.indexOf(NEWLINE);
        if (idx === -1) break;
        const line = this.buffer.subarray(0, idx).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 1);
        this.handleLine(line);
      }
    });
    socket.on("close", () => {
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error("socket closed"));
        this.pending = null;
      }
      this.socket = null;
      this.connectPromise = null;
    });
    socket.on("error", (err) => {
      this.opts.onError?.(err.message);
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;
    let parsed: ServerResp;
    try {
      parsed = ServerResp.parse(JSON.parse(line));
    } catch (err) {
      const message = err instanceof Error ? err.message : "malformed reply";
      this.opts.onError?.(message);
      return;
    }

    if (parsed.verb === "event") {
      this.opts.onEvent?.(parsed.type, parsed.payload, parsed.ts, parsed.lag_ms);
      return;
    }

    if (parsed.verb === "error") {
      if (this.pending) {
        const pending = this.pending;
        clearTimeout(pending.timer);
        this.pending = null;
        pending.reject(new Error(parsed.message));
      } else {
        this.opts.onError?.(parsed.message);
      }
      return;
    }

    // ack / status / history / pointer-write all settle the in-flight request.
    if (this.pending && this.pending.expect.includes(parsed.verb)) {
      const pending = this.pending;
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve(parsed);
    } else {
      // Unsolicited reply — surface so the operator knows the daemon is
      // out of sync with the CLI's expectations.
      this.opts.onError?.(`unexpected ${parsed.verb} reply with no in-flight request`);
    }
  }

  private async send_(req: object): Promise<void> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket) throw new Error("socket closed");
    const line = `${JSON.stringify(req)}\n`;
    await new Promise<void>((resolve, reject) => {
      socket.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  private async request(
    req: object,
    expect: ServerResp["verb"][]
  ): Promise<ServerResp> {
    if (this.pending) {
      throw new Error("request already in flight");
    }
    return new Promise<ServerResp>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) {
          this.pending = null;
          reject(new Error("ipc request timeout"));
        }
      }, REQUEST_TIMEOUT_MS);
      // Avoid blocking the process exit on a stuck timer.
      timer.unref?.();
      this.pending = { expect, resolve, reject, timer };
      this.send_(req).catch((err) => {
        if (this.pending && this.pending.timer === timer) {
          clearTimeout(timer);
          this.pending = null;
          reject(err);
        }
      });
    });
  }
}
