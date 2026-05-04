/**
 * Integration tests for `IpcServer` + `IpcClient`.
 *
 * Coverage targets (≥6 cases per IMPL-13 brief):
 *   1. server starts + chmod 600 verified (Unix only)
 *   2. client attach with correct token → ack
 *   3. client attach with wrong token → ErrorResp + connection closed
 *   4. client send → handler.onSend called with text + attached client ref
 *   5. server.send(event) fans out to all attached clients → onEvent fires
 *      AND respects per-client `tell-only` filter (an `all` client gets
 *      everything, a `tell-only` client only gets `tell`/`confirm`/`reply`
 *      — `reply` per BUG-2026-05-03 fix in src/ipc/server.ts commit 53fe7b0)
 *   6. server enforces buffer cap: pause client, send N+ events, assert
 *      oldest dropped + audit row recorded
 *   7. clean shutdown (server.stop) closes all clients
 *   8. status / history / pointer-write verbs round-trip
 *
 * Sockets live in tmpdir to avoid colliding with a developer's real
 * `~/.pi-comms/daemon.sock`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { AuditLog } from "../../src/audit/log.js";
import { type AuditEntry } from "../../src/audit/schema.js";
import {
  IpcServer,
  type AttachedClient,
  type ChannelEvent,
  type IpcServerHandlers,
} from "../../src/ipc/server.js";
import { IpcClient } from "../../src/ipc/client.js";

let workDir: string;
let socketPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-ipc-int-"));
  // Keep socket path well under the 104-char Unix domain socket cap.
  // Random suffix avoids collisions across parallel test workers.
  socketPath = join(workDir, `s.${randomBytes(2).toString("hex")}.sock`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface Harness {
  server: IpcServer;
  audit: AuditLog;
  auditDir: string;
  authToken: string;
  handlerCalls: HandlerCalls;
}

interface HandlerCalls {
  send: { text: string; clientId: string }[];
  status: number;
  history: number[];
  shutdown: number;
  pointerWrite: { body: string }[];
}

async function bootHarness(
  overrides: Partial<IpcServerHandlers> = {},
  opts: { maxBufferedEventsPerSink?: number } = {}
): Promise<Harness> {
  const auditDir = join(workDir, "audit");
  const audit = new AuditLog({ dir: auditDir, daemonStartTs: Date.now() });
  const authToken = "deadbeefdeadbeef".repeat(2);
  const handlerCalls: HandlerCalls = {
    send: [],
    status: 0,
    history: [],
    shutdown: 0,
    pointerWrite: [],
  };
  const handlers: IpcServerHandlers = {
    async onSend(text: string, attached: AttachedClient) {
      handlerCalls.send.push({ text, clientId: attached.id });
    },
    async onStatus() {
      handlerCalls.status += 1;
      return { summary: "idle", taskState: { kind: "idle" } };
    },
    async onHistory(limit: number) {
      handlerCalls.history.push(limit);
      return Array.from({ length: limit }, (_, i) => ({ idx: i }));
    },
    async onShutdown() {
      handlerCalls.shutdown += 1;
    },
    async onPointerWrite(body: string) {
      handlerCalls.pointerWrite.push({ body });
      return { written: true, truncated: body.length > 10 };
    },
    ...overrides,
  };

  const server = new IpcServer({
    socketPath,
    authToken,
    handlers,
    auditLog: audit,
    maxBufferedEventsPerSink: opts.maxBufferedEventsPerSink ?? 1000,
  });
  await server.start();
  return { server, audit, auditDir, authToken, handlerCalls };
}

async function readAuditEntries(auditDir: string): Promise<AuditEntry[]> {
  const { readdirSync, readFileSync } = await import("node:fs");
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir);
  const entries: AuditEntry[] = [];
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      entries.push(JSON.parse(line) as AuditEntry);
    }
  }
  return entries;
}

/** Small async sleep helper — used only when waiting for fan-out events. */
function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("IpcServer — bind + permissions", () => {
  it.skipIf(process.platform === "win32")(
    "chmods the socket file to 0600 after listen",
    async () => {
      const h = await bootHarness();
      try {
        const st = statSync(socketPath);
        expect((st.mode & 0o777).toString(8)).toBe("600");
      } finally {
        await h.server.stop();
      }
    }
  );
});

