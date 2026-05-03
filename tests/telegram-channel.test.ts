/**
 * TelegramChannel — grammy-adapter tests.
 *
 * Strategy: construct a real grammy `Bot` (the constructor doesn't network),
 * pre-populate `bot.botInfo` so `bot.init()` is a no-op, and stub
 * `bot.api.{getMe,sendMessage,sendChatAction}` with vi.fn().  We then drive
 * inbound messages by feeding synthetic `Update` objects through
 * `bot.handleUpdate(...)` — that's grammy's official seam for tests +
 * webhook adapters.
 *
 * Coverage (per IMPL-12 spec — at least 12 cases):
 *   1. DM-only enforcement: group chat → silent + audit
 *   2. Allowlist enforcement: non-allowed sender → silent + audit
 *   3. Allowed sender DM text → InboundMessage built + processInbound called
 *   4. Voice inbound → synthesized text + processInbound called
 *   5. Image inbound → synthesized text + processInbound called
 *   6. Document inbound → synthesized text + processInbound called
 *   7. send(reply) → bot.api.sendMessage called with no prefix
 *   8. send(tell) → 📱 prefix
 *   9. send(confirm_request) → includes shortId + reply hint
 *  10. Long reply (10K chars) → multiple chunks
 *  11. bot.catch handles GrammyError without crashing
 *  12. markTaskStart triggers typing indicator periodically (fake timers)
 *  13. markTaskEnd stops typing
 *  14. send() before any inbound is a no-op (no chat to address)
 *  15. start() with bad token throws TelegramAuthError
 *  16. formatChannelEvent — task_completed + system_notice prefixes
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";

import {
  TelegramAuthError,
  TelegramChannel,
  formatChannelEvent,
} from "../src/channels/telegram.js";
import type {
  ChannelEvent,
  InboundMessage,
  InboundProcessor,
} from "../src/channels/base.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_BOT_INFO: UserFromGetMe = {
  id: 999_111,
  is_bot: true,
  first_name: "pi-comms-test",
  username: "pi_comms_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

function makeBotFactory(): (token: string) => Bot {
  return (token: string) => {
    const bot = new Bot(token);
    // Pre-set botInfo so handleUpdate() doesn't try to call api.getMe()
    // when the middleware fires. (grammy only auto-initializes on
    // bot.start(); handleUpdate accepts pre-initialized bots.)
    bot.botInfo = FAKE_BOT_INFO;
    // Stub the three api methods we interact with.  Default to resolved.
    bot.api.getMe = vi.fn().mockResolvedValue(FAKE_BOT_INFO);
    bot.api.sendMessage = vi.fn().mockResolvedValue({} as never);
    bot.api.sendChatAction = vi.fn().mockResolvedValue(true);
    return bot;
  };
}

class CapturingProcessor implements InboundProcessor {
  received: InboundMessage[] = [];
  shouldThrow = false;
  async processInbound(msg: InboundMessage): Promise<void> {
    if (this.shouldThrow) throw new Error("processor down");
    this.received.push(msg);
  }
}

// Build a synthetic message Update.  We only set the fields the channel
// touches (chat, from, message_id, date, text/voice/photo/document, etc.).
let updateCounter = 1;
function mkUpdate(opts: {
  chatType?: "private" | "group" | "supergroup" | "channel";
  fromId?: number;
  fromUsername?: string;
  fromFirstName?: string;
  text?: string;
  voice?: boolean;
  photo?: boolean;
  document?: boolean;
}): Update {
  const fromId = opts.fromId ?? 12345;
  const chatType = opts.chatType ?? "private";
  const baseMessage = {
    message_id: updateCounter++,
    date: Math.floor(Date.now() / 1000),
    from: {
      id: fromId,
      is_bot: false,
      first_name: opts.fromFirstName ?? "Sergio",
      username: opts.fromUsername ?? "sergio",
    },
    chat: {
      id: fromId, // for private chats id == user id
      type: chatType,
      first_name: opts.fromFirstName ?? "Sergio",
    },
  };

  let message: Record<string, unknown>;
  if (opts.voice) {
    message = {
      ...baseMessage,
      voice: { duration: 1, file_id: "voice-1", file_unique_id: "vu1" },
    };
  } else if (opts.photo) {
    message = {
      ...baseMessage,
      photo: [{ file_id: "ph-1", file_unique_id: "pu1", width: 100, height: 100 }],
    };
  } else if (opts.document) {
    message = {
      ...baseMessage,
      document: { file_id: "doc-1", file_unique_id: "du1" },
    };
  } else {
    message = { ...baseMessage, text: opts.text ?? "hello" };
  }

  return {
    update_id: updateCounter++,
    message: message as never,
  };
}

const ALLOWED = new Set(["12345"]);

function newChannel(opts?: {
  processor?: InboundProcessor;
  allowed?: ReadonlySet<string>;
  chunkSize?: number;
  typingIntervalMs?: number;
}): {
  channel: TelegramChannel;
  proc: InboundProcessor;
  bot: Bot;
} {
  const proc = opts?.processor ?? new CapturingProcessor();
  let capturedBot: Bot | undefined;
  const factory = makeBotFactory();
  const channel = new TelegramChannel({
    botToken: "fake-token",
    allowedUserIds: opts?.allowed ?? ALLOWED,
    inboundProcessor: proc,
    chunkSize: opts?.chunkSize,
    typingIntervalMs: opts?.typingIntervalMs,
    botFactory: (t) => {
      const b = factory(t);
      capturedBot = b;
      return b;
    },
  });
  if (!capturedBot) throw new Error("bot factory not invoked");
  return { channel, proc, bot: capturedBot };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TelegramChannel — inbound", () => {
  test("group chat: silently rejected, processor never called", async () => {
    const { channel, proc, bot } = newChannel();
    void channel; // referenced via bot.handleUpdate
    await bot.handleUpdate(
      mkUpdate({ chatType: "group", text: "hi from group" }),
    );
    expect((proc as CapturingProcessor).received).toHaveLength(0);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  test("non-allowlisted sender in private DM: silently rejected", async () => {
    const { channel, proc, bot } = newChannel({ allowed: new Set(["99999"]) });
    void channel;
    await bot.handleUpdate(
      mkUpdate({ chatType: "private", fromId: 12345, text: "hi" }),
    );
    expect((proc as CapturingProcessor).received).toHaveLength(0);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  test("allowed sender in private DM with text: builds InboundMessage{text} and calls processInbound", async () => {
    const { channel, proc, bot } = newChannel();
    void channel;
    await bot.handleUpdate(
      mkUpdate({ fromId: 12345, fromUsername: "sergio", text: "deploy now" }),
    );
    const got = (proc as CapturingProcessor).received;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      type: "text",
      channel: "telegram",
      sender: { id: "12345", name: "sergio" },
      payload: { text: "deploy now" },
    });
    expect(typeof got[0]!.ts).toBe("number");
  });

  test("voice inbound: synthesizes textual placeholder", async () => {
    const { channel, proc, bot } = newChannel();
    void channel;
    await bot.handleUpdate(mkUpdate({ voice: true }));
    const got = (proc as CapturingProcessor).received;
    expect(got).toHaveLength(1);
    expect(got[0]!.payload.text).toBe(
      "[user sent a voice — non-text inbound is deferred; please type]",
    );
    expect(got[0]!.type).toBe("voice");
  });

  test("image inbound: synthesizes textual placeholder", async () => {
    const { channel, proc, bot } = newChannel();
    void channel;
    await bot.handleUpdate(mkUpdate({ photo: true }));
    const got = (proc as CapturingProcessor).received;
    expect(got).toHaveLength(1);
    expect(got[0]!.payload.text).toBe(
      "[user sent an image — non-text inbound is deferred; please type]",
    );
    expect(got[0]!.type).toBe("image");
  });

  test("document inbound: synthesizes textual placeholder", async () => {
    const { channel, proc, bot } = newChannel();
    void channel;
    await bot.handleUpdate(mkUpdate({ document: true }));
    const got = (proc as CapturingProcessor).received;
    expect(got).toHaveLength(1);
    expect(got[0]!.payload.text).toBe(
      "[user sent a document — non-text inbound is deferred; please type]",
    );
    // documents collapse to "image" in the v1 inbound enum (only text/voice/image)
    expect(got[0]!.type).toBe("image");
  });
});

describe("TelegramChannel — outbound", () => {
  test("send(reply) after inbound: bot.api.sendMessage called with text and no prefix", async () => {
    const { channel, bot } = newChannel();
    // First an inbound to set activeChatId.
    await bot.handleUpdate(mkUpdate({ fromId: 12345, text: "hi" }));
    await channel.send({ type: "reply", text: "the answer", ts: 0 });
    expect(bot.api.sendMessage).toHaveBeenCalledWith(12345, "the answer");
  });

  test("send(tell) uses 📱 prefix", async () => {
    const { channel, bot } = newChannel();
    await bot.handleUpdate(mkUpdate({ fromId: 12345, text: "go" }));
    await channel.send({
      type: "tell",
      urgency: "milestone",
      text: "phase 1 done",
      ts: 0,
    });
    expect(bot.api.sendMessage).toHaveBeenCalledWith(12345, "📱 phase 1 done");
  });

  test("send(confirm_request) includes shortId + /confirm reply hint", async () => {
    const { channel, bot } = newChannel();
    await bot.handleUpdate(mkUpdate({ fromId: 12345, text: "go" }));
    await channel.send({
      type: "confirm_request",
      shortId: "AB7K",
      question: "rm -rf node_modules?",
      rationale: "clean reinstall",
      risk: "destructive",
      expiresAt: 1_700_000_900_000,
      ts: 1_700_000_000_000,
    });
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = (bot.api.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(callArgs[0]).toBe(12345);
    const text = callArgs[1] as string;
    expect(text).toContain("AB7K");
    expect(text).toContain("rm -rf node_modules?");
    expect(text).toContain("/confirm AB7K yes");
    expect(text).toContain("/confirm AB7K no");
  });

  test("long reply (10K chars) is sent as multiple chunks", async () => {
    const { channel, bot } = newChannel({ chunkSize: 1000 });
    await bot.handleUpdate(mkUpdate({ fromId: 12345, text: "go" }));
    const huge = "x".repeat(10_000);
    await channel.send({ type: "reply", text: huge, ts: 0 });
    // 10K / 1000 = 10 chunks.
    expect(
      (bot.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(10);
  });

  test("send() before any inbound is a no-op (no chat to address)", async () => {
    const { channel, bot } = newChannel();
    await channel.send({ type: "reply", text: "nobody home", ts: 0 });
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("TelegramChannel — error handling", () => {
  test("bot.catch: GrammyError thrown by middleware does not crash, channel survives", async () => {
    const proc = new CapturingProcessor();
    proc.shouldThrow = false;
    const { channel, bot } = newChannel({ processor: proc });
    void channel;

    // Force a synthetic GrammyError by rigging api.sendMessage to throw it
    // and routing through a hand-rolled handler.  Easier path: install an
    // additional middleware that throws GrammyError, then ensure handleUpdate
    // resolves and bot.catch swallows it.
    bot.use(async () => {
      throw new GrammyError(
        "test grammy",
        { ok: false, error_code: 400, description: "bad request" },
        "sendMessage" as never,
        {} as never,
      );
    });

    // Expect no rejection from handleUpdate (bot.catch swallows it).
    await expect(
      bot.handleUpdate(mkUpdate({ fromId: 12345, text: "hi" })),
    ).resolves.toBeUndefined();
  });

  test("bot.catch: HttpError handled the same way", async () => {
    const { channel, bot } = newChannel();
    void channel;
    bot.use(async () => {
      throw new HttpError("net down", new Error("ECONNRESET"));
    });
    await expect(
      bot.handleUpdate(mkUpdate({ fromId: 12345, text: "hi" })),
    ).resolves.toBeUndefined();
  });
});

describe("TelegramChannel — typing indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("markTaskStart fires sendChatAction on first call AND every typingIntervalMs", async () => {
    const { channel, bot } = newChannel({ typingIntervalMs: 4000 });
    channel.markTaskStart(12345);
    // First call is synchronous (we do an immediate sendChatAction in
    // markTaskStart).
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);
    expect(bot.api.sendChatAction).toHaveBeenCalledWith(12345, "typing");

    // Advance time by 3 intervals.
    vi.advanceTimersByTime(4000 * 3);
    // 1 immediate + 3 timer-fired = 4 total.
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(4);

    channel.markTaskEnd();
  });

  test("markTaskEnd stops typing — no more sendChatAction after that", async () => {
    const { channel, bot } = newChannel({ typingIntervalMs: 4000 });
    channel.markTaskStart(12345);
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);

    channel.markTaskEnd();
    vi.advanceTimersByTime(4000 * 5);

    // Still just the initial call.
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);
  });

  test("markTaskStart called twice without markTaskEnd: does not leak the previous timer", async () => {
    const { channel, bot } = newChannel({ typingIntervalMs: 4000 });
    channel.markTaskStart(12345);
    channel.markTaskStart(12345); // implicit cancel of the first
    vi.advanceTimersByTime(4000);
    // 2 immediate + 1 interval-fire = 3 (only one active timer).
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(3);
    channel.markTaskEnd();
  });
});

describe("TelegramChannel — start lifecycle", () => {
  test("start() with bad token throws TelegramAuthError", async () => {
    const proc = new CapturingProcessor();
    const channel = new TelegramChannel({
      botToken: "bad-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      botFactory: (t) => {
        const bot = new Bot(t);
        bot.botInfo = FAKE_BOT_INFO;
        bot.api.getMe = vi
          .fn()
          .mockRejectedValue(new Error("401 Unauthorized"));
        bot.api.sendMessage = vi.fn();
        bot.api.sendChatAction = vi.fn();
        return bot;
      },
    });
    await expect(channel.start()).rejects.toBeInstanceOf(TelegramAuthError);
    expect(channel.isConnected()).toBe(false);
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

  test("auto_promote_notice + go_background_notice carry pi: prefix", () => {
    const promote = formatChannelEvent({
      type: "auto_promote_notice",
      firingNumber: 1,
      taskAgeSeconds: 30,
      ts: 0,
    });
    const bg = formatChannelEvent({
      type: "go_background_notice",
      userMessagePreview: "implement caching",
      ts: 0,
    });
    expect(promote).toMatch(/^pi: still on it/);
    expect(promote).toContain("30s");
    expect(bg).toMatch(/^pi: this is bigger/);
    expect(bg).toContain("implement caching");
  });
});

// Sanity that ChannelEvent type alias is still importable from channels/base
// (compile-time check; no runtime assertions needed)
const _typeSmoke: ChannelEvent = { type: "reply", text: "x", ts: 0 };
void _typeSmoke;
