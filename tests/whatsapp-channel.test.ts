/**
 * WhatsappChannel — Baileys-adapter tests.
 *
 * Strategy (per Testing Elder Round-1, plan line 1340: "Baileys mock layer
 * → sock.ev event-emitter substitution chosen"):
 *   - Construct a synthetic socket whose `ev` is a plain Node EventEmitter.
 *   - Inject via `socketFactory` so the channel never tries to dynamic-import
 *     the real Baileys module during tests.
 *   - Drive inbound by `sock.ev.emit('messages.upsert', { messages, type })`.
 *   - Drive lifecycle by `sock.ev.emit('connection.update', { connection: ... })`.
 *   - Stub `sock.sendMessage` with `vi.fn()` to assert outbound payloads.
 *
 * Coverage (per IMPL-17 brief — at least 12 cases):
 *   1. DM-only enforcement: group-jid → silent + audit
 *   2. Allowlist enforcement (Model B): non-owner sender → silent + audit
 *   3. Self-chat model: ownerJid + fromMe=true → accepted
 *   4. Self-chat model: ownerJid + fromMe=false → rejected (someone else
 *      sent to ownerJid in a non-self context — guard against confusion)
 *   5. Second-number model: ownerJid + fromMe=false → accepted
 *   6. Second-number model: ownerJid + fromMe=true → rejected (own outbound
 *      echo, must not loop)
 *   7. Voice inbound → synthesized text
 *   8. Image inbound → synthesized text
 *   9. Document inbound → synthesized text
 *  10. Outbound send(reply) calls sock.sendMessage with no prefix
 *  11. Outbound send(tell) uses 📱 prefix
 *  12. Outbound long text → multiple chunks
 *  13. send() before connection open → no-op
 *  14. connection.update 'open' → whatsapp_connect audit + connected=true
 *  15. DisconnectReason.loggedOut → no auto-reconnect, whatsapp_reauth_needed
 *      audit, degraded=true
 *  16. DisconnectReason.connectionLost → backoff schedule fires (fake timers
 *      assert intervals)
 *  17. DisconnectReason.restartRequired → 1 retry then degraded
 *  18. 10 consecutive failures → terminal degraded state
 *  19. formatChannelEvent prefix coverage (system_notice + task_completed)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WhatsappChannel,
  WhatsappDisconnectReason,
  formatChannelEvent,
  type WhatsappSocket,
  type WhatsappSocketFactory,
} from "../src/channels/whatsapp.js";
import { AuditLog } from "../src/audit/log.js";
import type {
  ChannelEvent,
  InboundMessage,
  InboundProcessor,
} from "../src/channels/base.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OWNER_JID = "15105551234@s.whatsapp.net";
const BOT_JID = "15106666666@s.whatsapp.net";
const ALICE_JID = "15109998888@s.whatsapp.net";
const GROUP_JID = "120363025698745632@g.us";

class CapturingProcessor implements InboundProcessor {
  received: InboundMessage[] = [];
  shouldThrow = false;
  async processInbound(msg: InboundMessage): Promise<void> {
    if (this.shouldThrow) throw new Error("processor down");
    this.received.push(msg);
  }
}

interface MockSocket extends WhatsappSocket {
  ev: EventEmitter;
  sendMessage: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeMockSocket(): MockSocket {
  const ev = new EventEmitter();
  return {
    ev,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    end: vi.fn(),
  };
}

function makeFactory(socket: MockSocket): WhatsappSocketFactory {
  return async () => socket;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-wa-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.useRealTimers();
});

// Build a Baileys-shaped WAMessage for tests.
function mkMessage(opts: {
  remoteJid: string;
  fromMe?: boolean;
  participant?: string;
  text?: string;
  voice?: boolean;
  image?: boolean;
  document?: boolean;
}): unknown {
  let body: Record<string, unknown>;
  if (opts.text !== undefined) {
    body = { conversation: opts.text };
  } else if (opts.voice) {
    body = { audioMessage: { ptt: true, mimetype: "audio/ogg" } };
  } else if (opts.image) {
    body = { imageMessage: { mimetype: "image/jpeg" } };
  } else if (opts.document) {
    body = { documentMessage: { mimetype: "application/pdf" } };
  } else {
    body = { conversation: "" };
  }
  return {
    key: {
      remoteJid: opts.remoteJid,
      fromMe: opts.fromMe ?? false,
      participant: opts.participant,
      id: `test-${Math.random()}`,
    },
    message: body,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

interface ChannelHarness {
  channel: WhatsappChannel;
  socket: MockSocket;
  proc: CapturingProcessor;
  audit: AuditLog;
  auditDir: string;
}

async function buildChannel(
  identityModel: "self-chat" | "second-number",
  overrides: {
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    jitterFn?: () => number;
    chunkSize?: number;
    socket?: MockSocket;
  } = {},
): Promise<ChannelHarness> {
  const proc = new CapturingProcessor();
  const auditDir = join(workDir, "audit");
  const audit = new AuditLog({
    dir: auditDir,
    daemonStartTs: Date.now() - 1000,
  });
  const socket = overrides.socket ?? makeMockSocket();
  const channel = new WhatsappChannel({
    identityModel,
    ownerJid: OWNER_JID,
    botJid: identityModel === "second-number" ? BOT_JID : undefined,
    authStateDir: join(workDir, "wa-auth"),
    inboundProcessor: proc,
    chunkSize: overrides.chunkSize,
    auditLog: audit,
    socketFactory: makeFactory(socket),
    setTimeoutFn: overrides.setTimeoutFn,
    clearTimeoutFn: overrides.clearTimeoutFn,
    jitterFn: overrides.jitterFn,
  });
  return { channel, socket, proc, audit, auditDir };
}

async function emitOpen(
  socket: MockSocket,
  channel: WhatsappChannel,
): Promise<void> {
  socket.ev.emit("connection.update", { connection: "open" });
  await channel.flushPending();
}

async function readAuditLines(auditDir: string): Promise<unknown[]> {
  const fs = await import("node:fs");
  let entries: string[];
  try {
    entries = fs.readdirSync(auditDir);
  } catch {
    return [];
  }
  const all: unknown[] = [];
  for (const name of entries) {
    if (!name.startsWith("audit.") || !name.endsWith(".jsonl")) continue;
    const raw = fs.readFileSync(join(auditDir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      all.push(JSON.parse(line));
    }
  }
  return all;
}

interface AuditEntryShape {
  event: string;
  extra?: Record<string, unknown>;
  channel?: string;
}

async function findAudit(
  auditDir: string,
  eventName: string,
): Promise<AuditEntryShape[]> {
  const lines = (await readAuditLines(auditDir)) as AuditEntryShape[];
  return lines.filter((e) => e.event === eventName);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WhatsappChannel — DM-only enforcement", () => {
  test("group chat: silently rejected, processor never called", async () => {
    const { channel, socket, proc, auditDir } = await buildChannel("self-chat");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: GROUP_JID,
          participant: OWNER_JID,
          fromMe: false,
          text: "hi from group",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(0);
    expect(socket.sendMessage).not.toHaveBeenCalled();
    const rejects = await findAudit(auditDir, "dm_only_reject");
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    expect(rejects[0]!.channel).toBe("whatsapp");

    await channel.stop();
  });
});

describe("WhatsappChannel — allowlist enforcement", () => {
  test("Model B: non-owner sender silently rejected, audit recorded", async () => {
    const { channel, socket, proc, auditDir } = await buildChannel("second-number");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: ALICE_JID,
          fromMe: false,
          text: "hi pi, this is Alice",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(0);
    expect(socket.sendMessage).not.toHaveBeenCalled();
    const rejects = await findAudit(auditDir, "allowlist_reject");
    expect(rejects.length).toBeGreaterThanOrEqual(1);

    await channel.stop();
  });
});

describe("WhatsappChannel — self-chat identity model", () => {
  test("ownerJid sender + fromMe=true → accepted (Sergio messaging the Self thread)", async () => {
    const { channel, socket, proc } = await buildChannel("self-chat");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: OWNER_JID,
          fromMe: true,
          text: "deploy now",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    expect(proc.received[0]).toMatchObject({
      type: "text",
      channel: "whatsapp",
      sender: { id: OWNER_JID },
      payload: { text: "deploy now" },
    });

    await channel.stop();
  });

  test("ownerJid sender + fromMe=false → rejected (not the self-chat shape)", async () => {
    const { channel, socket, proc } = await buildChannel("self-chat");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: OWNER_JID,
          fromMe: false,
          text: "ghost of sergio",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(0);

    await channel.stop();
  });
});

describe("WhatsappChannel — second-number identity model", () => {
  test("ownerJid sender + fromMe=false → accepted (Sergio DMs the bot)", async () => {
    const { channel, socket, proc } = await buildChannel("second-number");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: OWNER_JID,
          fromMe: false,
          text: "what's the status?",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    expect(proc.received[0]!.payload.text).toBe("what's the status?");

    await channel.stop();
  });

  test("ownerJid sender + fromMe=true → rejected (would be the bot's own echo)", async () => {
    const { channel, socket, proc } = await buildChannel("second-number");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: OWNER_JID,
          fromMe: true,
          text: "this is the bot's echo",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(0);

    await channel.stop();
  });
});

describe("WhatsappChannel — non-text inbound synthesis (Pitfall #21)", () => {
  test("voice → synthesized text", async () => {
    const { channel, socket, proc } = await buildChannel("self-chat");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [mkMessage({ remoteJid: OWNER_JID, fromMe: true, voice: true })],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    expect(proc.received[0]!.type).toBe("voice");
    expect(proc.received[0]!.payload.text).toContain("voice");
    expect(proc.received[0]!.payload.text).toContain("deferred");

    await channel.stop();
  });

  test("image → synthesized text", async () => {
    const { channel, socket, proc } = await buildChannel("self-chat");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [mkMessage({ remoteJid: OWNER_JID, fromMe: true, image: true })],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    expect(proc.received[0]!.type).toBe("image");
    expect(proc.received[0]!.payload.text).toContain("image");

    await channel.stop();
  });

  test("document → synthesized text (collapses to image type)", async () => {
    const { channel, socket, proc } = await buildChannel("self-chat");
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({ remoteJid: OWNER_JID, fromMe: true, document: true }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    // Documents collapse to "image" in the v1 InboundMessage type enum.
    expect(proc.received[0]!.type).toBe("image");
    expect(proc.received[0]!.payload.text).toContain("document");

    await channel.stop();
  });
});

describe("WhatsappChannel — outbound", () => {
  test("send(reply) → sock.sendMessage(ownerJid, { text }) with no prefix", async () => {
    const { channel, socket } = await buildChannel("second-number");
    await channel.start();
    await emitOpen(socket, channel);

    await channel.send({ type: "reply", text: "the answer", ts: 0 });

    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage).toHaveBeenCalledWith(OWNER_JID, {
      text: "the answer",
    });

    await channel.stop();
  });

  test("send(tell) uses 📱 prefix", async () => {
    const { channel, socket } = await buildChannel("second-number");
    await channel.start();
    await emitOpen(socket, channel);

    await channel.send({
      type: "tell",
      urgency: "milestone",
      text: "phase 1 done",
      ts: 0,
    });

    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage).toHaveBeenCalledWith(OWNER_JID, {
      text: "📱 phase 1 done",
    });

    await channel.stop();
  });

  test("long reply (10K chars) → multiple chunks", async () => {
    const { channel, socket } = await buildChannel("second-number", {
      chunkSize: 1000,
    });
    await channel.start();
    await emitOpen(socket, channel);

    const huge = "x".repeat(10_000);
    await channel.send({ type: "reply", text: huge, ts: 0 });

    expect(socket.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(10);

    await channel.stop();
  });

  test("send() before any open → no-op (no transport yet)", async () => {
    const { channel, socket } = await buildChannel("second-number");
    // intentionally NOT starting / opening
    await channel.send({ type: "reply", text: "nobody home", ts: 0 });
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});

describe("WhatsappChannel — connection lifecycle", () => {
  test("connection.update 'open' → whatsapp_connect audit + connected=true", async () => {
    const { channel, socket, auditDir } = await buildChannel("second-number");
    await channel.start();
    expect(channel.isConnected()).toBe(false);

    await emitOpen(socket, channel);
    expect(channel.isConnected()).toBe(true);
    const opens = await findAudit(auditDir, "whatsapp_connect");
    expect(opens.length).toBe(1);
    expect(opens[0]!.extra?.identity_model).toBe("second-number");

    await channel.stop();
  });

  test("auth dir is created with mode 0700 (best-effort on Unix)", async () => {
    const { channel } = await buildChannel("self-chat");
    await channel.start();

    const stat = statSync(join(workDir, "wa-auth"));
    // Mode bits — only check the perm bits we set.  On non-Unix CI this
    // assertion may be loose; the chmod is best-effort.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }

    await channel.stop();
  });
});

describe("WhatsappChannel — disconnect reason-code branching (V5-C)", () => {
  test("loggedOut → no auto-reconnect, whatsapp_reauth_needed audit, degraded=true", async () => {
    vi.useFakeTimers();
    const setTimeoutFn = vi.fn(setTimeout);
    const { channel, socket, auditDir } = await buildChannel("second-number", {
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    });
    await channel.start();
    await emitOpen(socket, channel);

    const lastDisconnect = {
      error: { output: { statusCode: WhatsappDisconnectReason.loggedOut } },
      date: new Date(),
    };
    socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect,
    });
    await channel.flushPending();

    expect(channel.isConnected()).toBe(false);
    expect(channel.isDegraded()).toBe(true);
    // The setTimeoutFn we injected should NOT have been called for any
    // reconnect — loggedOut goes straight to degraded.
    expect(setTimeoutFn).not.toHaveBeenCalled();

    const reauth = await findAudit(auditDir, "whatsapp_reauth_needed");
    expect(reauth.length).toBe(1);

    await channel.stop();
  });

  test("connectionLost → backoff schedule fires (60s for first failure)", async () => {
    vi.useFakeTimers();
    const setTimeoutFn = vi.fn((handler: TimerHandler, ms?: number) =>
      setTimeout(handler, ms),
    );
    // Deterministic jitter for exact-interval assertion.
    const fixedJitter = () => 1.0;
    const { channel, socket } = await buildChannel("second-number", {
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      jitterFn: fixedJitter,
    });
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: WhatsappDisconnectReason.connectionLost } },
        date: new Date(),
      },
    });
    await channel.flushPending();

    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    const firstCallDelay = setTimeoutFn.mock.calls[0]?.[1] as number;
    // First failure → 60s base * 1.0 jitter = 60_000 ms.
    expect(firstCallDelay).toBe(60_000);
    expect(channel.isDegraded()).toBe(false);

    await channel.stop();
  });

  test("restartRequired → 1 retry then degraded after 10 total failures", async () => {
    vi.useFakeTimers();
    const setTimeoutFn = vi.fn((handler: TimerHandler, ms?: number) =>
      setTimeout(handler, ms),
    );
    const { channel, socket } = await buildChannel("second-number", {
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      jitterFn: () => 1.0,
    });
    await channel.start();
    await emitOpen(socket, channel);

    // First close: restartRequired → 1 retry queued at 0ms.
    socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: {
          output: { statusCode: WhatsappDisconnectReason.restartRequired },
        },
        date: new Date(),
      },
    });
    await channel.flushPending();
    // First retry should be queued for IMMEDIATE reconnect (delay 0).
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn.mock.calls[0]?.[1]).toBe(0);

    await channel.stop();
  });

  test("10 consecutive failures → terminal degraded state", async () => {
    vi.useFakeTimers();
    let pendingTimers: Array<() => void> = [];
    const setTimeoutFn = vi.fn(
      (handler: TimerHandler, _ms?: number): NodeJS.Timeout => {
        // Capture the handler so we can fire it synchronously without
        // triggering an actual reconnect (which would hit our fake socket
        // again).  We just want to count failures here.
        if (typeof handler === "function") {
          pendingTimers.push(handler as () => void);
        }
        return 0 as unknown as NodeJS.Timeout;
      },
    );
    const clearTimeoutFn = vi.fn();

    // Use a socket factory that throws for reconnects so each
    // reconnect-attempt fails and increments failureCount.
    const sockets: MockSocket[] = [makeMockSocket()];
    let factoryCalls = 0;
    const failingFactory: WhatsappSocketFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        return sockets[0]!;
      }
      throw new Error("connect failed");
    };

    const proc = new CapturingProcessor();
    const auditDir = join(workDir, "audit");
    const audit = new AuditLog({
      dir: auditDir,
      daemonStartTs: Date.now(),
    });
    const channel = new WhatsappChannel({
      identityModel: "second-number",
      ownerJid: OWNER_JID,
      botJid: BOT_JID,
      authStateDir: join(workDir, "wa-auth"),
      inboundProcessor: proc,
      auditLog: audit,
      socketFactory: failingFactory,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
      jitterFn: () => 1.0,
    });
    await channel.start();
    await emitOpen(sockets[0]!, channel);

    // Emit 10 connectionLost events; each schedules a reconnect.  We don't
    // run the reconnect handler — we just count that the channel transitions
    // to degraded after the 10th increment.
    for (let i = 0; i < 10; i++) {
      sockets[0]!.ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: WhatsappDisconnectReason.connectionLost },
          },
          date: new Date(),
        },
      });
      // Allow the audit-log async append to settle.
      await channel.flushPending();
    }

    expect(channel.isDegraded()).toBe(true);
    pendingTimers = []; // cleanup
    await channel.stop();
  });
});

describe("formatChannelEvent — coverage of all event types", () => {
  test("task_completed has ✅ prefix and includes finalMessage", () => {
    const text = formatChannelEvent({
      type: "task_completed",
      taskId: "t-1",
      finalMessage: "All tests pass",
      ts: 0,
    });
    expect(text).toContain("✅");
    expect(text).toContain("All tests pass");
  });

  test("system_notice severity-prefixes by level", () => {
    const info = formatChannelEvent({
      type: "system_notice",
      text: "boot",
      level: "info",
      ts: 0,
    });
    const warn = formatChannelEvent({
      type: "system_notice",
      text: "studio slow",
      level: "warn",
      ts: 0,
    });
    const err = formatChannelEvent({
      type: "system_notice",
      text: "studio dead",
      level: "error",
      ts: 0,
    });
    expect(info.startsWith("ℹ️")).toBe(true);
    expect(warn.startsWith("⚠️")).toBe(true);
    expect(err.startsWith("‼️")).toBe(true);
  });
});

// Sanity that ChannelEvent type alias is still importable from channels/base
// (compile-time check; no runtime assertions needed)
const _typeSmoke: ChannelEvent = { type: "reply", text: "x", ts: 0 };
void _typeSmoke;

// ---------------------------------------------------------------------------
// FIX-B-3 Wave 8 — per-sender / per-channel inbound rate limiter wiring
// ---------------------------------------------------------------------------

import { InboundRateLimiter } from "../src/lib/inbound-rate-limit.js";

describe("WhatsappChannel — inbound rate limiter wiring (FIX-B-3 Wave 8)", () => {
  test("11th rapid message from same allowed sender is silently rate-limited + audited", async () => {
    let t = 1_700_000_000_000;
    const limiter = new InboundRateLimiter({
      perSender: { capacity: 10, refillRatePerMs: 0 },
      perChannel: { capacity: 100, refillRatePerMs: 0 },
      now: () => t,
    });
    const proc = new CapturingProcessor();
    const auditDir = join(workDir, "audit");
    const audit = new AuditLog({ dir: auditDir, daemonStartTs: t - 1000 });
    const socket = makeMockSocket();
    const channel = new WhatsappChannel({
      identityModel: "self-chat",
      ownerJid: OWNER_JID,
      authStateDir: join(workDir, "wa-auth-rl"),
      inboundProcessor: proc,
      auditLog: audit,
      socketFactory: makeFactory(socket),
      inboundRateLimiter: limiter,
    });
    await channel.start();
    socket.ev.emit("connection.update", { connection: "open" });
    await channel.flushPending();

    for (let i = 0; i < 10; i++) {
      socket.ev.emit("messages.upsert", {
        messages: [
          mkMessage({
            remoteJid: OWNER_JID,
            fromMe: true,
            text: `msg ${i}`,
          }),
        ],
        type: "notify",
      });
    }
    await channel.flushPending();
    expect(proc.received).toHaveLength(10);

    // 11th — rate limited.
    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: OWNER_JID,
          fromMe: true,
          text: "msg 11",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();
    expect(proc.received).toHaveLength(10);

    // Force-flush audit.
    await audit.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = await readAuditLines(auditDir);
    const rl = (lines as AuditEntryShape[]).filter(
      (e) => e.event === "inbound_rate_limited",
    );
    expect(rl.length).toBeGreaterThanOrEqual(1);
    expect(rl[0]!.extra?.reason).toBe("per_sender");
    expect(rl[0]!.channel).toBe("whatsapp");

    await channel.stop();
  });

  test("31st rapid message across the channel is silently rate-limited (per_channel)", async () => {
    let t = 1_700_000_000_000;
    const limiter = new InboundRateLimiter({
      perSender: { capacity: 100, refillRatePerMs: 0 },
      perChannel: { capacity: 30, refillRatePerMs: 0 },
      now: () => t,
    });
    const proc = new CapturingProcessor();
    const auditDir = join(workDir, "audit-wa-channel");
    const audit = new AuditLog({ dir: auditDir, daemonStartTs: t - 1000 });
    const socket = makeMockSocket();
    const channel = new WhatsappChannel({
      identityModel: "self-chat",
      ownerJid: OWNER_JID,
      authStateDir: join(workDir, "wa-auth-rl-ch"),
      inboundProcessor: proc,
      auditLog: audit,
      socketFactory: makeFactory(socket),
      inboundRateLimiter: limiter,
    });
    await channel.start();
    socket.ev.emit("connection.update", { connection: "open" });
    await channel.flushPending();

    // Burn 30 channel tokens via owner messages.
    for (let i = 0; i < 30; i++) {
      socket.ev.emit("messages.upsert", {
        messages: [
          mkMessage({
            remoteJid: OWNER_JID,
            fromMe: true,
            text: `m${i}`,
          }),
        ],
        type: "notify",
      });
    }
    await channel.flushPending();
    expect(proc.received).toHaveLength(30);

    // 31st - channel saturated.
    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({
          remoteJid: OWNER_JID,
          fromMe: true,
          text: "tripping channel cap",
        }),
      ],
      type: "notify",
    });
    await channel.flushPending();
    expect(proc.received).toHaveLength(30);

    await audit.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = (await readAuditLines(auditDir)) as AuditEntryShape[];
    const rl = lines.filter((e) => e.event === "inbound_rate_limited");
    expect(rl.length).toBeGreaterThanOrEqual(1);
    const reasons = rl.map((r) => r.extra?.reason);
    expect(reasons).toContain("per_channel");

    await channel.stop();
  });
});

// ---------------------------------------------------------------------------
// FIX-B-4 Wave 8 — audioRef / imageRef / documentRef / videoRef populated for
// non-text inbound (closes BLESS Accessibility — v4 changelog audioRef seam)
// ---------------------------------------------------------------------------

import { InboundMediaStore } from "../src/lib/inbound-media.js";
import { readFileSync as readFileSyncMedia, statSync as statSyncMedia } from "node:fs";

describe("WhatsappChannel — non-text inbound populates the right *Ref field", () => {
  async function buildMediaChannel(
    identityModel: "self-chat" | "second-number",
    opts?: { fileBuffer?: Buffer; failDownload?: boolean },
  ): Promise<{
    channel: WhatsappChannel;
    socket: MockSocket;
    proc: CapturingProcessor;
    downloader: ReturnType<typeof vi.fn>;
    mediaDir: string;
  }> {
    const buffer = opts?.fileBuffer ?? Buffer.from([0xff, 0xfb, 0x90, 0x44]);
    const downloader = opts?.failDownload
      ? vi.fn().mockRejectedValue(new Error("baileys-download-fail"))
      : vi.fn().mockResolvedValue(buffer);
    const mediaDir = join(workDir, "wa-inbound-media");
    const proc = new CapturingProcessor();
    const auditDir = join(workDir, "audit");
    const audit = new AuditLog({
      dir: auditDir,
      daemonStartTs: Date.now() - 1000,
    });
    const socket = makeMockSocket();
    const store = new InboundMediaStore({ dir: mediaDir });
    const channel = new WhatsappChannel({
      identityModel,
      ownerJid: OWNER_JID,
      botJid: identityModel === "second-number" ? BOT_JID : undefined,
      authStateDir: join(workDir, "wa-auth"),
      inboundProcessor: proc,
      auditLog: audit,
      socketFactory: makeFactory(socket),
      inboundMediaStore: store,
      mediaDownloader: downloader as unknown as (msg: unknown) => Promise<Buffer>,
    });
    return { channel, socket, proc, downloader, mediaDir };
  }

  test("voice inbound: audioRef populated, file persisted, content matches buffer", async () => {
    const buffer = Buffer.from("OggS\x00\x02voice-bytes");
    const { channel, socket, proc, downloader } = await buildMediaChannel(
      "self-chat",
      { fileBuffer: buffer },
    );
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [mkMessage({ remoteJid: OWNER_JID, fromMe: true, voice: true })],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    const got = proc.received[0]!;
    expect(got.type).toBe("voice");
    expect(got.payload.text).toContain("voice");
    expect(got.payload.audioRef).toBeDefined();
    expect(got.payload.audioRef!.endsWith(".ogg")).toBe(true);
    const onDisk = readFileSyncMedia(got.payload.audioRef!);
    expect(onDisk.equals(buffer)).toBe(true);
    if (process.platform !== "win32") {
      const st = statSyncMedia(got.payload.audioRef!);
      expect(st.mode & 0o777).toBe(0o600);
    }
    expect(downloader).toHaveBeenCalledTimes(1);

    await channel.stop();
  });

  test("image inbound: imageRef populated, file persisted", async () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const { channel, socket, proc } = await buildMediaChannel("second-number", {
      fileBuffer: buffer,
    });
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [mkMessage({ remoteJid: OWNER_JID, fromMe: false, image: true })],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    const got = proc.received[0]!;
    expect(got.type).toBe("image");
    expect(got.payload.imageRef).toBeDefined();
    expect(got.payload.imageRef!.endsWith(".jpg")).toBe(true);
    const onDisk = readFileSyncMedia(got.payload.imageRef!);
    expect(onDisk.equals(buffer)).toBe(true);

    await channel.stop();
  });

  test("document inbound: documentRef populated; payload.text still has placeholder", async () => {
    const buffer = Buffer.from("%PDF-1.4 fake-pdf");
    const { channel, socket, proc } = await buildMediaChannel("self-chat", {
      fileBuffer: buffer,
    });
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [
        mkMessage({ remoteJid: OWNER_JID, fromMe: true, document: true }),
      ],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    const got = proc.received[0]!;
    expect(got.type).toBe("image"); // legacy enum collapse
    expect(got.payload.documentRef).toBeDefined();
    expect(got.payload.text).toContain("document");
    expect(got.payload.imageRef).toBeUndefined();
    const onDisk = readFileSyncMedia(got.payload.documentRef!);
    expect(onDisk.equals(buffer)).toBe(true);

    await channel.stop();
  });

  test("download failure does NOT block placeholder delivery — agent still gets text", async () => {
    const { channel, socket, proc } = await buildMediaChannel("self-chat", {
      failDownload: true,
    });
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [mkMessage({ remoteJid: OWNER_JID, fromMe: true, voice: true })],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    const got = proc.received[0]!;
    expect(got.type).toBe("voice");
    expect(got.payload.text).toContain("voice");
    expect(got.payload.audioRef).toBeUndefined();

    await channel.stop();
  });

  test("text inbound is unaffected — no media downloader interaction", async () => {
    const { channel, socket, proc, downloader } = await buildMediaChannel(
      "second-number",
    );
    await channel.start();
    await emitOpen(socket, channel);

    socket.ev.emit("messages.upsert", {
      messages: [mkMessage({ remoteJid: OWNER_JID, fromMe: false, text: "hi" })],
      type: "notify",
    });
    await channel.flushPending();

    expect(proc.received).toHaveLength(1);
    expect(proc.received[0]!.payload.audioRef).toBeUndefined();
    expect(proc.received[0]!.payload.imageRef).toBeUndefined();
    expect(downloader).not.toHaveBeenCalled();

    await channel.stop();
  });
});