describe("IpcServer — attach handshake", () => {
  it("acks a correct-token attach", async () => {
    const h = await bootHarness();
    const client = new IpcClient({
      socketPath,
      authToken: h.authToken,
    });
    try {
      await client.attach("all", "test-client");
      expect(h.server.listAttached()).toHaveLength(1);
      expect(h.server.listAttached()[0]?.clientName).toBe("test-client");
    } finally {
      client.close();
      await h.server.stop();
    }
  });

  it("rejects a bad-token attach with ErrorResp + closes the connection", async () => {
    const h = await bootHarness();
    const client = new IpcClient({
      socketPath,
      authToken: "wrongwrongwrong!",
    });
    try {
      await expect(client.attach("all", "test-client")).rejects.toThrow(
        /auth token mismatch/i
      );
      // Give the server a tick to log the audit row.
      await tick(50);
      const entries = await readAuditEntries(h.auditDir);
      const reject = entries.find(
        (e) =>
          e.event === "allowlist_reject" &&
          e.extra?.reason === "ipc_auth_mismatch"
      );
      expect(reject).toBeDefined();
      expect(h.server.listAttached()).toHaveLength(0);
    } finally {
      client.close();
      await h.server.stop();
    }
  });
});

describe("IpcServer — send routing", () => {
  it("invokes onSend with the text + the attached client reference", async () => {
    const h = await bootHarness();
    const client = new IpcClient({
      socketPath,
      authToken: h.authToken,
    });
    try {
      await client.attach("all", "sender");
      await client.send("ping pi");

      expect(h.handlerCalls.send).toHaveLength(1);
      expect(h.handlerCalls.send[0]?.text).toBe("ping pi");
      // The attached client id is what server.listAttached exposes.
      const attachedId = h.server.listAttached()[0]?.id;
      expect(h.handlerCalls.send[0]?.clientId).toBe(attachedId);
    } finally {
      client.close();
      await h.server.stop();
    }
  });

  it("rejects send before attach", async () => {
    const h = await bootHarness();
    const client = new IpcClient({
      socketPath,
      authToken: h.authToken,
    });
    try {
      await expect(client.send("hi")).rejects.toThrow(/not attached/i);
    } finally {
      client.close();
      await h.server.stop();
    }
  });
});

describe("IpcServer — fan-out + per-client filter", () => {
  it("delivers events to attached clients respecting the stream filter", async () => {
    const h = await bootHarness();
    const allEvents: { type: string }[] = [];
    const tellEvents: { type: string }[] = [];

    const allClient = new IpcClient({
      socketPath,
      authToken: h.authToken,
      onEvent: (type) => {
        allEvents.push({ type });
      },
    });
    const tellClient = new IpcClient({
      socketPath,
      authToken: h.authToken,
      onEvent: (type) => {
        tellEvents.push({ type });
      },
    });
    try {
      await allClient.attach("all", "all-stream");
      await tellClient.attach("tell-only", "tell-stream");

      const events: ChannelEvent[] = [
        { type: "reply", text: "hello", ts: Date.now() },
        { type: "tell", urgency: "info", text: "done", ts: Date.now() },
        {
          type: "system_notice",
          text: "boot complete",
          level: "info",
          ts: Date.now(),
        },
        {
          type: "confirm_request",
          shortId: "a1b2",
          question: "delete src/?",
          rationale: "user asked",
          risk: "irreversible",
          expiresAt: Date.now() + 60_000,
          ts: Date.now(),
        },
      ];
      for (const e of events) {
        await h.server.send(e);
      }

      // Allow socket flushes.
      await tick(80);
      const allTypes = allEvents.map((e) => e.type).sort();
      const tellTypes = tellEvents.map((e) => e.type).sort();
      expect(allTypes).toEqual([
        "confirm_request",
        "reply",
        "system_notice",
        "tell",
      ]);
      // tell-only filter passes tell + confirm_request + reply.  `reply` was
      // added to TELL_ONLY_EVENT_TYPES per BUG-2026-05-03 fix in
      // src/ipc/server.ts (commit 53fe7b0, Integration Elder B1):
      // framework-completion is now `reply` (not `tell+done`), so terminal
      // IPC clients in tell-only mode MUST receive it or they see no agent
      // replies.
      expect(tellTypes).toEqual(["confirm_request", "reply", "tell"]);
    } finally {
      allClient.close();
      tellClient.close();
      await h.server.stop();
    }
  });
});

describe("IpcServer — backpressure", () => {
  it("drops oldest events when the per-client buffer overflows + audits the drop", async () => {
    const cap = 10;
    const h = await bootHarness({}, { maxBufferedEventsPerSink: cap });
    const received: number[] = [];
    const client = new IpcClient({
      socketPath,
      authToken: h.authToken,
      onEvent: (_type, payload) => {
        // The server's `serializeEvent` packs every non-`type`/`ts` field
        // into `payload`, so a `reply` event surfaces `{text}` here.
        const i = Number((payload as { text: string }).text);
        received.push(i);
      },
    });
    try {
      await client.attach("all", "paused-client");
      await client.pause();

      // Fan 30 events through the server while the client is paused.
      for (let i = 0; i < 30; i += 1) {
        await h.server.send({
          type: "reply",
          text: String(i),
          ts: Date.now(),
        });
      }

      await client.resume();
      await tick(120);

      // Buffer cap = 10, so we should only receive the LAST 10 events.
      expect(received.length).toBe(cap);
      expect(received).toEqual(Array.from({ length: cap }, (_, i) => 20 + i));

      // And an overflow row should be in the audit log.
      const entries = await readAuditEntries(h.auditDir);
      const overflow = entries.find(
        (e) =>
          e.event === "serial_queue_blocked" &&
          e.extra?.kind === "attached_client_buffer_overflow"
      );
      expect(overflow).toBeDefined();
      expect(Number(overflow?.extra?.dropped_events ?? 0)).toBeGreaterThan(0);
    } finally {
      client.close();
      await h.server.stop();
    }
  });
});

describe("IpcServer — status / history / pointer-write verbs", () => {
  it("status returns the daemon snapshot", async () => {
    const h = await bootHarness();
    const client = new IpcClient({ socketPath, authToken: h.authToken });
    try {
      await client.attach("all");
      const snap = await client.status();
      expect(snap.summary).toBe("idle");
      expect(h.handlerCalls.status).toBe(1);
    } finally {
      client.close();
      await h.server.stop();
    }
  });

  it("history returns the requested number of entries", async () => {
    const h = await bootHarness();
    const client = new IpcClient({ socketPath, authToken: h.authToken });
    try {
      await client.attach("all");
      const entries = await client.history(7);
      expect(entries).toHaveLength(7);
      expect(h.handlerCalls.history).toEqual([7]);
    } finally {
      client.close();
      await h.server.stop();
    }
  });

  it("pointer-write reports truncation outcome", async () => {
    const h = await bootHarness();
    const client = new IpcClient({ socketPath, authToken: h.authToken });
    try {
      await client.attach("all");
      const small = await client.pointerWrite("short");
      expect(small).toEqual({ written: true, truncated: false });
      const big = await client.pointerWrite("a really long body");
      expect(big.truncated).toBe(true);
      expect(h.handlerCalls.pointerWrite).toHaveLength(2);
    } finally {
      client.close();
      await h.server.stop();
    }
  });
});

describe("IpcServer — clean shutdown", () => {
  it("server.stop tears down all attached clients + removes the socket file", async () => {
    const h = await bootHarness();
    const client = new IpcClient({ socketPath, authToken: h.authToken });
    await client.attach("all");
    expect(h.server.listAttached()).toHaveLength(1);
    await h.server.stop();
    expect(h.server.listAttached()).toHaveLength(0);

    // On Unix sockets, the path should be unlinked after stop.
    if (process.platform !== "win32") {
      expect(existsSync(socketPath)).toBe(false);
    }

    client.close();
  });
});
